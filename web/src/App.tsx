import { Show, createSignal, onSettled } from "solid-js";
import { ImagePicker } from "./components/ImagePicker";
import { Readout } from "./components/Readout";
import { useScanJob } from "./useScanJob";
import { ModelControls, type ModelSelection } from "./components/ModelControls";
import { createApi, type RequestEntry } from "./api";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [apiKey, setApiKey] = createSignal("");
  const [theme, setTheme] = createSignal(
    document.documentElement.dataset.theme || "dark",
  );
  const [healthy, setHealthy] = createSignal<boolean | null>(null);
  let selection: ModelSelection = { provider: "", model: "", effort: "" };
  const [instruction, setInstruction] = createSignal("");
  const [file, setFile] = createSignal<File | null>(null);
  const [error, setError] = createSignal("");
  const [logs, setLogs] = createSignal<RequestEntry[]>([]);
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  const api = createApi(apiKey, (entry) => {
    setLogs((current) =>
      [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 30),
    );
  });
  const scan = useScanJob(api);
  function toggleTheme() {
    const next = theme() === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("vb-theme", next);
  }
  async function checkHealth() {
    try {
      const response = await fetch("/api/healthz", {
        signal: AbortSignal.timeout(4000),
      });
      setHealthy(response.ok);
    } catch {
      setHealthy(false);
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (scan.busy()) return;
    if (!instruction().trim()) return setError("Instruction is required.");
    if (!file()) return setError("Pick an image first.");
    setError("");
    const form = new FormData();
    form.set("instruction", instruction().trim());
    form.set("image", file()!, file()!.name || "image.png");
    if (selection.provider) form.set("provider", selection.provider);
    if (selection.model) form.set("model", selection.model);
    if (selection.effort) form.set("reasoning_effort", selection.effort);
    await scan.submit(form);
  }
  onSettled(() => {
    void checkHealth();
    healthTimer = setInterval(() => void checkHealth(), 30000);
    return () => {
      if (healthTimer) clearInterval(healthTimer);
    };
  });

  return (
    <>
      <header>
        <span class="wordmark">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <circle cx="10" cy="10" r="6.5" />
            <path d="M10 0.5v4M10 15.5v4M0.5 10h4M15.5 10h4" />
          </svg>
          vision bench
        </span>
        <span
          class={`health ${healthy() === true ? "up" : healthy() === false ? "down" : ""}`}
        >
          <span class="lamp" />
          {healthy() === null
            ? "checking"
            : healthy()
              ? "upstream online"
              : "upstream offline"}
        </span>
        <span class="spacer" />
        <button
          type="button"
          class="icon-btn"
          onClick={toggleTheme}
          aria-label="Switch theme"
          title="Switch theme"
        >
          <span aria-hidden="true">{theme() === "light" ? "☀" : "☾"}</span>
        </button>
      </header>
      <main>
        <form
          class="card"
          action="/api/v1/jobs"
          method="post"
          onSubmit={submit}
        >
          <label for="api-key">
            <span class="name">API key</span>
            <span class="note">empty uses the .env token</span>
          </label>
          <input
            type="password"
            id="api-key"
            name="api-key"
            autocomplete="off"
            value={apiKey()}
            onInput={(event) => setApiKey(event.currentTarget.value)}
            placeholder="API key"
          />
          <ModelControls
            api={api}
            onChange={(next) => {
              selection = next;
            }}
            onError={setError}
          />
          <label for="instruction">
            <span class="name">Instruction</span>
          </label>
          <textarea
            id="instruction"
            name="instruction"
            required
            value={instruction()}
            onInput={(event) => setInstruction(event.currentTarget.value)}
            placeholder="e.g. Extract the merchant and total as JSON."
          />
          <ImagePicker onFileChange={setFile} onError={setError} />
          <div class="actions">
            <button type="submit" class="run" disabled={scan.busy()}>
              Analyze
            </button>
            <Show when={scan.busy()}>
              <button
                type="button"
                class="cancel"
                style={{ display: "inline" }}
                onClick={scan.cancel}
              >
                cancel
              </button>
            </Show>
            <span class="status-line">{scan.elapsed()}</span>
          </div>
          <div class="form-error" role="alert" aria-live="polite">
            {error()}
          </div>
        </form>
        <Readout
          badge={scan.badge()}
          chips={scan.chips()}
          output={scan.output()}
          logs={logs()}
          onClearLog={() => setLogs([])}
        />
      </main>
    </>
  );
}
