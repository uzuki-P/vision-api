import { createSignal, onSettled } from "solid-js";
import { delay, type JobReply, type ScanReply, type createApi } from "./api";

const jobStorageKey = "vision-bench-job";
type Api = ReturnType<typeof createApi>;
type Badge = { kind: string; text: string };

export function useScanJob(api: Api) {
  const [busy, setBusy] = createSignal(false);
  const [elapsed, setElapsed] = createSignal("");
  const [badge, setBadge] = createSignal<Badge>({ kind: "", text: "idle" });
  const [output, setOutput] = createSignal(
    "Send a request to see the model's response.",
  );
  const [chips, setChips] = createSignal<Array<[string, string]>>([]);
  const [activeJob, setActiveJob] = createSignal("");
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function startTimer(started: number) {
    setElapsed("0.0s");
    timer = setInterval(
      () => setElapsed(`${((performance.now() - started) / 1000).toFixed(1)}s`),
      100,
    );
  }
  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
    setElapsed("");
  }
  function showResult(reply: ScanReply, started: number) {
    setBadge({
      kind: "ok",
      text: `done · ${((performance.now() - started) / 1000).toFixed(1)}s`,
    });
    const meta = reply._metadata;
    const rows: Array<[string, string]> = [
      ["provider", meta.provider || "?"],
      ["model", meta.model || "?"],
    ];
    if (meta.reasoning_effort) rows.push(["effort", meta.reasoning_effort]);
    if (meta.token_usage) {
      rows.push([
        "tokens",
        `${meta.token_usage.input_tokens ?? "?"} in / ${meta.token_usage.output_tokens ?? "?"} out`,
      ]);
      if (meta.token_usage.total_tokens)
        rows.push(["total", String(meta.token_usage.total_tokens)]);
    }
    setChips(rows);
    setOutput(JSON.stringify(reply, null, 2));
  }
  async function pollJob(id: string, signal: AbortSignal, started: number) {
    setActiveJob(id);
    sessionStorage.setItem(jobStorageKey, id);
    setOutput(`Job ${id} submitted. Waiting for result…`);
    for (;;) {
      await delay(3000, signal);
      const job: JobReply = await api.job(id, signal);
      if (job.status === "succeeded") {
        sessionStorage.removeItem(jobStorageKey);
        setActiveJob("");
        if (!job.response) throw new Error("Completed job has no response.");
        showResult(job.response, started);
        return;
      }
      if (job.status === "failed") {
        sessionStorage.removeItem(jobStorageKey);
        setActiveJob("");
        setBadge({ kind: "err", text: "failed" });
        setChips([["error", job.error?.code || "unknown"]]);
        setOutput(JSON.stringify(job.error, null, 2));
        return;
      }
      setBadge({ kind: "running", text: job.status });
    }
  }
  function reportFailure(cause: unknown) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      setBadge({ kind: "", text: "polling stopped" });
      setOutput(
        activeJob()
          ? `Polling stopped. Job ${activeJob()} keeps running.`
          : "Submission stopped.",
      );
    } else {
      setBadge({ kind: "err", text: "failed" });
      setOutput(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function submit(form: FormData) {
    if (busy()) return;
    const started = performance.now();
    controller = new AbortController();
    setBusy(true);
    setBadge({ kind: "running", text: "submitting" });
    setChips([]);
    setOutput("Submitting job…");
    startTimer(started);
    try {
      const job = await api.submit(form, controller.signal);
      if (!/^[0-9a-f-]{36}$/.test(job.id))
        throw new Error("Job submission returned no valid ID.");
      await pollJob(job.id, controller.signal, started);
    } catch (cause) {
      reportFailure(cause);
    } finally {
      stopTimer();
      setBusy(false);
      controller = null;
    }
  }
  function cancel() {
    controller?.abort();
    sessionStorage.removeItem(jobStorageKey);
  }
  onSettled(() => {
    const saved = sessionStorage.getItem(jobStorageKey);
    if (saved && /^[0-9a-f-]{36}$/.test(saved)) {
      const started = performance.now();
      controller = new AbortController();
      setBusy(true);
      setBadge({ kind: "running", text: "resuming" });
      startTimer(started);
      void pollJob(saved, controller.signal, started)
        .catch(reportFailure)
        .finally(() => {
          stopTimer();
          setBusy(false);
          controller = null;
        });
    }
    return () => {
      controller?.abort();
      if (timer) clearInterval(timer);
    };
  });
  return { busy, elapsed, badge, output, chips, submit, cancel };
}
