import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { JsonView } from "./JsonView";
import { RequestLog } from "./RequestLog";
import type { RequestEntry } from "../api";
import { runStatus, runTone } from "../format";
import type { Run } from "../useScanJob";

type Tab = "result" | "response" | "requests";

function usageChips(run: Run): Array<[string, string]> {
  const meta = run.reply?._metadata;
  const rows: Array<[string, string]> = [
    ["provider", meta?.provider || run.settings.provider || "default"],
    ["model", meta?.model || run.settings.model || "default"],
  ];
  const effort = meta?.reasoning_effort || run.settings.effort;
  if (effort) rows.push(["effort", effort]);
  const usage = meta?.token_usage;
  if (usage) {
    rows.push(["in", String(usage.input_tokens ?? "?")]);
    if (usage.cached_input_tokens)
      rows.push(["cached", String(usage.cached_input_tokens)]);
    rows.push(["out", String(usage.output_tokens ?? "?")]);
    if (usage.reasoning_output_tokens)
      rows.push(["reasoning", String(usage.reasoning_output_tokens)]);
    if (usage.total_tokens) rows.push(["total", String(usage.total_tokens)]);
  }
  return rows;
}

export function Readout(props: {
  run: Run | null;
  now: number;
  logs: RequestEntry[];
  onClearLog: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("result");
  const [copied, setCopied] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const shown = createMemo(() => {
    const run = props.run;
    if (!run) return null;
    if (tab() === "response")
      return run.reply ?? (run.error ? { error: run.error } : null);
    if (tab() === "result") return run.reply?.result ?? null;
    return null;
  });

  async function copy() {
    const value = shown();
    if (value === null) return;
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    setCopied(true);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section class="panel readout" aria-label="Result">
      <div class="readout-head">
        <Show
          when={props.run}
          fallback={
            <span class="state idle">
              <span class="lamp" />
              No runs yet
            </span>
          }
        >
          {(run) => (
            <span class={`state ${runTone(run())}`} aria-live="polite">
              <span class="lamp" />
              {runStatus(run(), props.now)}
            </span>
          )}
        </Show>
        <span class="spacer" />
        <div class="segmented tabs" role="radiogroup" aria-label="View">
          <label>
            <input
              type="radio"
              name="readout-tab"
              checked={tab() === "result"}
              onChange={() => setTab("result")}
            />
            <span>Result</span>
          </label>
          <label>
            <input
              type="radio"
              name="readout-tab"
              checked={tab() === "response"}
              onChange={() => setTab("response")}
            />
            <span>
              <span class="wide-only">Full response</span>
              <span class="narrow-only">Response</span>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="readout-tab"
              checked={tab() === "requests"}
              onChange={() => setTab("requests")}
            />
            <span>
              Requests <span class="count">{props.logs.length}</span>
            </span>
          </label>
        </div>
      </div>

      <Show when={props.run}>
        {(run) => (
          <div class="chips">
            <For each={usageChips(run())} keyed={false}>
              {(chip) => (
                <span class="chip">
                  <span class="chip-k">{chip()[0]}</span>
                  <span class="chip-v">{chip()[1]}</span>
                </span>
              )}
            </For>
          </div>
        )}
      </Show>

      <div class="readout-body">
        <Switch>
          <Match when={tab() === "requests"}>
            <RequestLog entries={props.logs} onClear={props.onClearLog} />
          </Match>
          <Match when={!props.run}>
            <div class="empty">
              <p class="empty-title">Results show up here.</p>
              <p>
                Add an image, write an instruction, and press Analyze. The
                model's JSON appears in this panel, and each run stays in the
                history below until you reload the page.
              </p>
            </div>
          </Match>
          <Match when={shown() !== null}>
            <div class="code-wrap">
              <button
                type="button"
                class="ghost-btn copy-btn"
                onClick={() => void copy()}
              >
                {copied() ? "Copied" : "Copy JSON"}
              </button>
              <JsonView
                value={shown()}
                label={
                  tab() === "result" ? "Result JSON" : "Full response JSON"
                }
              />
            </div>
          </Match>
          <Match when={props.run?.error}>
            {(error) => (
              <div
                class={`notice ${props.run?.phase === "stopped" ? "" : "err"}`}
                role="alert"
              >
                <span class="notice-code">{error().code}</span>
                <p>{error().message}</p>
              </div>
            )}
          </Match>
          <Match when={props.run}>
            {(run) => (
              <div class="waiting">
                <p>
                  {run().jobId
                    ? `Job ${run().jobId} is ${run().phase}. The page checks every 3 seconds.`
                    : "Uploading the image…"}
                </p>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </section>
  );
}
