# Vision API

A small REST service for sending an instruction and image to OpenCode or Codex CLI. It binds to `127.0.0.1`, requires a bearer token for API calls, and does not keep uploaded images after each request.

## Service control

The user systemd service runs the API in the background and restarts it after a failure. Bun remains the runtime. OpenCode and Codex use their existing host installations and credentials.

Install the unit once:

```sh
mkdir -p ~/.config/systemd/user
ln -s ~/projects/_sandbox/vision-api/deploy/vision-api.service ~/.config/systemd/user/vision-api.service
systemctl --user daemon-reload
systemctl --user enable --now vision-api
```

The unit starts automatically after reboot. Disable it with `systemctl --user disable --now vision-api`.

```sh
systemctl --user start vision-api
systemctl --user stop vision-api
systemctl --user restart vision-api
systemctl --user status vision-api
journalctl --user -u vision-api -f
```

The unit is linked from `deploy/vision-api.service` under `~/.config/systemd/user/`. After changing `.env`, restart the service. The local `.env` contains the API token and selected port. Keep it private.

Edit `.env` to change the defaults. `DEFAULT_MODEL` and `DEFAULT_REASONING_EFFORT` can stay empty to use the CLI's configured model defaults. OpenCode uses its model variant for reasoning effort. Codex uses `model_reasoning_effort`. Not every model accepts every effort value.

You can also select these fields per request. Set `ALLOWED_MODELS` to a comma-separated list before sharing the service if callers should be limited to specific models.

OpenCode runs with all agent tools denied and a temporary data directory, including for its session history. Codex runs with its read-only sandbox, an ephemeral session, and a fresh temporary working directory. The service removes each request's temporary files when the CLI exits. The selected model provider still receives the instruction and image, and its own data retention rules apply.

Codex is a shell-capable agent CLI. Its read-only sandbox prevents writes, but it is not a substitute for running the service in an isolated OS account or container if callers are not fully trusted. OpenCode's tools are denied for this endpoint.

## API

`POST /v1/analyze` accepts `multipart/form-data` with these fields:

- `instruction`: task for the model
- `image`: PNG, JPEG, WebP, or GIF image
- `provider`: optional `opencode` or `codex`
- `model`: optional model ID
- `reasoning_effort`: optional provider effort or variant

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
