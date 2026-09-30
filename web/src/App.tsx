import {
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onSettled,
} from "solid-js";
import { ImagePicker } from "./components/ImagePicker";
import { Readout } from "./components/Readout";
import { RunHistory } from "./components/RunHistory";
import { useScanJob } from "./useScanJob";
import { ModelControls, type ModelSelection } from "./components/ModelControls";
import { createApi, type RequestEntry } from "./api";

const instructionKey = "vb-instruction";
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const themeKey = "vb-theme";
const systemLight = matchMedia("(prefers-color-scheme: light)");
type ThemeMode = "system" | "light" | "dark";
const nextMode: Record<ThemeMode, ThemeMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem(themeKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}
function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme =
    mode === "system" ? (systemLight.matches ? "light" : "dark") : mode;
}

export function App() {
  const [apiKey, setApiKey] = createSignal("");
  let currentMode = readThemeMode();
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(currentMode);
  const [healthy, setHealthy] = createSignal<boolean | null>(null);
  let selection: ModelSelection = { provider: "", model: "", effort: "" };
  const [instruction, setInstruction] = createSignal(
    localStorage.getItem(instructionKey) ?? "",
  );
  const [file, setFile] = createSignal<File | null>(null);
  const [error, setError] = createSignal("");
  const [logs, setLogs] = createSignal<RequestEntry[]>([]);
  const [selectedId, setSelectedId] = createSignal("");
  let form!: HTMLFormElement;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  const api = createApi(apiKey, (entry) => {
    setLogs((current) =>
      [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 30),
    );
  });
  const scan = useScanJob(api);
  const selected = createMemo(
    () =>
      scan.runs().find((run) => run.id === selectedId()) ??
      scan.runs()[0] ??
      null,
  );

  function cycleTheme() {
    currentMode = nextMode[currentMode];
    setThemeMode(currentMode);
    applyTheme(currentMode);
    if (currentMode === "system") localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, currentMode);
  }
  function onSystemThemeChange() {
    if (currentMode === "system") applyTheme("system");
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
    const text = instruction().trim();
    const image = file();
    if (!image) return setError("Add an image first.");
    if (!text) return setError("Write an instruction for the model.");
    setError("");
    const body = new FormData();
    body.set("instruction", text);
    body.set("image", image, image.name || "image.png");
    if (selection.provider) body.set("provider", selection.provider);
    if (selection.model) body.set("model", selection.model);
    if (selection.effort) body.set("reasoning_effort", selection.effort);
    setSelectedId("");
    await scan.submit({
      form: body,
      instruction: text,
      settings: { ...selection },
      image,
    });
  }
  onSettled(() => {
    void checkHealth();
    healthTimer = setInterval(() => void checkHealth(), 30000);
    systemLight.addEventListener("change", onSystemThemeChange);
    return () => {
      if (healthTimer) clearInterval(healthTimer);
      systemLight.removeEventListener("change", onSystemThemeChange);
    };
  });

  return (
    <>
      <header class="topbar">
        <span class="wordmark">
          <img src="/favicon.png" alt="" width="26" height="26" />
          vision bench
        </span>
        <span
          class={`health ${healthy() === true ? "up" : healthy() === false ? "down" : ""}`}
          title={
            healthy() === null
              ? "Checking API"
              : healthy()
                ? "API online"
                : "API offline"
          }
        >
          <span class="lamp" />
          <span class="health-text">
            {healthy() === null
              ? "Checking API"
              : healthy()
                ? "API online"
                : "API offline"}
          </span>
        </span>
        <span class="spacer" />
        <button
          type="button"
          class="key-btn"
          popovertarget="key-popover"
          aria-label="API key settings"
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <circle cx="5" cy="11" r="3" />
            <path d="M7.2 8.8 14 2M11.5 4.5l2 2" />
          </svg>
          <span>{apiKey().trim() ? "Custom key" : ".env key"}</span>
        </button>
        <div id="key-popover" class="popover" popover>
          <label class="label" for="api-key">
            API key
          </label>
          <input
            type="password"
            id="api-key"
            name="api-key"
            autocomplete="off"
            value={apiKey()}
            onInput={(event) => setApiKey(event.currentTarget.value)}
            placeholder="Bearer token"
          />
          <p class="hint">
            Leave empty to use API_TOKEN from .env. The key stays in this tab
            and is not saved.
          </p>
        </div>
        <button
          type="button"
          class="icon-btn"
          onClick={cycleTheme}
          aria-label={`Theme: ${themeMode()}. Switch to ${nextMode[themeMode()]}.`}
          title={`Theme: ${themeMode()} (click for ${nextMode[themeMode()]})`}
        >
          <svg
            viewBox="0 0 16 16"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <Switch>
              <Match when={themeMode() === "system"}>
                <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
                <path d="M5.5 14h5M8 11.5V14" />
              </Match>
              <Match when={themeMode() === "light"}>
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
              </Match>
              <Match when={themeMode() === "dark"}>
                <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
              </Match>
            </Switch>
          </svg>
        </button>
      </header>
      <main class="bench">
        <form
          ref={(element) => {
            form = element;
          }}
          class="setup"
          action="/api/v1/jobs"
          method="post"
          onSubmit={submit}
        >
          <ImagePicker
            scanning={scan.busy()}
            onFileChange={setFile}
            onError={setError}
          />
          <div class="panel controls">
            <div class="field">
              <label class="label" for="instruction">
                Instruction
              </label>
              <textarea
                id="instruction"
                name="instruction"
                required
                value={instruction()}
                onInput={(event) => {
                  setInstruction(event.currentTarget.value);
                  localStorage.setItem(
                    instructionKey,
                    event.currentTarget.value,
                  );
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    form.requestSubmit();
                  }
                }}
                placeholder="Extract the merchant, date, and total as JSON. Use null when a value is unreadable."
              />
            </div>
            <ModelControls
              api={api}
              onChange={(next) => {
                selection = next;
              }}
              onError={setError}
            />
            <div class="actions">
              <button type="submit" class="run-btn" disabled={scan.busy()}>
                {scan.busy() ? "Analyzing…" : "Analyze"}
                <kbd>{isMac ? "⌘" : "Ctrl"} ↵</kbd>
              </button>
              <Show when={scan.busy()}>
                <button
                  type="button"
                  class="ghost-btn danger"
                  onClick={scan.cancel}
                  title="The job keeps running on the server"
                >
                  Stop polling
                </button>
              </Show>
            </div>
            <Show when={error()}>
              <p class="form-error" role="alert">
                {error()}
              </p>
            </Show>
          </div>
        </form>
        <div class="results">
          <Readout
            run={selected()}
            now={scan.now()}
            logs={logs()}
            onClearLog={() => setLogs([])}
          />
          <RunHistory
            runs={scan.runs()}
            selectedId={selected()?.id ?? ""}
            now={scan.now()}
            onSelect={setSelectedId}
            onClear={() => {
              scan.clearHistory();
              setSelectedId("");
            }}
          />
        </div>
      </main>
    </>
  );
}
