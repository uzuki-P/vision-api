export type ModelChoice = {
  id: string;
  label: string;
  group: string;
  reasoning_efforts: string[];
};
export type ProvidersReply = {
  providers: string[];
  default_provider: string;
  default_model: string | null;
  default_reasoning_effort: string | null;
};
export type ScanReply = {
  _metadata: {
    provider: string;
    model: string;
    reasoning_effort: string | null;
    token_usage: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      reasoning_output_tokens?: number;
      total_tokens?: number;
    } | null;
  };
  result: Record<string, unknown>;
};
export type JobReply = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  response?: ScanReply;
  error?: { code: string; message: string };
};
export type RequestEntry = {
  id: string;
  method: string;
  url: string;
  status: string;
  ms: string;
  request: string;
  response: string;
};

function describeBody(body: unknown): string {
  if (!(body instanceof FormData)) return "";
  return [...body.entries()]
    .map(([key, item]) => {
      const value: unknown = item;
      return value instanceof File
        ? `${key}: ${value.name || "image"} (${value.size >= 1048576 ? `${(value.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(value.size / 1024))} KB`}, ${value.type})`
        : `${key}: ${String(value).slice(0, 200)}`;
    })
    .join("\n");
}

export function createApi(
  key: () => string,
  log: (entry: RequestEntry) => void,
) {
  async function request<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    const method = options.method || "GET";
    const headers = new Headers(options.headers);
    if (key().trim()) headers.set("x-vision-api-key", key().trim());
    const entry: RequestEntry = {
      id: crypto.randomUUID(),
      method,
      url,
      status: "pending",
      ms: "",
      request: describeBody(options.body),
      response: "",
    };
    log({ ...entry });
    const started = performance.now();
    try {
      const response = await fetch(url, { ...options, headers });
      entry.status = String(response.status);
      entry.ms = `${((performance.now() - started) / 1000).toFixed(1)}s`;
      const responseText = await response.text();
      entry.response = responseText.slice(0, 20000);
      log({ ...entry });
      const body = JSON.parse(responseText) as T & {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(body.error?.message || `HTTP ${response.status}`);
      return body;
    } catch (error) {
      if (entry.status === "pending") {
        entry.status =
          error instanceof DOMException && error.name === "AbortError"
            ? "aborted"
            : "network error";
        entry.ms = `${((performance.now() - started) / 1000).toFixed(1)}s`;
        log({ ...entry });
      }
      throw error;
    }
  }
  return {
    providers: () => request<ProvidersReply>("/api/v1/providers"),
    models: (provider: string) =>
      request<{ models: ModelChoice[] }>(
        `/api/v1/models?provider=${encodeURIComponent(provider)}`,
      ),
    submit: (form: FormData, signal: AbortSignal) =>
      request<JobReply>("/api/v1/jobs", { method: "POST", body: form, signal }),
    job: (id: string, signal: AbortSignal) =>
      request<JobReply>(`/api/v1/jobs/${id}`, { signal }),
  };
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("Polling stopped", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Polling stopped", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
