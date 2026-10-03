# Vision API

A small REST service for sending an instruction and image to OpenCode or Codex CLI. It binds to `127.0.0.1`, requires a bearer token for API calls, and does not keep uploaded images after each request.

## Setup

Follow the [setup guide](docs/setup.md) to install dependencies, authenticate a CLI provider, create a private `.env`, and verify the API and playground. It also covers CLI compatibility, systemd paths, and common startup errors.

## Service control

The user systemd service runs the API in the background and restarts it after a failure. Bun remains the runtime. OpenCode and Codex use their existing host installations and credentials.

Complete the [setup guide](docs/setup.md#run-as-a-user-service) first. The supplied unit expects this checkout at `~/projects/_sandbox/vision-api` and Bun at `~/.vite-plus/bin/bun`. Install the unit once:

```sh
mkdir -p ~/.config/systemd/user
ln -s ~/projects/_sandbox/vision-api/deploy/vision-api.service ~/.config/systemd/user/vision-api.service
systemctl --user daemon-reload
systemctl --user enable --now vision-api
```

The enabled unit starts when your systemd user manager starts, normally at login. Running it before login or after logout requires lingering for your OS account. Disable it with `systemctl --user disable --now vision-api`.

```sh
systemctl --user start vision-api
systemctl --user stop vision-api
systemctl --user restart vision-api
systemctl --user status vision-api
journalctl --user -u vision-api -f
```

The unit is linked from `deploy/vision-api.service` under `~/.config/systemd/user/`. After changing `.env`, restart the service. The local `.env` contains the API token and selected port. Keep it private.

Edit `.env` to change the defaults. `DEFAULT_MODEL` and `DEFAULT_REASONING_EFFORT` can stay empty to use the CLI's defaults. Codex runs with `--ignore-user-config`, so this endpoint does not load model settings from its user `config.toml`. OpenCode uses its model variant for reasoning effort. Codex uses `model_reasoning_effort`. Not every model accepts every effort value.

You can also select these fields per request. Set `ALLOWED_MODELS` to a comma-separated list before sharing the service if callers should be limited to specific models.

OpenCode runs with all agent tools denied and a temporary data directory, including for its session history. Codex runs with its read-only sandbox, an ephemeral session, and a fresh temporary working directory. The service removes each request's temporary files when the CLI exits. The selected model provider still receives the instruction and image, and its own data retention rules apply.

Codex is a shell-capable agent CLI. Its read-only sandbox prevents writes, but it is not a substitute for running the service in an isolated OS account or container if callers are not fully trusted. OpenCode's tools are denied for this endpoint.

## Test playground

`bun run web:dev` starts the Solid 2 RC test UI on `http://127.0.0.1:$WEB_PORT` (default 27182). Vite proxies `/api/*` to the API on `$PORT`, attaching the `.env` API token when the page's API key field is empty. `bun run web` builds the UI and serves the files with the same API proxy. Scans use the job endpoint and poll every three seconds. A page reload resumes polling the current job. Stop polling ends the page's checks; the submitted job continues running. Each run stays in the session history with its image thumbnail, model, and result, so you can compare models on the same image. The history clears on reload. Publish it with a named dev route for tailnet access:

```sh
cd ~/docker/dev-router && just specific vision-api-preview 27182
```

To let a browser page call the API directly instead of through the proxy, add the page's exact origin to `CORS_ORIGINS` in `.env` (comma-separated list) and restart the service. The API answers preflight `OPTIONS` requests and echoes allowlisted origins in `Access-Control-Allow-Origin`; with `CORS_ORIGINS` empty, no CORS headers are sent.

## API

`POST /v1/analyze` accepts `multipart/form-data` with these fields:

- `instruction`: task for the model
- `image`: PNG, JPEG, WebP, or GIF image
- `provider`: optional `opencode` or `codex`
- `model`: optional model ID
- `reasoning_effort`: optional provider effort or variant

For work that can take longer, send the same form to `POST /v1/jobs`. It returns HTTP 202 with a job ID and a `Location` header. Poll `GET /v1/jobs/{id}` with the bearer token. The response has `status` set to `queued`, `running`, `succeeded`, or `failed`. A successful job has `response` in the same format as `/v1/analyze`; a failed job has `error`. Polling an expired or unknown ID returns 404. The submission response includes `Retry-After: 3` as a suggested polling interval.

```sh
curl -X POST "https://vision-api.ts.uzuki-p.my.id/v1/jobs" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F 'instruction=Extract the merchant and total as JSON.' \
  -F 'image=@receipt.jpg'

curl "https://vision-api.ts.uzuki-p.my.id/v1/jobs/JOB_ID" \
  -H "Authorization: Bearer $API_TOKEN"
```

`JOB_TIMEOUT_MS` limits each job's CLI runtime to 30 minutes by default. `REQUEST_TIMEOUT_MS` still applies to the synchronous endpoint. The service runs at most `MAX_CONCURRENT_REQUESTS` jobs at once and holds up to `MAX_QUEUED_JOBS` more. A full queue returns 429. Job status and completed results live in `JOB_DATA_DIR`, by default `~/.local/state/vision-api/jobs`. The service deletes uploaded images and instructions after each job finishes. It removes results after `JOB_RETENTION_MS`, which defaults to 24 hours. If the service restarts while a job is queued or running, that job becomes `failed` with code `service_restarted`; completed results remain available until they expire.

The scan pipeline uses Effect v4 RC. Both endpoints share the same JSON validation and provider error handling. Effect releases the temporary image directory after each provider attempt, including failures.

The API entry point is `server.ts`. HTTP routes and authentication live in `src/http.ts`; `src/input.ts` validates uploads; `src/jobs.ts` stores and schedules jobs. `src/scan.ts` runs the shared Effect workflow. `src/providers.ts` contains the OpenCode and Codex adapters, while `src/cli.ts` handles subprocess limits. `src/env.ts` validates server settings at startup with t3-env and Zod; `src/web-env.ts` validates the playground ports and optional token. The Solid playground lives under `web/`. Its model, image, result, history, and request log components are in `web/src/components/`, and `web/src/useScanJob.ts` owns submission, polling, and the run history.

Run `bun run check` for Oxlint, TypeScript, and the web build, `bun test` for the slow job and startup validation tests, and `bun run format:check` for formatting. `bun run lint` runs Oxlint's default correctness rules and fails on warnings. `bun run lint:fix` applies safe lint fixes. The shared configuration is `.oxlintrc.json`.

The model must return a JSON object. The API validates and parses it before returning:

```json
{
  "_metadata": {
    "request_id": "...",
    "provider": "opencode",
    "model": "provider/model-id",
    "reasoning_effort": "low",
    "token_usage": {
      "input_tokens": 1200,
      "cached_input_tokens": 800,
      "cache_write_input_tokens": 0,
      "output_tokens": 140,
      "reasoning_output_tokens": 32,
      "total_tokens": 1340
    }
  },
  "result": { "merchant": "Example", "total": 12000 }
}
```

`GET /healthz` reports service health. `GET /v1/providers` lists configured defaults and requires the bearer token.

`GET /v1/models` also requires the bearer token. Add `?provider=opencode` or `?provider=codex` to choose a provider. Each model entry includes `id`, `label`, `group`, and `reasoning_efforts`. OpenCode lists image-capable models from the providers saved in OpenCode's credentials. Codex lists visible models in the installed CLI catalog. The response is cached for five minutes.

Example:

```sh
curl "https://vision-api.ts.uzuki-p.my.id/v1/models?provider=opencode" \
  -H "Authorization: Bearer $API_TOKEN"
```

`token_usage` is normalized from each CLI's usage events. It contains input, output, cached, cache-write, reasoning, and total token counts when the CLI reports them. It is `null` when the CLI does not provide usage for a completed request. OpenCode can omit its final usage event in some runs, so treat its counts as best-effort.

Example:

```sh
set -a
source .env
set +a
curl -X POST "https://vision-api.ts.uzuki-p.my.id/v1/analyze" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F 'instruction=Extract the merchant, date, line items, subtotal, tax, and total. Use null when a value is unreadable.' \
  -F 'provider=opencode' \
  -F 'model=provider/model-id' \
  -F 'reasoning_effort=low' \
  -F 'image=@receipt.jpg'
```

## Access control

Keep the process bound to `127.0.0.1` and publish it through the private Tailscale route. The API token is a second gate for clients. Do not put it in source control, a URL, or logs. Change it in `.env` to rotate it, then restart the service.

The service ignores forwarded client-IP headers. Restrict tailnet reachability with Tailscale policy where possible, and use the bearer token for service-level authorization. The service also limits concurrent requests and requests per minute. Set `ALLOWED_MODELS` to control which model IDs callers can select.
