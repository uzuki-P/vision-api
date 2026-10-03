default:
    just --list

# Run the vision API server
api:
    bun run server.ts

# Run the vision API server with file watching
api-watch:
    bun --watch run server.ts

# Run the web test UI (random port, prints it on startup)
web:
    bun run web

# Run the web test UI with file watching
web-watch:
    bun run web:dev

# Reload the user systemd unit and restart the API service
service-restart:
    systemctl --user daemon-reload
    systemctl --user restart vision-api
    systemctl --user --no-pager status vision-api

# Stop the API service
service-stop:
    systemctl --user stop vision-api

# Pull the service checkout's branch, install dependencies, and restart the service
service-update:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(systemctl --user show -p WorkingDirectory --value vision-api)
    echo "Updating $dir"
    git -C "$dir" pull --ff-only
    (cd "$dir" && bun install --frozen-lockfile)
    systemctl --user daemon-reload
    systemctl --user restart vision-api
    systemctl --user --no-pager status vision-api
