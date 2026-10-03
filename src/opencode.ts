import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { providerEnvironment } from "./cli";
import { openCodeBin, openCodeSourceDataDir } from "./config";
import { ProviderTimeout } from "./types";

export type OpenCodeModel = {
  id: string;
  providerID: string;
  name?: string;
  enabled?: boolean;
  capabilities?: { input?: string[] };
  variants?: Array<{ id: string }>;
};

export type OpenCodeServer = {
  url: string;
  // Integrations with stored credentials. Other providers, such as OpenCode's
  // free tier, reject requests from outside the OpenCode apps.
  providers: Set<string>;
  // Environment for `opencode run --server`, including the server password.
  env: Record<string, string>;
  models: () => Promise<OpenCodeModel[]>;
  defaultModel: () => Promise<OpenCodeModel | null>;
  // `run --format json` exits before the step-finish event, so token usage
  // comes from the session record instead.
  sessionTokens: (sessionID: string) => Promise<OpenCodeTokens | null>;
};

export type OpenCodeTokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

type StoredCredential = {
  integrationID: string;
  label: string;
  value: unknown;
};

const visionPermissions = [{ action: "*", resource: "*", effect: "deny" }];
const visionConfig = JSON.stringify({
  default_agent: "vision-api",
  update: "disable",
  share: "disabled",
  snapshots: false,
  permissions: visionPermissions,
  agents: {
    "vision-api": {
      description: "Extract structured information from the attached image",
      mode: "primary",
      system:
        "You are a vision extraction assistant. Analyze only the attached image and caller instruction. Return one JSON object. Never use tools.",
      permissions: visionPermissions,
    },
  },
});

export function isUsableModel(
  model: OpenCodeModel,
  providers: Set<string>,
): boolean {
  return (
    model.enabled !== false &&
    providers.has(model.providerID) &&
    model.capabilities?.input?.includes("image") === true
  );
}

// OpenCode v2 runs sessions on a server. Each call starts a private server
// with its own HOME and XDG directories under `dir`, so it never loads the
// user's config, MCP servers, skills, ~/.claude, or session history. Only the
// stored credentials are copied in, through the server's credential API.
export async function withOpenCodeServer<T>(
  dir: string,
  timeoutMs: number,
  use: (server: OpenCodeServer) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const credentials = readCredentials();
  if (credentials.length === 0)
    throw new Error("No OpenCode credentials found. Run opencode auth login.");

  const root = path.join(dir, "opencode-home");
  const env: Record<string, string> = {
    ...providerEnvironment(),
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_PASSWORD: randomBytes(32).toString("base64url"),
    OPENCODE_CONFIG_CONTENT: visionConfig,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
  };
  await mkdir(root, { recursive: true, mode: 0o700 });

  const child = Bun.spawn([openCodeBin, "serve", "--stdio", "--port", "0"], {
    cwd: dir,
    env,
    // The server treats EOF on stdin as the end of its lease and exits.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stop = async () => {
    try {
      void child.stdin.end();
    } catch {
      // The server already exited and closed its stdin.
    }
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }
  };

  try {
    const url = await readServerUrl(child.stdout, deadline);
    const authorization = `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}`;
    const location = `location[directory]=${encodeURIComponent(dir)}`;
    const request = async (pathname: string, init: RequestInit = {}) => {
      const response = await fetch(`${url}${pathname}`, {
        ...init,
        headers: {
          authorization,
          "content-type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!response.ok)
        throw new Error(
          `OpenCode server returned HTTP ${response.status} for ${pathname}`,
        );
      return (await response.json()) as { data: unknown };
    };

    for (const credential of credentials)
      await request("/api/credential", {
        method: "POST",
        body: JSON.stringify({ ...credential, activate: true }),
      });

    const models = async () =>
      (await request(`/api/model?${location}`)).data as OpenCodeModel[];
    const providers = new Set(credentials.map((item) => item.integrationID));
    const catalogStarted = Date.now();
    // The model catalog loads after the server reports its URL. Requests sent
    // before it finishes fail with "Model unavailable". Wait until every
    // credentialed provider has models, or a few seconds if one never does.
    while (true) {
      const loaded = await models();
      if (
        [...providers].every((id) =>
          loaded.some((model) => model.providerID === id),
        ) ||
        (loaded.length > 0 && Date.now() - catalogStarted > 10_000)
      )
        break;
      if (Date.now() >= deadline) throw new ProviderTimeout();
      await Bun.sleep(250);
    }

    return await use({
      url,
      providers,
      env,
      models,
      defaultModel: async () =>
        ((await request(`/api/model/default?${location}`))
          .data as OpenCodeModel | null) ?? null,
      sessionTokens: async (sessionID) =>
        (
          (await request(`/api/session/${encodeURIComponent(sessionID)}`))
            .data as { tokens?: OpenCodeTokens } | null
        )?.tokens ?? null,
    });
  } finally {
    await stop();
  }
}

// Both the CLI and this service read credentials from the same database, so a
// new `opencode auth login` applies without restarting the service.
function readCredentials(): StoredCredential[] {
  const dbPath = path.join(openCodeSourceDataDir(), "opencode.db");
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    throw new Error(`Cannot open OpenCode credential database at ${dbPath}`);
  }
  try {
    const rows = db
      .query(
        "SELECT integration_id, label, value FROM credential WHERE integration_id IS NOT NULL ORDER BY integration_id, active DESC, time_updated DESC",
      )
      .all() as Array<{ integration_id: string; label: string; value: string }>;
    const chosen = new Map<string, StoredCredential>();
    for (const row of rows) {
      if (chosen.has(row.integration_id)) continue;
      try {
        chosen.set(row.integration_id, {
          integrationID: row.integration_id,
          label: row.label,
          value: JSON.parse(row.value),
        });
      } catch {
        // Skip a credential whose value is not valid JSON.
      }
    }
    return [...chosen.values()];
  } finally {
    db.close();
  }
}

async function readServerUrl(
  stdout: ReadableStream<Uint8Array>,
  deadline: number,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderTimeout()),
      Math.max(1, deadline - Date.now()),
    );
  });
  try {
    while (!buffered.includes("\n")) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) throw new Error("OpenCode server exited before it was ready");
      buffered += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  // Keep draining stdout so later server writes cannot block on a full pipe.
  void (async () => {
    while (!(await reader.read().catch(() => ({ done: true }))).done);
  })();
  const ready: unknown = JSON.parse(buffered.slice(0, buffered.indexOf("\n")));
  const url = (ready as { url?: unknown })?.url;
  if (typeof url !== "string")
    throw new Error("OpenCode server did not report its URL");
  return url;
}
