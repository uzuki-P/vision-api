import { For, Show } from "solid-js";
import type { RequestEntry } from "../api";

export function RequestLog(props: {
  entries: RequestEntry[];
  onClear: () => void;
}) {
  return (
    <div class="reqlog">
      <div class="reqlog-head">
        <span class="name">Request log</span>
        <button type="button" class="clear-btn" onClick={props.onClear}>
          clear
        </button>
      </div>
      <Show
        when={props.entries.length > 0}
        fallback={<div class="reqlog-empty">No requests yet.</div>}
      >
        <For each={props.entries}>
          {(entry) => (
            <details
              class={`req ${entry.status === "pending" ? "pending" : entry.status.startsWith("2") ? "" : "err"}`}
              open={entry.method === "POST"}
            >
              <summary>
                <span class="dot" />
                <span class="meth">{entry.method}</span>
                <span class="path">{entry.url}</span>
                <span class="ms">
                  {entry.status} · {entry.ms}
                </span>
              </summary>
              <pre>
                {entry.request ? `Request\n${entry.request}\n\n` : ""}
                {entry.response ? `Response\n${entry.response}` : ""}
              </pre>
            </details>
          )}
        </For>
      </Show>
    </div>
  );
}
