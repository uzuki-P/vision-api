import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowedModels, codexBin, requestTimeoutMs } from "./config";
import { runCli } from "./cli";
import { isUsableModel, withOpenCodeServer } from "./opencode";
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
      : provider === "claude"
        ? listClaudeModels()
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
  const workDir = await mkdtemp(path.join(tmpdir(), "vision-api-models-"));
  try {
    const timeoutMs = Math.min(requestTimeoutMs, modelListTimeoutMs);
    const models = await withOpenCodeServer(
      workDir,
      timeoutMs,
      async (server) =>
        (await server.models()).filter((model) =>
          isUsableModel(model, server.providers),
        ),
    );

    const choices = models.flatMap((model): ModelChoice[] => {
      const id = `${model.providerID}/${model.id}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) return [];
      return [
        {
          id,
          label: model.name || model.id,
          group:
            model.providerID === "zai-coding-plan"
              ? "Z.AI Coding Plan (GLM)"
              : model.providerID,
          reasoning_efforts: (model.variants ?? [])
            .map((variant) => variant.id)
            .filter((effort) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(effort)),
        },
      ];
    });
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

// Claude Code has no model listing command. Its aliases resolve to the latest
// model in each family, so this list stays current across CLI updates.
function listClaudeModels(): ModelChoice[] {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  return [
    { id: "fable", label: "Fable (latest)", reasoning_efforts: efforts },
    { id: "opus", label: "Opus (latest)", reasoning_efforts: efforts },
    { id: "sonnet", label: "Sonnet (latest)", reasoning_efforts: efforts },
    { id: "haiku", label: "Haiku (latest)", reasoning_efforts: [] },
  ].map((model) => ({ ...model, group: "Claude Code" }));
}
