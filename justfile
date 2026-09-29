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
