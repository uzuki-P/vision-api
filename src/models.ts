import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allowedModels,
  codexBin,
  openCodeBin,
  openCodeSourceDataDir,
  requestTimeoutMs,
} from "./config";
import { runCli } from "./cli";
import type { ModelChoice, Provider } from "./types";

const modelListCache = new Map<
  Provider,
  { expiresAt: number; models: ModelChoice[] }
>();
const modelListCacheMs = 5 * 60_000;
const modelListTimeoutMs = 30_000;

export async function listModels(provider: Provider): Promise<ModelChoice[]> {
  const cached = modelListCache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const discovered =
    provider === "opencode"
      ? await listOpenCodeModels()
      : await listCodexModels();
  const models =
    allowedModels.size > 0
      ? discovered.filter((model) => allowedModels.has(model.id))
      : discovered;
  modelListCache.set(provider, {
    expiresAt: Date.now() + modelListCacheMs,
    models,
  });
  return models;
}

async function listOpenCodeModels(): Promise<ModelChoice[]> {
  const credentialsPath = path.join(openCodeSourceDataDir(), "auth.json");
  const credentials = await readFile(credentialsPath);
  const parsed: unknown = JSON.parse(credentials.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCode credentials are not a provider map");
  }

  const providerIds = Object.keys(parsed).filter((id) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id),
  );
  if (providerIds.length === 0) return [];

  const workDir = await mkdtemp(path.join(tmpdir(), "vision-api-models-"));
  try {
    const xdgDataHome = path.join(workDir, "xdg-data");
    const xdgConfigHome = path.join(workDir, "xdg-config");
    const opencodeDataDir = path.join(xdgDataHome, "opencode");
    await mkdir(opencodeDataDir, { recursive: true, mode: 0o700 });
    await mkdir(xdgConfigHome, { recursive: true, mode: 0o700 });
    await writeFile(path.join(opencodeDataDir, "auth.json"), credentials, {
      mode: 0o600,
    });

    const outputs = await Promise.all(
      providerIds.map((providerId) =>
        runCli(
          openCodeBin,
          ["models", providerId, "--verbose", "--pure"],
          workDir,
          Math.min(requestTimeoutMs, modelListTimeoutMs),
          { XDG_DATA_HOME: xdgDataHome, XDG_CONFIG_HOME: xdgConfigHome },
        ),
      ),
    );

    const choices = outputs.flatMap(({ stdout }) =>
      extractJsonObjects(stdout).flatMap((model): ModelChoice[] => {
        const providerId = model.providerID;
        const modelId = model.id;
        const imageSupported = model.capabilities?.input?.image === true;
        if (
          typeof providerId !== "string" ||
          typeof modelId !== "string" ||
          !imageSupported
        )
          return [];

        const id = `${providerId}/${modelId}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) return [];
        const variants =
          model.variants && typeof model.variants === "object"
            ? Object.keys(model.variants)
            : [];
        return [
          {
            id,
            label: typeof model.name === "string" ? model.name : modelId,
            group:
              providerId === "zai-coding-plan"
                ? "Z.AI Coding Plan (GLM)"
                : providerId,
            reasoning_efforts: variants.filter((effort) =>
              /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(effort),
            ),
          },
        ];
      }),
    );

    return [...new Map(choices.map((model) => [model.id, model])).values()];
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function listCodexModels(): Promise<ModelChoice[]> {
  const workDir = await mkdtemp(path.join(tmpdir(), "vision-api-models-"));
  try {
    const { stdout } = await runCli(
      codexBin,
      ["debug", "models", "--bundled"],
      workDir,
      Math.min(requestTimeoutMs, modelListTimeoutMs),
    );
    const catalog = JSON.parse(stdout) as {
      models?: Array<Record<string, unknown>>;
    };
    return (catalog.models ?? []).flatMap((model): ModelChoice[] => {
      const id = model.slug;
      if (
        typeof id !== "string" ||
        model.visibility !== "list" ||
        model.supported_in_api !== true
      )
        return [];
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) return [];
      const levels = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
        : [];
      const efforts = levels.flatMap((level) => {
        if (!level || typeof level !== "object") return [];
        const effort = (level as Record<string, unknown>).effort;
        return typeof effort === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(effort)
          ? [effort]
          : [];
      });
      return [
        {
          id,
          label:
            typeof model.display_name === "string" ? model.display_name : id,
          group: "Codex",
          reasoning_efforts: efforts,
        },
      ];
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function extractJsonObjects(output: string): Array<Record<string, any>> {
  const objects: Array<Record<string, any>> = [];
  let searchFrom = 0;
  while (searchFrom < output.length) {
    const start = output.indexOf("{", searchFrom);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = start;
    for (; end < output.length; end += 1) {
      const char = output[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    if (depth !== 0) break;
    try {
      const value: unknown = JSON.parse(output.slice(start, end));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        objects.push(value as Record<string, any>);
      }
    } catch {
      // Skip non-JSON brace groups in CLI diagnostics.
    }
    searchFrom = end;
  }
  return objects;
}
