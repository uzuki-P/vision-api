import { createSignal, onSettled } from "solid-js";
import { delay, type ScanReply, type createApi } from "./api";

const jobStorageKey = "vision-bench-job";
const historyLimit = 20;
const jobIdPattern = /^[0-9a-f-]{36}$/;
type Api = ReturnType<typeof createApi>;

export type RunPhase =
  "submitting" | "queued" | "running" | "succeeded" | "failed" | "stopped";
export type RunSettings = { provider: string; model: string; effort: string };
export type Run = {
  id: string;
  jobId: string;
  phase: RunPhase;
  startedAt: number;
  durationMs: number | null;
  instruction: string;
  settings: RunSettings;
  image: { url: string; name: string } | null;
  reply: ScanReply | null;
  error: { code: string; message: string } | null;
};
export type RunRequest = {
  form: FormData;
  instruction: string;
  settings: RunSettings;
  image: File;
};
type SavedJob = {
  jobId: string;
  startedAt: number;
  instruction: string;
  settings: RunSettings;
};

export function isActive(run: Run) {
  return (
    run.phase === "submitting" ||
    run.phase === "queued" ||
    run.phase === "running"
  );
}

function readSavedJob(): SavedJob | null {
  const raw = sessionStorage.getItem(jobStorageKey);
  if (!raw) return null;
  // Older builds stored the bare job ID.
  if (jobIdPattern.test(raw))
    return {
      jobId: raw,
      startedAt: Date.now(),
      instruction: "",
      settings: { provider: "", model: "", effort: "" },
    };
  try {
    const saved = JSON.parse(raw) as SavedJob;
    return jobIdPattern.test(saved.jobId) ? saved : null;
  } catch {
    return null;
  }
}

export function useScanJob(api: Api) {
  const [runs, setRuns] = createSignal<Run[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  // Plain mirror of `runs` so handlers never read a signal mid-batch.
  let list: Run[] = [];
  let controller: AbortController | null = null;
  let clock: ReturnType<typeof setInterval> | undefined;

  function commit(next: Run[]) {
    list = next;
    setRuns(next);
  }
  function update(id: string, patch: Partial<Run>) {
    commit(list.map((run) => (run.id === id ? { ...run, ...patch } : run)));
  }
  function add(run: Run) {
    const next = [run, ...list];
    for (const old of next.slice(historyLimit))
      if (old.image) URL.revokeObjectURL(old.image.url);
    commit(next.slice(0, historyLimit));
  }
  function settle(id: string, patch: Partial<Run>) {
    sessionStorage.removeItem(jobStorageKey);
    const run = list.find((item) => item.id === id);
    update(id, {
      ...patch,
      durationMs: run ? Date.now() - run.startedAt : null,
    });
  }

  async function poll(id: string, jobId: string, signal: AbortSignal) {
    for (;;) {
      await delay(3000, signal);
      const job = await api.job(jobId, signal);
      if (job.status === "succeeded") {
        if (!job.response) throw new Error("Completed job has no response.");
        settle(id, { phase: "succeeded", reply: job.response });
        return;
      }
      if (job.status === "failed") {
        settle(id, {
          phase: "failed",
          error: job.error ?? {
            code: "unknown",
            message: "The job failed without an error message.",
          },
        });
        return;
      }
      update(id, { phase: job.status });
    }
  }
  function fail(id: string, cause: unknown) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      const jobId = list.find((run) => run.id === id)?.jobId;
      settle(id, {
        phase: "stopped",
        error: {
          code: "polling_stopped",
          message: jobId
            ? `Polling stopped. Job ${jobId} keeps running on the server.`
            : "Stopped before the job was submitted.",
        },
      });
      return;
    }
    settle(id, {
      phase: "failed",
      error: {
        code: "request_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }
  async function track(
    id: string,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    controller = new AbortController();
    setBusy(true);
    setNow(Date.now());
    clock = setInterval(() => setNow(Date.now()), 100);
    try {
      await work(controller.signal);
    } catch (cause) {
      fail(id, cause);
    } finally {
      clearInterval(clock);
      clock = undefined;
      setBusy(false);
      controller = null;
    }
  }

  async function submit(request: RunRequest) {
    if (controller) return;
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    add({
      id,
      jobId: "",
      phase: "submitting",
      startedAt,
      durationMs: null,
      instruction: request.instruction,
      settings: request.settings,
      image: {
        url: URL.createObjectURL(request.image),
        name: request.image.name || "pasted image",
      },
      reply: null,
      error: null,
    });
    await track(id, async (signal) => {
      const job = await api.submit(request.form, signal);
      if (!jobIdPattern.test(job.id))
        throw new Error("Job submission returned no valid ID.");
      update(id, { jobId: job.id, phase: job.status });
      const saved: SavedJob = {
        jobId: job.id,
        startedAt,
        instruction: request.instruction,
        settings: request.settings,
      };
      sessionStorage.setItem(jobStorageKey, JSON.stringify(saved));
      await poll(id, job.id, signal);
    });
  }
  function cancel() {
    controller?.abort();
    sessionStorage.removeItem(jobStorageKey);
  }
  function clearHistory() {
    for (const run of list)
      if (!isActive(run) && run.image) URL.revokeObjectURL(run.image.url);
    commit(list.filter(isActive));
  }

  onSettled(() => {
    const saved = readSavedJob();
    if (saved) {
      const id = crypto.randomUUID();
      add({
        id,
        jobId: saved.jobId,
        phase: "running",
        startedAt: saved.startedAt,
        durationMs: null,
        instruction: saved.instruction,
        settings: saved.settings,
        image: null,
        reply: null,
        error: null,
      });
      void track(id, (signal) => poll(id, saved.jobId, signal));
    }
    return () => {
      controller?.abort();
      if (clock) clearInterval(clock);
      for (const run of list) if (run.image) URL.revokeObjectURL(run.image.url);
    };
  });

  return { runs, busy, now, submit, cancel, clearHistory };
}
