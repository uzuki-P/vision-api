import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeBin, codexBin, openCodeBin } from "./config";
import { runCli } from "./cli";
import {
  isUsableModel,
  withOpenCodeServer,
  type OpenCodeTokens,
} from "./opencode";
import {
  HttpError,
  ProviderOutputTooLarge,
  type ImageInput,
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
  const deadline = Date.now() + timeoutMs;
  return withOpenCodeServer(workDir, timeoutMs, async (server) => {
    const models = (await server.models()).filter((model) =>
      isUsableModel(model, server.providers),
    );
    const fallback = await server.defaultModel();
    const selected = input.model
      ? models.find(
          (model) => `${model.providerID}/${model.id}` === input.model,
        )
      : (models.find(
          (model) =>
            model.providerID === fallback?.providerID &&
            model.id === fallback?.id,
        ) ?? models[0]);
    if (!selected)
      throw new HttpError(
        400,
        "model_unavailable",
        input.model
          ? `OpenCode cannot use model ${input.model} with the stored credentials`
          : "OpenCode has no image model from a logged-in provider",
      );
    // OpenCode v2 takes the effort as a variant suffix on the model reference.
    if (
      input.effort &&
      !selected.variants?.some((variant) => variant.id === input.effort)
    )
      throw new HttpError(
        400,
        "invalid_reasoning_effort",
        `${selected.providerID}/${selected.id} does not support reasoning_effort ${input.effort}`,
      );
    const model = `${selected.providerID}/${selected.id}`;
    const args = [
      "run",
      "--server",
      server.url,
      "--format",
      "json",
      "--agent",
      "vision-api",
      "--file",
      imagePath,
      "--model",
      input.effort ? `${model}#${input.effort}` : model,
      prompt,
    ];

    const output = await runCli(
      openCodeBin,
      args,
      workDir,
      Math.max(1, deadline - Date.now()),
      server.env,
    );
    const textParts: string[] = [];
    let sessionID = "";
    for (const line of output.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.sessionID === "string" && event.sessionID)
          sessionID = event.sessionID;
        if (event.type === "text" && typeof event.part?.text === "string")
          textParts.push(event.part.text);
        if (event.type === "error")
          throw new Error("OpenCode returned an error event");
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    const response = textParts.join("").trim();
    if (!response)
      throw new Error(
        `OpenCode returned no text for request ${input.requestId}`,
      );
    const tokens = sessionID
      ? await server.sessionTokens(sessionID).catch(() => null)
      : null;
    return { text: response, tokenUsage: parseOpenCodeUsage(tokens) };
  });
}

function parseOpenCodeUsage(tokens: OpenCodeTokens | null): TokenUsage | null {
  if (!tokens) return null;
  const usage: TokenUsage = {};
  incrementUsage(usage, "input_tokens", tokens.input);
  incrementUsage(usage, "cached_input_tokens", tokens.cache?.read);
  incrementUsage(usage, "cache_write_input_tokens", tokens.cache?.write);
  incrementUsage(usage, "output_tokens", tokens.output);
  incrementUsage(usage, "reasoning_output_tokens", tokens.reasoning);
  // OpenCode counts reasoning and cache tokens separately from input and
  // output, so the total adds all of them.
  for (const value of [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache?.read,
    tokens.cache?.write,
  ])
    incrementUsage(usage, "total_tokens", value);
  return finalizeTokenUsage(usage);
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

export async function runClaude(
  input: { requestId: string; model: string; effort: string },
  image: ImageInput,
  prompt: string,
  workDir: string,
  timeoutMs: number,
): Promise<ProviderOutput> {
  // Claude Code has no image flag, so the image goes in a stream-json user
  // message. This keeps every tool disabled instead of granting Read access.
  const message = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mime,
            data: Buffer.from(image.bytes).toString("base64"),
          },
        },
        { type: "text", text: prompt },
      ],
    },
  });

  const args = [
    "--print",
    "--safe-mode",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt",
    "You are a vision extraction assistant. Analyze only the attached image and caller instruction. Return one JSON object. Never use tools.",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);

  const output = await runCli(
    claudeBin,
    args,
    workDir,
    timeoutMs,
    {},
    `${message}\n`,
  );
  let result: Record<string, any> | null = null;
  for (const line of output.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "result") result = event;
    } catch {
      // Ignore non-JSON CLI output.
    }
  }
  if (!result || result.is_error || typeof result.result !== "string")
    throw new Error(`Claude returned no result for request ${input.requestId}`);
  const response = stripJsonFence(result.result.trim());
  if (!response)
    throw new Error(`Claude returned no text for request ${input.requestId}`);
  return { text: response, tokenUsage: parseClaudeUsage(result.usage) };
}

// Some Claude models wrap JSON in a markdown fence despite the instruction.
function stripJsonFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  return fenced ? fenced[1].trim() : text;
}

function parseClaudeUsage(source: unknown): TokenUsage | null {
  if (!source || typeof source !== "object") return null;
  const raw = source as Record<string, any>;
  const usage: TokenUsage = {};
  // Anthropic reports cache reads and writes separately from input_tokens.
  // Fold them in so input_tokens covers the whole prompt, as Codex reports it.
  incrementUsage(usage, "input_tokens", raw.input_tokens);
  incrementUsage(usage, "input_tokens", raw.cache_read_input_tokens);
  incrementUsage(usage, "input_tokens", raw.cache_creation_input_tokens);
  incrementUsage(usage, "cached_input_tokens", raw.cache_read_input_tokens);
  incrementUsage(
    usage,
    "cache_write_input_tokens",
    raw.cache_creation_input_tokens,
  );
  incrementUsage(usage, "output_tokens", raw.output_tokens);
  incrementUsage(
    usage,
    "reasoning_output_tokens",
    raw.output_tokens_details?.thinking_tokens,
  );
  return finalizeTokenUsage(usage);
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
