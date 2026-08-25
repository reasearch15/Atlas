import { loadEnv } from "./config/env";
import { buildApp } from "./server/app";
import { ZodError } from "zod";
import { AppError } from "./utils/errors";

/**
 * Starts the HTTP and WebSocket server.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ port: env.BACKEND_PORT, host: env.BACKEND_HOST });
}

main().catch((error) => {
  if (error instanceof ZodError) {
    console.error("Backend configuration error:");
    for (const issue of error.issues) {
      console.error(`- ${issue.path.join(".")}: ${issue.message}`);
    }
  } else if (error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
