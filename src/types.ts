export type Provider = "opencode" | "codex" | "claude";
export type ModelChoice = {
  id: string;
  label: string;
  group: string;
  reasoning_efforts: string[];
};
export type TokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};
export type ProviderOutput = { text: string; tokenUsage: TokenUsage | null };
export type ImageInput = { bytes: Uint8Array; mime: string; extension: string };
export type ScanInput = {
  requestId: string;
  provider: Provider;
  model: string;
  effort: string;
  instruction: string;
  image: ImageInput;
};
export type Job = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  created_at: number;
  updated_at: number;
  expires_at: number;
  response?: unknown;
  error?: { code: string; message: string };
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class ProviderTimeout extends Error {}
export class ProviderOutputTooLarge extends Error {}
