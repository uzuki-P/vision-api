import { For, Show } from "solid-js";
import { formatSeconds, runElapsed, runTone } from "../format";
import { isActive, type Run } from "../useScanJob";

export function RunHistory(props: {
  runs: Run[];
  selectedId: string;
  now: number;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <section class="panel history" aria-label="Run history">
      <div class="section-head">
        <h2 class="label">
          Runs this session <span class="count">{props.runs.length}</span>
        </h2>
        <Show when={props.runs.some((run) => !isActive(run))}>
          <button type="button" class="link-btn quiet" onClick={props.onClear}>
            Clear finished
          </button>
        </Show>
      </div>
      <Show
        when={props.runs.length > 0}
        fallback={
          <p class="history-empty">
            Try the same image with another model to compare answers here.
          </p>
        }
      >
        <ol class="run-list">
          <For each={props.runs} keyed={(run) => run.id}>
            {(run) => (
              <li>
                <button
                  type="button"
                  class="run-row"
                  aria-current={
                    run().id === props.selectedId ? "true" : undefined
                  }
                  onClick={() => props.onSelect(run().id)}
                >
                  <span class="thumb">
                    <Show when={run().image}>
                      {(image) => <img src={image().url} alt="" />}
                    </Show>
                  </span>
                  <span class="run-text">
                    <span class="run-instruction">
                      {run().instruction ||
                        `Resumed job ${run().jobId.slice(0, 8)}`}
                    </span>
                    <span class="run-model">
                      {run().reply?._metadata.model ||
                        run().settings.model ||
                        `${run().settings.provider || "provider"} default`}
                      {run().settings.effort
                        ? ` · ${run().settings.effort}`
                        : ""}
                    </span>
                  </span>
                  <span class={`run-state ${runTone(run())}`}>
                    <span class="lamp" />
                    {formatSeconds(runElapsed(run(), props.now))}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}
