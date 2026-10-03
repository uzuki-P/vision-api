import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const token = "12345678901234567890123456789012";
const workDir = await mkdtemp(path.join(tmpdir(), "vision-api-test-"));
// A fake Claude Code CLI. The OpenCode adapter needs a running v2 server,
// while the Claude adapter only reads stream-json lines from stdout.
const providerPath = path.join(workDir, "fake-claude");
await writeFile(
  providerPath,
  '#!/bin/sh\ncat >/dev/null\nsleep 2\nprintf \'%s\\n\' \'{"type":"result","is_error":false,"result":"{\\"ok\\":true}"}\'\n',
);
await chmod(providerPath, 0o700);
const port = await new Promise<number>((resolve) => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop();
  resolve(port);
});
const server = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: path.join(import.meta.dir, ".."),
  env: {
    ...process.env,
    API_TOKEN: token,
    PORT: String(port),
    REQUEST_TIMEOUT_MS: "1000",
    JOB_TIMEOUT_MS: "10000",
    DEFAULT_PROVIDER: "claude",
    CLAUDE_BIN: providerPath,
    JOB_DATA_DIR: path.join(workDir, "jobs"),
  },
  stdout: "pipe",
  stderr: "pipe",
});
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}` };

function imageForm(): FormData {
  const form = new FormData();
  form.set("instruction", "Return a JSON object with ok true");
  form.set(
    "image",
    new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "test.png", {
      type: "image/png",
    }),
  );
  return form;
}

async function ready() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("Test API did not start");
}

afterAll(async () => {
  server.kill();
  await server.exited;
  await rm(workDir, { recursive: true, force: true });
});

test("a slow scan times out synchronously but completes as a job", async () => {
  await ready();
  expect((await fetch(`${base}/v1/providers`)).status).toBe(401);
  const sync = await fetch(`${base}/v1/analyze`, {
    method: "POST",
    headers,
    body: imageForm(),
  });
  expect(sync.status).toBe(504);
  expect((await sync.json()).error.code).toBe("provider_timeout");

  const started = performance.now();
  const submitted = await fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers,
    body: imageForm(),
  });
  const job = await submitted.json();
  expect(submitted.status).toBe(202);
  expect(performance.now() - started).toBeLessThan(1000);
  let result = job;
  for (let i = 0; i < 30; i++) {
    if (result.status === "succeeded" || result.status === "failed") break;
    await Bun.sleep(100);
    result = await (
      await fetch(`${base}/v1/jobs/${job.id}`, { headers })
    ).json();
  }
  expect(result.status).toBe("succeeded");
  expect(result.response.result).toEqual({ ok: true });
});

test("invalid configuration fails before the server starts", async () => {
  const invalid = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, API_TOKEN: "short", PORT: "not-a-port" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    invalid.exited,
    new Response(invalid.stderr).text(),
  ]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("API_TOKEN");
  expect(stderr).toContain("PORT");
});
