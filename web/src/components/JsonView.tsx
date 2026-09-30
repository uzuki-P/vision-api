import { createMemo } from "solid-js";

const token =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlight(text: string) {
  const parts: Array<string | { kind: string; text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(token)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    if (match[1]) {
      parts.push({ kind: match[2] ? "key" : "str", text: match[1] });
      if (match[2]) parts.push(match[2]);
    } else {
      parts.push({ kind: match[3] ? "lit" : "num", text: match[0] });
    }
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function JsonView(props: { value: unknown; label: string }) {
  const nodes = createMemo(() =>
    highlight(JSON.stringify(props.value, null, 2) ?? "null").map((part) =>
      typeof part === "string" ? (
        part
      ) : (
        <span class={`j-${part.kind}`}>{part.text}</span>
      ),
    ),
  );
  return (
    <pre class="code" tabindex="0" aria-label={props.label}>
      <code>{nodes()}</code>
    </pre>
  );
}
