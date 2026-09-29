import { host, port } from "./src/config";
import { applyCors, handleRequest } from "./src/http";
import { removeExpiredJobs } from "./src/jobs";

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    return handleRequest(request).then((response) =>
      applyCors(request, response),
    );
  },
});

console.log(`vision-api listening on http://${host}:${server.port}`);
setInterval(() => void removeExpiredJobs(), 60_000).unref();
