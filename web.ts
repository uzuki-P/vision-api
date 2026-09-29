import { readFile } from "node:fs/promises";
import path from "node:path";
import { readWebEnv } from "./src/web-env";

const env = readWebEnv(process.env);
const apiBase = `http://127.0.0.1:${env.PORT}`;
const envToken = env.API_TOKEN ?? "";
const distDir = path.join(import.meta.dir, "web", "dist");
const htmlPath = path.join(distDir, "index.html");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: env.WEB_PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      try {
        const html = await readFile(htmlPath, "utf8");
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch {
        return new Response(
          "Built web UI not found. Run bun run web:build first.",
          { status: 500 },
        );
      }
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/favicon.png" ||
        /^\/assets\/[A-Za-z0-9._-]+$/.test(url.pathname))
    ) {
      const file = Bun.file(path.join(distDir, url.pathname));
      if (!(await file.exists()))
        return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: {
          "cache-control": url.pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=86400",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      const target = apiBase + url.pathname.slice(4) + url.search;
      const headers = new Headers(request.headers);
      headers.delete("host");
      const clientKey = headers.get("x-vision-api-key")?.trim() ?? "";
      headers.delete("x-vision-api-key");
      if (clientKey) {
        headers.set("authorization", `Bearer ${clientKey}`);
      } else if (envToken) {
        headers.set("authorization", `Bearer ${envToken}`);
      }
      headers.delete("content-length");
      headers.delete("transfer-encoding");

      try {
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer();
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        });
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.set("cache-control", "no-store");
        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch {
        return Response.json(
          {
            error: {
              code: "upstream_unreachable",
              message: `Vision API is not reachable at ${apiBase}`,
            },
          },
          { status: 502 },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `vision-api test web listening on http://127.0.0.1:${server.port} (proxying to ${apiBase})`,
);
