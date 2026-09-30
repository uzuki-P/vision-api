import { For, Show } from "solid-js";
import type { RequestEntry } from "../api";

export function RequestLog(props: {
  entries: RequestEntry[];
  onClear: () => void;
}) {
  return (
    <div class="reqlog">
      <Show
        when={props.entries.length > 0}
        fallback={<p class="history-empty">No requests yet.</p>}
      >
        <div class="section-head">
          <span class="hint">Newest first, last 30 requests.</span>
          <button type="button" class="link-btn quiet" onClick={props.onClear}>
            Clear
          </button>
        </div>
        <For each={props.entries}>
          {(entry) => (
            <details
              class={`req ${entry.status === "pending" ? "pending" : entry.status.startsWith("2") ? "ok" : "err"}`}
              open={entry.method === "POST"}
            >
              <summary>
                <span class="lamp" />
                <span class="meth">{entry.method}</span>
                <span class="path">{entry.url}</span>
                <span class="ms">
                  {entry.status}
                  {entry.ms ? ` · ${entry.ms}` : ""}
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
