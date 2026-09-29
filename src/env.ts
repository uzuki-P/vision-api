import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const effortId = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const origin = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    ["http:", "https:"].includes(parsed.protocol) && parsed.origin === value
  );
}, "Must be an exact HTTP origin without a path");

export const env = createEnv({
  server: {
    API_TOKEN: z.string().min(32),
    HOST: z.enum(["127.0.0.1", "localhost"]).default("127.0.0.1"),
    PORT: integer(3000, 0, 65535),
    REQUEST_TIMEOUT_MS: integer(120_000, 1_000, 600_000),
    JOB_TIMEOUT_MS: integer(1_800_000, 1_000, 3_600_000),
    JOB_RETENTION_MS: integer(86_400_000, 60_000, 604_800_000),
    MAX_QUEUED_JOBS: integer(16, 0, 100),
    JOB_DATA_DIR: z.string().optional(),
    MAX_IMAGE_BYTES: integer(12_582_912, 1, 50_000_000),
    MAX_CONCURRENT_REQUESTS: integer(2, 1, 16),
    MAX_REQUESTS_PER_MINUTE: integer(30, 1, 10_000),
    DEFAULT_PROVIDER: z.enum(["opencode", "codex"]).default("opencode"),
    DEFAULT_MODEL: z
      .union([z.literal(""), z.string().regex(modelId)])
      .default(""),
    DEFAULT_REASONING_EFFORT: z
      .union([z.literal(""), z.string().regex(effortId)])
      .default(""),
    ALLOWED_MODELS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(modelId))),
    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(z.array(origin)),
    OPENCODE_SOURCE_DATA_DIR: z.string().optional(),
    OPENCODE_BIN: z.string().min(1).default("opencode"),
    CODEX_BIN: z.string().min(1).default("codex"),
    XDG_DATA_HOME: z.string().optional(),
    HOME: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
