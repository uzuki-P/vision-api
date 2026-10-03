import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "./env";
import { HttpError, type Provider } from "./types";

export const apiToken = env.API_TOKEN;
export const host = env.HOST;
export const port = env.PORT;
export const requestTimeoutMs = env.REQUEST_TIMEOUT_MS;
export const jobTimeoutMs = env.JOB_TIMEOUT_MS;
export const jobRetentionMs = env.JOB_RETENTION_MS;
export const maxQueuedJobs = env.MAX_QUEUED_JOBS;
export const jobDataDir =
  env.JOB_DATA_DIR ??
  path.join(env.HOME ?? tmpdir(), ".local", "state", "vision-api", "jobs");
export const maxImageBytes = env.MAX_IMAGE_BYTES;
export const maxConcurrentRequests = env.MAX_CONCURRENT_REQUESTS;
export const maxRequestsPerMinute = env.MAX_REQUESTS_PER_MINUTE;
export const defaultProvider = env.DEFAULT_PROVIDER;
export const defaultModel = env.DEFAULT_MODEL;
export const defaultEffort = env.DEFAULT_REASONING_EFFORT;
export const openCodeBin = env.OPENCODE_BIN;
export const codexBin = env.CODEX_BIN;
export const claudeBin = env.CLAUDE_BIN;
export const allowedModels = new Set(env.ALLOWED_MODELS);
export const corsOrigins = new Set(env.CORS_ORIGINS);

export function parseProvider(value: string): Provider {
  if (value === "opencode" || value === "codex" || value === "claude")
    return value;
  throw new Error("Provider must be opencode, codex, or claude");
}

export function validateModel(model: string): void {
  if (allowedModels.size > 0 && !model)
    throw new HttpError(
      400,
      "model_required",
      "Set a model in the request or DEFAULT_MODEL",
    );
  if (allowedModels.size > 0 && !allowedModels.has(model))
    throw new HttpError(
      400,
      "model_not_allowed",
      "Requested model is not in the configured allowlist",
    );
}

export function openCodeSourceDataDir(): string {
  return (
    env.OPENCODE_SOURCE_DATA_DIR ??
    path.join(
      env.XDG_DATA_HOME ?? path.join(env.HOME ?? "/tmp", ".local", "share"),
      "opencode",
    )
  );
}
