import { timingSafeEqual } from "node:crypto";
import {
  allowedModels,
  apiToken,
  corsOrigins,
  defaultEffort,
  defaultModel,
  defaultProvider,
  maxRequestsPerMinute,
  requestTimeoutMs,
} from "./config";
import { parseRequestProvider, readInput, resolveScanInput } from "./input";
import {
  canStartSync,
  createJob,
  finishSync,
  isQueueFull,
  jobsReady,
  loadJob,
  startSync,
} from "./jobs";
import { listModels } from "./models";
import { runScan } from "./scan";
import {
  HttpError,
  ProviderOutputTooLarge,
  ProviderTimeout,
  type Provider,
} from "./types";

let requestWindowStart = Date.now();
let requestsInWindow = 0;

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return preflight(request);
  if (request.method === "GET" && url.pathname === "/healthz")
    return json({ ok: true });
  if (!authorized(request))
    return error(401, "unauthorized", "Valid bearer token required");

  if (request.method === "GET" && url.pathname === "/v1/providers") {
    return json({
      providers: ["opencode", "codex"],
      default_provider: defaultProvider,
      default_model: defaultModel || null,
      default_reasoning_effort: defaultEffort || null,
      model_allowlist_enabled: allowedModels.size > 0,
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    return modelsResponse(url.searchParams.get("provider"));
  }

  const jobId = /^\/v1\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];
  if (request.method === "GET" && jobId) return jobResponse(jobId);
  if (request.method === "POST" && url.pathname === "/v1/jobs")
    return submitJob(request);
  if (request.method === "POST" && url.pathname === "/v1/analyze")
    return analyzeNow(request);
  return error(404, "not_found", "Route not found");
}

async function modelsResponse(requested: string | null): Promise<Response> {
  let provider: Provider;
  try {
    provider = requested ? parseRequestProvider(requested) : defaultProvider;
  } catch (cause) {
    if (cause instanceof HttpError)
      return error(cause.status, cause.code, cause.message);
    throw cause;
  }
  try {
    return json({ provider, models: await listModels(provider) });
  } catch {
    console.error(JSON.stringify({ event: "model_list_failed", provider }));
    return error(
      502,
      "model_list_failed",
      "Could not load models for the selected provider",
    );
  }
}

async function jobResponse(id: string): Promise<Response> {
  await jobsReady;
  const job = await loadJob(id);
  if (!job || job.expires_at <= Date.now())
    return error(404, "job_not_found", "Job not found");
  return json(job);
}

async function submitJob(request: Request): Promise<Response> {
  await jobsReady;
  if (!takeRateLimitSlot())
    return error(429, "rate_limited", "Request limit reached; retry later");
  if (isQueueFull()) return error(429, "busy", "Job queue is full");

  try {
    const input = resolveScanInput(
      crypto.randomUUID(),
      await readInput(request),
    );
    const job = await createJob(input);
    return Response.json(job, {
      status: 202,
      headers: {
        "cache-control": "no-store",
        location: `/v1/jobs/${job.id}`,
        "retry-after": "3",
      },
    });
  } catch (cause) {
    if (cause instanceof HttpError)
      return error(cause.status, cause.code, cause.message);
    console.error(JSON.stringify({ event: "job_submission_failed" }));
    return error(500, "job_submission_failed", "Could not submit job");
  }
}

async function analyzeNow(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (!takeRateLimitSlot())
    return error(429, "rate_limited", "Request limit reached; retry later");
  if (!canStartSync())
    return error(429, "busy", "Too many requests are running");

  startSync();
  try {
    const input = resolveScanInput(requestId, await readInput(request));
    return json(await runScan(input, requestTimeoutMs));
  } catch (cause) {
    if (cause instanceof HttpError)
      return error(cause.status, cause.code, cause.message, requestId);
    if (cause instanceof ProviderTimeout)
      return error(
        504,
        "provider_timeout",
        "Model request timed out",
        requestId,
      );
    if (cause instanceof ProviderOutputTooLarge)
      return error(
        502,
        "provider_output_too_large",
        "Model response exceeded the output limit",
        requestId,
      );
    console.error(
      JSON.stringify({
        request_id: requestId,
        event: "provider_request_failed",
      }),
    );
    return error(
      502,
      "provider_failed",
      "The selected provider request failed",
      requestId,
    );
  } finally {
    finishSync();
  }
}

function takeRateLimitSlot(): boolean {
  const now = Date.now();
  if (now - requestWindowStart >= 60_000) {
    requestWindowStart = now;
    requestsInWindow = 0;
  }
  if (requestsInWindow >= maxRequestsPerMinute) return false;
  requestsInWindow += 1;
  return true;
}

function authorized(request: Request): boolean {
  const match = /^Bearer ([\x21-\x7e]+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(apiToken);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function preflight(request: Request): Response {
  const origin = corsOrigin(request);
  if (!origin)
    return error(
      403,
      "cors_disallowed",
      "Origin is not allowed for cross-origin requests",
    );
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
function error(
  status: number,
  code: string,
  message: string,
  requestId?: string,
): Response {
  return json(
    {
      error: { code, message },
      ...(requestId ? { request_id: requestId } : {}),
    },
    status,
  );
}
function corsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  return origin && corsOrigins.has(origin) ? origin : null;
}
export function applyCors(request: Request, response: Response): Response {
  const origin = corsOrigin(request);
  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.append("vary", "origin");
  }
  return response;
}
