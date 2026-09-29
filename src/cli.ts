import { ProviderOutputTooLarge, ProviderTimeout } from "./types";

const maxCliOutputBytes = 4_000_000;

export async function runCli(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: { ...providerEnvironment(), ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      collect(child.stdout, maxCliOutputBytes, () => child.kill()),
      collect(child.stderr, maxCliOutputBytes, () => child.kill()),
    ]);
    if (timedOut) throw new ProviderTimeout();
    if (exitCode !== 0) throw new Error("Provider CLI exited unsuccessfully");
    return { stdout, stderr };
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onTooLarge: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        onTooLarge();
        throw new ProviderOutputTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function providerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "CODEX_HOME",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.TERM = "dumb";
  return env;
}
