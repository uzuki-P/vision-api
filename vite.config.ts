import solid from "@solidjs/vite-plugin";
import { defineConfig, loadEnv } from "vite";
import { readWebEnv } from "./src/web-env.ts";

export default defineConfig(({ mode }) => {
  const env = readWebEnv({
    ...process.env,
    ...loadEnv(mode, process.cwd(), ""),
  });
  return {
    root: "web",
    plugins: [solid()],
    server: {
      host: "127.0.0.1",
      port: env.WEB_PORT,
      strictPort: true,
      // Tailnet dev routes such as vision-api-preview.ts.uzuki-p.my.id.
      allowedHosts: [".ts.uzuki-p.my.id"],
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${env.PORT}`,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest, request) => {
              const supplied = request.headers["x-vision-api-key"];
              const key =
                typeof supplied === "string" && supplied.trim()
                  ? supplied.trim()
                  : env.API_TOKEN;
              proxyRequest.removeHeader("x-vision-api-key");
              if (key) proxyRequest.setHeader("authorization", `Bearer ${key}`);
            });
          },
        },
      },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
