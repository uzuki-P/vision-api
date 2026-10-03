# Setup

Run these commands from the repository root. The API and playground bind to loopback. Linux with systemd is required only for the optional user service.

## Install prerequisites

Install [Bun](https://bun.sh/docs/installation) and [just](https://just.systems/man/en/chapter_4.html). Install at least one CLI backend using the [OpenCode installation instructions](https://opencode.ai/docs/) the [official Codex CLI instructions](https://developers.openai.com/codex/cli/), or the [Claude Code setup guide](https://code.claude.com/docs/en/setup). The API starts without every CLI, but requests need the selected backend installed and authenticated.

Check your tools and install the locked project dependencies:

```sh
bun --version
just --version
bun install --frozen-lockfile
just --list
```

Check the selected CLI before proceeding:

```sh
# For OpenCode
opencode --version
opencode run --help
opencode serve --help

# For Codex
codex --version
codex exec --help
codex debug models --help

# For Claude Code
claude --version
claude --help
```

The OpenCode adapter requires OpenCode v2. It uses `serve --stdio --port 0`, the server's `/api/model`, `/api/model/default`, `/api/credential`, and `/api/session` routes, and `run --server --format json --agent --file --model`. Reasoning effort goes in the model reference as `provider/model#variant`. OpenCode v1 is not supported. The repository does not pin or install a CLI version. See [OpenCode v2](../README.md#opencode-v2) for how each request is isolated.

The Codex adapter requires `exec --ephemeral --ignore-user-config --skip-git-repo-check --sandbox read-only --cd --image --output-schema --output-last-message --json`. Model discovery also requires `debug models --bundled`. Check these commands when changing CLI versions.

The Claude Code adapter requires `--print --safe-mode --tools "" --strict-mcp-config --no-session-persistence --system-prompt --input-format stream-json --output-format stream-json --verbose`, plus `--model` and `--effort` when set. It sends the image as a base64 block in a stream-json user message on stdin.

## Authenticate a provider

Authenticate under the same OS account that will run the API. Follow [OpenCode's authentication instructions](https://opencode.ai/docs/cli/#auth) for its supported providers:

```sh
opencode auth login
```

The API reads OpenCode credentials from `~/.local/share/opencode/opencode.db`, or under `$XDG_DATA_HOME/opencode` when configured. If they live elsewhere, set `OPENCODE_SOURCE_DATA_DIR` in `.env` to the directory containing `opencode.db`. The adapter opens the database read-only and adds the credentials to each request's private OpenCode server. Logging in with `opencode auth login` takes effect on the next request without a restart. OpenCode's free-tier models do not work through this service, so log in to at least one provider with image models.

For Codex, use the [documented login commands](https://developers.openai.com/codex/cli/reference/#codex-login):

```sh
codex login
codex login status
```

On a host without a browser, use `codex login --device-auth`. Codex reuses its stored credentials, but this API disables loading its user `config.toml`. Set model and reasoning defaults in this project's `.env` instead.

For Claude Code, sign in once with `claude` and follow the login prompt, or run `claude setup-token` on a host without a browser. The adapter reads credentials from `~/.claude`, or from `CLAUDE_CONFIG_DIR` when set. Requests count against that account's Claude subscription or API usage.

Choose a provider account and model that accept images. Provider credentials authenticate the CLI to its model provider. `API_TOKEN` below authenticates callers to this API and is a separate secret.

## Create local configuration

For a new checkout, create `.env` from the example with a random 64-character token and file permissions `0600`:

```sh
bun -e 'import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const text = readFileSync(".env.example", "utf8").replace(
  /^API_TOKEN=.*$/m,
  `API_TOKEN=${randomBytes(32).toString("hex")}`,
);
writeFileSync(".env", text, { mode: 0o600, flag: "wx" });'
```

This command refuses to overwrite an existing `.env`. If you already have one, edit it and run `chmod 600 .env`. Keep `.env` and CLI credential files out of Git. The example token is a placeholder and is too short to pass startup validation. Bun loads `.env` when the API starts.

Review these settings before starting:

| Setting                                   | What to configure                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_PROVIDER`                        | `opencode` by default. Set `codex` or `claude` if that is your installed backend.                                             |
| `HOST`                                    | Keep `127.0.0.1`. Only `127.0.0.1` and `localhost` pass validation.                                                           |
| `PORT`                                    | API port, default `3000`. Choose an unused port.                                                                              |
| `WEB_PORT`                                | Playground port, default `27182`. Choose a different unused port.                                                             |
| `API_TOKEN`                               | Random secret of at least 32 characters.                                                                                      |
| `OPENCODE_BIN`, `CODEX_BIN`, `CLAUDE_BIN` | Executable names on `PATH`, or absolute paths to compatible CLIs.                                                             |
| `DEFAULT_MODEL`                           | Optional model ID. OpenCode IDs use `provider/model`; Codex uses its model ID; Claude Code accepts an alias or full model ID. |
| `DEFAULT_REASONING_EFFORT`                | Optional effort supported by the selected model. Leave empty initially.                                                       |
| `ALLOWED_MODELS`                          | Optional comma-separated model IDs. When set, supply an allowed model per request or through `DEFAULT_MODEL`.                 |
| `JOB_DATA_DIR`                            | Optional private directory for job data. Defaults to `~/.local/state/vision-api/jobs`.                                        |
| `CORS_ORIGINS`                            | Leave empty for the playground proxy. Direct browser clients need exact origins without paths or trailing slashes.            |

The remaining limits and timeout settings are documented in [.env.example](../.env.example). Completed job results persist for 24 hours by default. Choose a job directory writable by the service account.

## Start and verify the API

Run the API in one terminal:

```sh
just api
```

For automatic reloads while editing, use `just api-watch`. If a service already runs on the configured port, use that process for verification.

In another terminal at the repository root, load your trusted local configuration and check health and authentication:

```sh
set -a
source .env
set +a

curl --fail-with-body "http://127.0.0.1:${PORT:-3000}/healthz"
curl --fail-with-body "http://127.0.0.1:${PORT:-3000}/v1/providers" \
  -H "Authorization: Bearer $API_TOKEN"
curl --fail-with-body "http://127.0.0.1:${PORT:-3000}/v1/models?provider=${DEFAULT_PROVIDER:-opencode}" \
  -H "Authorization: Bearer $API_TOKEN"
```

Health should return `{"ok":true}`. Provider settings verify authentication. Model discovery checks the CLI catalog, but does not prove that a model request will succeed. Choose a returned model ID for `DEFAULT_MODEL` or a request's `model` field.

To verify an actual image request, use the repository's sample icon. This calls your model provider and uses its account quota:

```sh
curl --fail-with-body "http://127.0.0.1:${PORT:-3000}/v1/analyze" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F 'instruction=Describe the image as a JSON object with a description field.' \
  -F 'image=@assets/vision-api-icon.png'
```

If `ALLOWED_MODELS` is set without `DEFAULT_MODEL`, add `-F 'model=YOUR_ALLOWED_MODEL_ID'`. A successful response contains `_metadata` and a JSON `result`. See the [API documentation](../README.md#api) for asynchronous jobs and request options.

## Start the playground

Keep the API running and start the UI from a second terminal:

```sh
just web-watch
```

Open `http://127.0.0.1:27182`, or the port set in `WEB_PORT`. `just web` builds the UI and serves it without file watching. Both modes require the API as a separate process and proxy requests to its configured `PORT`. Leave the UI's API key field empty to use the server's `.env` token. CORS configuration is unnecessary for this proxy.

## Run as a user service

The supplied [systemd unit](../deploy/vision-api.service) assumes the checkout is at `~/projects/_sandbox/vision-api` and Bun is at `~/.vite-plus/bin/bun`. It also sets its own `PATH`. If your installation differs, adjust `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, and `PATH` in your installed unit or a systemd override. Set absolute CLI paths in `.env` if the unit's `PATH` does not include them. User services do not load your interactive shell configuration.

After validating the API in the foreground, stop that foreground process before enabling the service on the same port. Follow the [service installation and control commands](../README.md#service-control). The unit runs only the API. Start the playground separately when needed.

The service starts with your systemd user manager, normally at login. If it must run before login and stay running after logout, configure lingering for that OS account according to your host's policy. After editing `.env`, restart the API and any running playground so they reload their settings.

## Troubleshooting

| Symptom                                        | Check                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup rejects `API_TOKEN`                    | Replace the example placeholder with a secret at least 32 characters long.                                                                     |
| The port is already in use                     | Check for an existing API or playground process. Reuse it or choose another port.                                                              |
| HTTP 401                                       | Use the same `API_TOKEN` as the running API. Restart processes after rotating it.                                                              |
| Playground returns `upstream_unreachable`      | Start the API and match the playground's `PORT` to the API's port.                                                                             |
| CLI is missing or rejects a flag               | Check its help output and set the appropriate executable path. The OpenCode adapter needs v2, and later v2 releases may change its server API. |
| OpenCode model listing cannot read credentials | Authenticate as the service account and check that `opencode.db` exists in `OPENCODE_SOURCE_DATA_DIR` or `$XDG_DATA_HOME/opencode`.            |
| Model listing works but scans fail             | Check provider login, image support, model access, and any reasoning effort override.                                                          |
| systemd cannot start Bun or the CLI            | Check the unit's executable paths and `PATH`, then inspect `journalctl --user -u vision-api`.                                                  |

For development checks, run `bun run check`, `bun test`, and `bun run format:check` from the repository root. See the [access control notes](../README.md#access-control) before exposing the API or playground through a private route.
