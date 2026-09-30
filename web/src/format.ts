import type { Run } from "./useScanJob";

export function formatBytes(size: number) {
  return size >= 1048576
    ? `${(size / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function formatSeconds(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function runElapsed(run: Run, now: number) {
  return run.durationMs ?? now - run.startedAt;
}

export function runStatus(run: Run, now: number) {
  const time = formatSeconds(runElapsed(run, now));
  switch (run.phase) {
    case "submitting":
      return `Submitting · ${time}`;
    case "queued":
      return `Queued · ${time}`;
    case "running":
      return `Running · ${time}`;
    case "succeeded":
      return `Done in ${time}`;
    case "failed":
      return `Failed after ${time}`;
    case "stopped":
      return `Stopped after ${time}`;
  }
}

export function runTone(run: Run) {
  if (run.phase === "succeeded") return "ok";
  if (run.phase === "failed") return "err";
  if (run.phase === "stopped") return "idle";
  return "live";
}
