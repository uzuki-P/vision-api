import { For, createMemo, createSignal, onSettled } from "solid-js";
import type { ModelChoice, ProvidersReply } from "../api";

export type ModelSelection = {
  provider: string;
  model: string;
  effort: string;
};
export type ModelApi = {
  providers: () => Promise<ProvidersReply>;
  models: (provider: string) => Promise<{ models: ModelChoice[] }>;
};

export function ModelControls(props: {
  api: ModelApi;
  onChange: (selection: ModelSelection) => void;
  onError: (message: string) => void;
}) {
  const [providers, setProviders] = createSignal<string[]>([]);
  const [provider, setProvider] = createSignal("");
  const [models, setModels] = createSignal<ModelChoice[]>([]);
  const [model, setModel] = createSignal("");
  const [effort, setEffort] = createSignal("");
  const [refreshing, setRefreshing] = createSignal(false);
  const cache = new Map<string, ModelChoice[]>();
  let defaultEffort = "";

  const efforts = createMemo(
    () => models().find((item) => item.id === model())?.reasoning_efforts ?? [],
  );
  const groups = createMemo(() => {
    const grouped = new Map<string, ModelChoice[]>();
    for (const item of models())
      grouped.set(item.group, [...(grouped.get(item.group) ?? []), item]);
    return [...grouped.entries()];
  });

  function publish(next: ModelSelection) {
    props.onChange(next);
  }
  async function loadModels(
    name: string,
    preferredModel = "",
    preferredEffort = "",
  ) {
    setRefreshing(true);
    try {
      const reply = await props.api.models(name);
      cache.set(name, reply.models);
      setModels(reply.models);
      const nextModel = reply.models.some((item) => item.id === preferredModel)
        ? preferredModel
        : "";
      const available =
        reply.models.find((item) => item.id === nextModel)?.reasoning_efforts ??
        [];
      const nextEffort = available.includes(preferredEffort)
        ? preferredEffort
        : "";
      setModel(nextModel);
      setEffort(nextEffort);
      publish({ provider: name, model: nextModel, effort: nextEffort });
      props.onError("");
    } catch (cause) {
      setModels([]);
      props.onError(
        `Could not load models: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setRefreshing(false);
    }
  }
  function changeProvider(name: string) {
    setProvider(name);
    setModel("");
    setEffort("");
    publish({ provider: name, model: "", effort: "" });
    if (cache.has(name)) setModels(cache.get(name)!);
    else void loadModels(name);
  }
  function changeModel(value: string) {
    const available =
      models().find((item) => item.id === value)?.reasoning_efforts ?? [];
    const nextEffort = available.includes(defaultEffort) ? defaultEffort : "";
    setModel(value);
    setEffort(nextEffort);
    publish({ provider: provider(), model: value, effort: nextEffort });
  }
  function changeEffort(value: string) {
    setEffort(value);
    publish({ provider: provider(), model: model(), effort: value });
  }
  onSettled(() => {
    void props.api
      .providers()
      .then(async (reply) => {
        setProviders(reply.providers);
        setProvider(reply.default_provider);
        defaultEffort = reply.default_reasoning_effort || "";
        publish({ provider: reply.default_provider, model: "", effort: "" });
        await loadModels(
          reply.default_provider,
          reply.default_model || "",
          defaultEffort,
        );
      })
      .catch((cause) =>
        props.onError(
          `Init failed: ${cause instanceof Error ? cause.message : String(cause)}. Check the API key field.`,
        ),
      );
  });

  return (
    <div class="model-grid">
      <fieldset class="field provider-field">
        <legend class="label">Provider</legend>
        <div class="segmented">
          <For each={providers()}>
            {(item) => (
              <label>
                <input
                  type="radio"
                  name="provider"
                  value={item}
                  checked={provider() === item}
                  onChange={() => changeProvider(item)}
                />
                <span>{item}</span>
              </label>
            )}
          </For>
        </div>
      </fieldset>
      <div class="field model-field">
        <label class="label" for="model">
          Model
        </label>
        <div class="with-action">
          <select
            id="model"
            name="model"
            value={model()}
            onChange={(event) => changeModel(event.currentTarget.value)}
          >
            <option value="">Provider default</option>
            <For each={groups()}>
              {([group, items]) => (
                <optgroup label={group}>
                  <For each={items}>
                    {(item) => (
                      <option value={item.id}>{item.label || item.id}</option>
                    )}
                  </For>
                </optgroup>
              )}
            </For>
          </select>
          <button
            type="button"
            class="icon-btn"
            disabled={refreshing()}
            onClick={() => void loadModels(provider(), model(), effort())}
            title="Reload models"
            aria-label="Reload models"
          >
            <svg
              class={refreshing() ? "spin" : ""}
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              aria-hidden="true"
            >
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
            </svg>
          </button>
        </div>
      </div>
      <div class="field effort-field">
        <label class="label" for="effort">
          Effort
        </label>
        <select
          id="effort"
          name="reasoning_effort"
          disabled={efforts().length === 0}
          value={effort()}
          onChange={(event) => changeEffort(event.currentTarget.value)}
        >
          <option value="">Default</option>
          <For each={efforts()}>
            {(item) => <option value={item}>{item}</option>}
          </For>
        </select>
      </div>
    </div>
  );
}
