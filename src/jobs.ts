import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Cause, Effect, Exit } from "effect";
import {
  jobDataDir,
  jobRetentionMs,
  jobTimeoutMs,
  maxConcurrentRequests,
  maxQueuedJobs,
} from "./config";
import { scanEffect } from "./scan";
import {
  HttpError,
  ProviderOutputTooLarge,
  ProviderTimeout,
  type Job,
  type ScanInput,
} from "./types";

let activeRequests = 0;
let activeJobs = 0;
const pendingJobs: string[] = [];
export const jobsReady = recoverJobs().catch(() =>
  console.error(JSON.stringify({ event: "job_recovery_failed" })),
);

export function isQueueFull(): boolean {
  return (
    pendingJobs.length >= maxQueuedJobs &&
    activeJobs + activeRequests >= maxConcurrentRequests
  );
}
export function canStartSync(): boolean {
  return activeRequests + activeJobs < maxConcurrentRequests;
}
export function startSync(): void {
  activeRequests += 1;
}
export function finishSync(): void {
  activeRequests -= 1;
  dispatchJobs();
}
function enqueueJob(id: string): void {
  pendingJobs.push(id);
  dispatchJobs();
}

function jobPath(id: string): string {
  return path.join(jobDataDir, id);
}

export async function createJob(input: ScanInput): Promise<Job> {
  if (isQueueFull()) throw new HttpError(429, "busy", "Job queue is full");
  const now = Date.now();
  const job: Job = {
    id: input.requestId,
    status: "queued",
    created_at: now,
    updated_at: now,
    expires_at: now + jobRetentionMs,
  };
  const dir = jobPath(job.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path.join(dir, "image"), input.image.bytes, {
      mode: 0o600,
    });
    await writeFile(
      path.join(dir, "input.json"),
      JSON.stringify({
        instruction: input.instruction,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        mime: input.image.mime,
        extension: input.image.extension,
      }),
      { mode: 0o600 },
    );
    await saveJob(job);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  enqueueJob(job.id);
  return job;
}

async function saveJob(job: Job): Promise<void> {
  const dir = jobPath(job.id);
  const temp = path.join(dir, "status.tmp");
  await writeFile(temp, JSON.stringify(job), { mode: 0o600 });
  await rename(temp, path.join(dir, "status.json"));
}

export async function loadJob(id: string): Promise<Job | null> {
  try {
    return JSON.parse(
      await readFile(path.join(jobPath(id), "status.json"), "utf8"),
    ) as Job;
  } catch {
    return null;
  }
}

function dispatchJobs(): void {
  while (
    activeJobs + activeRequests < maxConcurrentRequests &&
    pendingJobs.length > 0
  ) {
    const id = pendingJobs.shift()!;
    activeJobs += 1;
    void runJob(id)
      .catch(() =>
        console.error(
          JSON.stringify({ request_id: id, event: "job_state_failed" }),
        ),
      )
      .finally(() => {
        activeJobs -= 1;
        dispatchJobs();
      });
  }
}

async function runJob(id: string): Promise<void> {
  const job = await loadJob(id);
  if (!job) return;
  job.status = "running";
  job.updated_at = Date.now();
  await saveJob(job);
  try {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const inputText = yield* Effect.tryPromise(() =>
            readFile(path.join(jobPath(id), "input.json"), "utf8"),
          );
          const input = yield* Effect.try({
            try: () => JSON.parse(inputText),
            catch: (error) => error,
          });
          const bytes = new Uint8Array(
            yield* Effect.tryPromise(() =>
              readFile(path.join(jobPath(id), "image")),
            ),
          );
          return yield* scanEffect(
            {
              requestId: id,
              provider: input.provider,
              model: input.model,
              effort: input.effort,
              instruction: input.instruction,
              image: { bytes, mime: input.mime, extension: input.extension },
            },
            jobTimeoutMs,
          );
        }),
      ),
    );
    if (Exit.isSuccess(exit)) {
      job.response = exit.value;
      job.status = "succeeded";
    } else {
      throw Cause.squash(exit.cause);
    }
  } catch (error) {
    job.status = "failed";
    job.error =
      error instanceof ProviderTimeout
        ? { code: "provider_timeout", message: "Model request timed out" }
        : error instanceof ProviderOutputTooLarge
          ? {
              code: "provider_output_too_large",
              message: "Model response exceeded the output limit",
            }
          : error instanceof HttpError
            ? { code: error.code, message: error.message }
            : {
                code: "provider_failed",
                message: "The selected provider request failed",
              };
    console.error(
      JSON.stringify({
        request_id: id,
        event: "job_failed",
        code: job.error.code,
      }),
    );
  } finally {
    job.updated_at = Date.now();
    await saveJob(job);
    await Promise.all(
      ["image", "input.json"].map((file) =>
        rm(path.join(jobPath(id), file), { force: true }),
      ),
    );
  }
}

async function recoverJobs(): Promise<void> {
  await mkdir(jobDataDir, { recursive: true, mode: 0o700 });
  for (const id of await readdir(jobDataDir)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const job = await loadJob(id);
    if (!job) continue;
    if (job.expires_at <= Date.now()) {
      await rm(jobPath(id), { recursive: true, force: true });
      continue;
    }
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.error = {
        code: "service_restarted",
        message: "Service restarted before the job completed",
      };
      job.updated_at = Date.now();
      await saveJob(job);
      await Promise.all(
        ["image", "input.json"].map((file) =>
          rm(path.join(jobPath(id), file), { force: true }),
        ),
      );
    }
  }
}

export async function removeExpiredJobs(): Promise<void> {
  for (const id of await readdir(jobDataDir).catch(() => [])) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const job = await loadJob(id);
    if (
      job &&
      job.expires_at <= Date.now() &&
      job.status !== "running" &&
      job.status !== "queued"
    ) {
      await rm(jobPath(id), { recursive: true, force: true });
    }
  }
}
