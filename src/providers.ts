import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { codexBin, openCodeBin, openCodeSourceDataDir } from "./config";
import { runCli } from "./cli";
import {
  ProviderOutputTooLarge,
  type ProviderOutput,
  type TokenUsage,
} from "./types";

export async function runOpenCode(
  input: { requestId: string; model: string; effort: string },
  workDir: string,
  imagePath: string,
  prompt: string,
  timeoutMs: number,
): Promise<ProviderOutput> {
  const agentPrompt = path.join(workDir, "vision-agent.txt");
  const configPath = path.join(workDir, "opencode.json");
  const opencodeXdgDataHome = path.join(workDir, "xdg-data");
  const opencodeDataDir = path.join(opencodeXdgDataHome, "opencode");
  await mkdir(opencodeDataDir, { recursive: true, mode: 0o700 });
  const storedAuth = await readFile(
    path.join(openCodeSourceDataDir(), "auth.json"),
  ).catch(() => null);
  if (storedAuth)
    await writeFile(path.join(opencodeDataDir, "auth.json"), storedAuth, {
      mode: 0o600,
    });

  await writeFile(
    agentPrompt,
    "You are a vision extraction assistant. Analyze only the attached image and caller instruction. Return one JSON object. Never use tools.",
    { mode: 0o600 },
  );
  await writeFile(
    configPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      default_agent: "vision-api",
      permission: { "*": "deny" },
      agent: {
        "vision-api": {
          description: "Extract structured information from the attached image",
          mode: "primary",
          prompt: "{file:./vision-agent.txt}",
          permission: { "*": "deny" },
        },
      },
    }),
    { mode: 0o600 },
  );

  const args = [
    "run",
    "--pure",
    "--format",
    "json",
    "--agent",
    "vision-api",
    "--file",
    imagePath,
    "--dir",
    workDir,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--variant", input.effort);
  args.push(prompt);

  const output = await runCli(openCodeBin, args, workDir, timeoutMs, {
    XDG_DATA_HOME: opencodeXdgDataHome,
  });
  const textParts: string[] = [];
  const tokenUsage: TokenUsage = {};
  for (const line of output.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string")
        textParts.push(event.part.text);
      if (event.type === "step_finish" && event.part?.tokens) {
        incrementUsage(tokenUsage, "input_tokens", event.part.tokens.input);
        incrementUsage(
          tokenUsage,
          "cached_input_tokens",
          event.part.tokens.cache?.read,
        );
        incrementUsage(
          tokenUsage,
          "cache_write_input_tokens",
          event.part.tokens.cache?.write,
        );
        incrementUsage(tokenUsage, "output_tokens", event.part.tokens.output);
        incrementUsage(
          tokenUsage,
          "reasoning_output_tokens",
          event.part.tokens.reasoning,
        );
        incrementUsage(tokenUsage, "total_tokens", event.part.tokens.total);
      }
      if (event.type === "error")
        throw new Error("OpenCode returned an error event");
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  const response = textParts.join("").trim();
  if (!response)
    throw new Error(`OpenCode returned no text for request ${input.requestId}`);
  return { text: response, tokenUsage: finalizeTokenUsage(tokenUsage) };
}

export async function runCodex(
  input: { requestId: string; model: string; effort: string },
  workDir: string,
  imagePath: string,
  prompt: string,
  timeoutMs: number,
): Promise<ProviderOutput> {
  const schemaPath = path.join(workDir, "output-schema.json");
  const outputPath = path.join(workDir, "model-output.json");
  await writeFile(
    schemaPath,
    JSON.stringify({ type: "object", additionalProperties: true }),
    { mode: 0o600 },
  );

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    workDir,
    "--image",
    imagePath,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--json",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort)
    args.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    );
  args.push(prompt);

  const cliOutput = await runCli(codexBin, args, workDir, timeoutMs);
  const outputStat = await stat(outputPath).catch(() => null);
  if (outputStat && outputStat.size > 1_000_000)
    throw new ProviderOutputTooLarge();
  const output = await readFile(outputPath, "utf8").catch(() => "");
  const response = output.trim();
  if (!response)
    throw new Error(`Codex returned no text for request ${input.requestId}`);
  return { text: response, tokenUsage: parseCodexUsage(cliOutput.stdout) };
}

function incrementUsage(
  usage: TokenUsage,
  key: keyof TokenUsage,
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  usage[key] = (usage[key] ?? 0) + value;
}

function finalizeTokenUsage(usage: TokenUsage): TokenUsage | null {
  if (Object.keys(usage).length === 0) return null;
  if (
    usage.total_tokens === undefined &&
    usage.input_tokens !== undefined &&
    usage.output_tokens !== undefined
  ) {
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  return usage;
}

function parseCodexUsage(output: string): TokenUsage | null {
  let latestUsage: TokenUsage | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        event.type !== "turn.completed" ||
        !event.usage ||
        typeof event.usage !== "object"
      )
        continue;
      const source = event.usage as Record<string, unknown>;
      const usage: TokenUsage = {};
      for (const key of [
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
      ] as const) {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          usage[key] = value;
      }
      latestUsage = finalizeTokenUsage(usage);
    } catch {
      // Ignore non-JSON CLI output and keep the most recent completed turn's usage.
    }
  }
  return latestUsage;
}
