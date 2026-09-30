import { Show, createSignal, onSettled } from "solid-js";

const acceptedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const maxBytes = 12 * 1024 * 1024;

function formatBytes(size: number) {
  return size >= 1048576
    ? `${(size / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function ImagePicker(props: {
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
        setDimensions(`${probe.naturalWidth}×${probe.naturalHeight}`);
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
    <>
      <label for="image-input">
        <span class="name">Image</span>
      </label>
      <div
        class={`viewfinder ${dragging() ? "drag" : ""}`}
        onClick={() => input.click()}
      >
        <input
          ref={(element) => {
            input = element;
          }}
          type="file"
          id="image-input"
          name="image"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => selectImage(event.currentTarget.files?.[0])}
        />
        <span class="tick tl" />
        <span class="tick tr" />
        <span class="tick bl" />
        <span class="tick br" />
        <Show when={!file()}>
          <div class="hint">
            <b>Drop an image anywhere</b>
            <span class="sub">
              or click to browse · paste works too · PNG JPEG WebP GIF · 12 MB
            </span>
          </div>
        </Show>
        <Show when={file()}>
          <div class="preview" style={{ display: "block" }}>
            <img
              src={imageUrl()}
              alt="Selected image preview"
              title="Click to enlarge"
              onClick={(event) => {
                event.stopPropagation();
                dialog.showModal();
              }}
            />
            <button
              type="button"
              class="expand"
              title="Enlarge"
              aria-label="Enlarge preview"
              onClick={(event) => {
                event.stopPropagation();
                dialog.showModal();
              }}
            >
              ⤢
            </button>
            <button
              type="button"
              class="remove"
              onClick={(event) => {
                event.stopPropagation();
                clearImage();
              }}
            >
              remove
            </button>
            <div class="meta">
              <span>{file()?.name || "pasted image"}</span>
              <span>{formatBytes(file()!.size)}</span>
              <span>{dimensions()}</span>
            </div>
          </div>
        </Show>
      </div>
      <dialog
        id="preview-dialog"
        ref={(element) => {
          dialog = element;
        }}
        onClick={(event) => {
          if (event.target === dialog) dialog.close();
        }}
      >
        <div class="dialog-bar">
          <span class="dialog-title">{file()?.name || "pasted image"}</span>
          <span class="spacer" />
          <button
            type="button"
            class="icon-btn small"
            onClick={() => dialog.close()}
            aria-label="Close preview"
          >
            ×
          </button>
        </div>
        <img id="dialog-img" src={imageUrl()} alt="Enlarged image preview" />
        <div class="dialog-meta">
          <span class="k">name</span>
          <span class="v">{file()?.name}</span>
          <span class="k">type</span>
          <span class="v">{file()?.type}</span>
          <span class="k">size</span>
          <span class="v">
            {file()
              ? `${formatBytes(file()!.size)} (${file()!.size.toLocaleString("en-US")} bytes)`
              : ""}
          </span>
          <span class="k">dimensions</span>
          <span class="v">{dimensions() || "loading…"}</span>
        </div>
      </dialog>
    </>
  );
}
