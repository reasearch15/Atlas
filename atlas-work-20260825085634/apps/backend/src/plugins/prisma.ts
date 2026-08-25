import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

/**
 * Registers a singleton Prisma client and closes it with the Fastify lifecycle.
 */
export const prismaPlugin = fp(async (app) => {
  const prisma = new PrismaClient({
    log: app.log.level === "debug" ? ["query", "warn", "error"] : ["warn", "error"]
  });

  await prisma.$connect();
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
