import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export function readWebEnv(runtimeEnv: NodeJS.ProcessEnv) {
  return createEnv({
    server: {
      PORT: z.coerce.number().int().min(0).max(65535).default(3000),
      WEB_PORT: z.coerce.number().int().min(0).max(65535).default(27182),
      API_TOKEN: z.string().min(32).optional(),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
  });
}
