import { For } from "solid-js";
import { RequestLog } from "./RequestLog";
import type { RequestEntry } from "../api";

export function Readout(props: {
  badge: { kind: string; text: string };
  chips: Array<[string, string]>;
  output: string;
  logs: RequestEntry[];
  onClearLog: () => void;
}) {
  return (
    <section class="card">
      <div class="readout-head">
        <span class={`state ${props.badge.kind}`}>
          <span class="lamp" />
          {props.badge.text}
        </span>
        <div class="chips">
          <For each={props.chips}>
            {([label, value]) => (
              <span class="chip">
                {label} <b>{value}</b>
              </span>
            )}
          </For>
        </div>
      </div>
      <pre
        class={`json ${props.badge.kind === "err" ? "error" : ""}`}
        aria-live="polite"
      >
        {props.output}
      </pre>
      <RequestLog entries={props.logs} onClear={props.onClearLog} />
    </section>
  );
}
