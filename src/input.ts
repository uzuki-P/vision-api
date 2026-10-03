import {
  HttpError,
  type Provider,
  type ImageInput,
  type ScanInput,
} from "./types";
import {
  defaultEffort,
  defaultModel,
  defaultProvider,
  maxImageBytes,
  parseProvider,
  validateModel,
} from "./config";

const maxRequestBytes = maxImageBytes + 128_000;
const imageTypes = new Map([
  [
    "image/png",
    {
      extension: ".png",
      signature: (bytes: Uint8Array) =>
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a,
    },
  ],
  [
    "image/jpeg",
    {
      extension: ".jpg",
      signature: (bytes: Uint8Array) =>
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff,
    },
  ],
  [
    "image/webp",
    {
      extension: ".webp",
      signature: (bytes: Uint8Array) =>
        bytes.length >= 12 &&
        ascii(bytes, 0, 4) === "RIFF" &&
        ascii(bytes, 8, 4) === "WEBP",
    },
  ],
  [
    "image/gif",
    {
      extension: ".gif",
      signature: (bytes: Uint8Array) =>
        bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)),
    },
  ],
]);

export type UploadInput = {
  instruction: string;
  provider?: Provider;
  model?: string;
  reasoningEffort?: string;
  image: ImageInput;
};

export function resolveScanInput(
  requestId: string,
  input: UploadInput,
): ScanInput {
  const model = input.model ?? defaultModel;
  validateModel(model);
  return {
    requestId,
    provider: input.provider ?? defaultProvider,
    model,
    effort: input.reasoningEffort ?? defaultEffort,
    instruction: input.instruction,
    image: input.image,
  };
}

export async function readInput(request: Request): Promise<UploadInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new HttpError(415, "multipart_required", "Send multipart/form-data");
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxRequestBytes) {
    throw new HttpError(
      413,
      "request_too_large",
      "Request exceeds the configured upload limit",
    );
  }

  const bodyBytes = await readLimitedBody(request, maxRequestBytes);
  let form: FormData;
  try {
    form = await new Request("http://vision-api.local/v1/analyze", {
      method: "POST",
      headers: request.headers,
      body: new Uint8Array(bodyBytes).buffer,
    }).formData();
  } catch {
    throw new HttpError(
      400,
      "invalid_multipart",
      "Could not parse multipart form data",
    );
  }

  const allowedKeys = new Set([
    "instruction",
    "image",
    "provider",
    "model",
    "reasoning_effort",
  ]);
  const seenKeys = new Set<string>();
  for (const key of form.keys()) {
    if (!allowedKeys.has(key))
      throw new HttpError(400, "unknown_field", `Unsupported field: ${key}`);
    if (seenKeys.has(key))
      throw new HttpError(
        400,
        "duplicate_field",
        `Field may only appear once: ${key}`,
      );
    seenKeys.add(key);
  }

  const instruction = form.get("instruction");
  if (
    typeof instruction !== "string" ||
    instruction.trim().length === 0 ||
    instruction.length > 10_000
  ) {
    throw new HttpError(
      400,
      "invalid_instruction",
      "instruction must contain 1 to 10000 characters",
    );
  }

  const image = form.get("image");
  if (!(image instanceof File))
    throw new HttpError(
      400,
      "image_required",
      "image must be an uploaded file",
    );
  if (image.size === 0 || image.size > maxImageBytes) {
    throw new HttpError(
      413,
      "invalid_image_size",
      `Image must be between 1 and ${maxImageBytes} bytes`,
    );
  }

  const bytes = new Uint8Array(await image.arrayBuffer());
  const detectedImage = [...imageTypes.entries()].find(([, definition]) =>
    definition.signature(bytes),
  );
  if (!detectedImage)
    throw new HttpError(
      415,
      "unsupported_image",
      "Image must be a PNG, JPEG, WebP, or GIF file",
    );
  const [mime, definition] = detectedImage;
  if (
    image.type &&
    image.type !== "application/octet-stream" &&
    image.type !== mime
  ) {
    throw new HttpError(
      415,
      "image_type_mismatch",
      "Image content does not match its declared media type",
    );
  }

  const providerValue = optionalFormString(form, "provider", 40);
  const model = optionalFormString(form, "model", 180);
  const reasoningEffort = optionalFormString(form, "reasoning_effort", 40);
  const provider = providerValue
    ? parseRequestProvider(providerValue)
    : undefined;
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new HttpError(
      400,
      "invalid_model",
      "model contains unsupported characters",
    );
  }
  if (reasoningEffort && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(reasoningEffort)) {
    throw new HttpError(
      400,
      "invalid_reasoning_effort",
      "reasoning_effort contains unsupported characters",
    );
  }

  return {
    instruction: instruction.trim(),
    provider,
    model,
    reasoningEffort,
    image: { bytes, mime, extension: definition.extension },
  };
}

function optionalFormString(
  form: FormData,
  key: string,
  maxLength: number,
): string | undefined {
  const value = form.get(key);
  if (value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(
      400,
      `invalid_${key}`,
      `${key} must be at most ${maxLength} characters`,
    );
  }
  return value.trim();
}

export function parseRequestProvider(value: string): Provider {
  try {
    return parseProvider(value);
  } catch {
    throw new HttpError(
      400,
      "invalid_provider",
      "provider must be opencode, codex, or claude",
    );
  }
}

async function readLimitedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(
          413,
          "request_too_large",
          "Request exceeds the configured upload limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}
