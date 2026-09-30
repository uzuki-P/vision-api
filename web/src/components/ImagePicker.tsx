import { Show, createSignal, onSettled } from "solid-js";
import { formatBytes } from "../format";

const acceptedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const maxBytes = 12 * 1024 * 1024;

export function ImagePicker(props: {
  scanning: boolean;
  onFileChange: (file: File | null) => void;
  onError: (message: string) => void;
}) {
  const [file, setFile] = createSignal<File | null>(null);
  const [imageUrl, setImageUrl] = createSignal("");
  const [dimensions, setDimensions] = createSignal("");
  const [dragging, setDragging] = createSignal(false);
  let input!: HTMLInputElement;
  let dialog!: HTMLDialogElement;
  let dragDepth = 0;

  function selectImage(next: File | null | undefined) {
    if (!next) return;
    if (!acceptedTypes.has(next.type)) {
      props.onError(
        `Unsupported type: ${next.type || "unknown"}. Use PNG, JPEG, WebP, or GIF.`,
      );
      return;
    }
    if (next.size === 0 || next.size > maxBytes) {
      props.onError("Image must be between 1 byte and 12 MB.");
      return;
    }
    props.onError("");
    if (imageUrl()) URL.revokeObjectURL(imageUrl());
    const url = URL.createObjectURL(next);
    setFile(next);
    setImageUrl(url);
    setDimensions("");
    props.onFileChange(next);
    const probe = new Image();
    probe.onload = () => {
      if (imageUrl() === url)
        setDimensions(`${probe.naturalWidth} × ${probe.naturalHeight}`);
    };
    probe.src = url;
  }

  function clearImage() {
    if (imageUrl()) URL.revokeObjectURL(imageUrl());
    setFile(null);
    setImageUrl("");
    setDimensions("");
    props.onFileChange(null);
    input.value = "";
  }

  function hasFiles(event: DragEvent) {
    return event.dataTransfer?.types.includes("Files") ?? false;
  }
  function onDragEnter(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  }
  function onDragOver(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
  }
  function onDragLeave(event: DragEvent) {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  }
  function onDrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    selectImage(event.dataTransfer?.files[0]);
  }
  function onPaste(event: ClipboardEvent) {
    const item = Array.from(event.clipboardData?.items ?? []).find((entry) =>
      entry.type.startsWith("image/"),
    );
    if (item) selectImage(item.getAsFile());
  }

  onSettled(() => {
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      if (imageUrl()) URL.revokeObjectURL(imageUrl());
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  });

  return (
    <section class="stage-wrap" aria-label="Image">
      <input
        ref={(element) => {
          input = element;
        }}
        class="visually-hidden"
        type="file"
        id="image-input"
        name="image"
        tabindex="-1"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => selectImage(event.currentTarget.files?.[0])}
      />
      <div
        class={{
          stage: true,
          drag: dragging(),
          scanning: props.scanning,
          filled: !!file(),
        }}
      >
        <span class="bracket tl" />
        <span class="bracket tr" />
        <span class="bracket bl" />
        <span class="bracket br" />
        <Show
          when={file()}
          fallback={
            <div class="stage-empty" onClick={() => input.click()}>
              <p class="stage-title">Drop an image here</p>
              <p class="stage-sub">
                or paste from the clipboard, or{" "}
                <button
                  type="button"
                  class="link-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    input.click();
                  }}
                >
                  choose a file
                </button>
              </p>
              <p class="stage-fine">PNG, JPEG, WebP, or GIF up to 12 MB</p>
            </div>
          }
        >
          <button
            type="button"
            class="frame"
            title="Enlarge"
            aria-label="Enlarge image"
            onClick={() => dialog.showModal()}
          >
            <img src={imageUrl()} alt="" />
            <span class="scan" aria-hidden="true" />
          </button>
          <Show when={dimensions()}>
            <span class="dims" aria-hidden="true">
              {dimensions()}
            </span>
          </Show>
        </Show>
      </div>
      <Show when={file()}>
        <div class="stage-bar">
          <span class="file-name" title={file()?.name}>
            {file()?.name || "pasted image"}
          </span>
          <span class="file-size">{formatBytes(file()!.size)}</span>
          <span class="spacer" />
          <button
            type="button"
            class="ghost-btn"
            disabled={props.scanning}
            onClick={() => input.click()}
          >
            Replace
          </button>
          <button
            type="button"
            class="ghost-btn danger"
            disabled={props.scanning}
            onClick={clearImage}
          >
            Remove
          </button>
        </div>
      </Show>
      <dialog
        class="viewer"
        ref={(element) => {
          dialog = element;
        }}
        onClick={(event) => {
          if (event.target === dialog) dialog.close();
        }}
      >
        <div class="viewer-bar">
          <span class="viewer-title">{file()?.name || "pasted image"}</span>
          <span class="spacer" />
          <button
            type="button"
            class="icon-btn"
            onClick={() => dialog.close()}
            aria-label="Close preview"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                stroke-width="1.6"
              />
            </svg>
          </button>
        </div>
        <img class="viewer-img" src={imageUrl()} alt="Selected image" />
        <dl class="viewer-meta">
          <dt>type</dt>
          <dd>{file()?.type}</dd>
          <dt>size</dt>
          <dd>
            {file()
              ? `${formatBytes(file()!.size)} (${file()!.size.toLocaleString("en-US")} bytes)`
              : ""}
          </dd>
          <dt>pixels</dt>
          <dd>{dimensions() || "loading…"}</dd>
        </dl>
      </dialog>
    </section>
  );
}
