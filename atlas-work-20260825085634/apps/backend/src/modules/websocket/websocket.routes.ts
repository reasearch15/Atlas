import type { FastifyInstance } from "fastify";
import { unauthorized } from "../../utils/errors";
import { registerWorkspaceSocket } from "../telegram/telegram.events";

/**
 * Registers authenticated WebSocket infrastructure for future real-time workspace events.
 */
export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, async (socket, request) => {
    const token = new URL(request.url, "http://localhost").searchParams.get("token");
    if (!token) {
      socket.close(1008, "Authentication required");
      return;
    }

    try {
      const user = await app.auth.authenticate(token);
      const channel = user.workspaceId ? `workspace:${user.workspaceId}` : "platform";
      await app.redis.sadd(`presence:${channel}`, user.id);
      registerWorkspaceSocket(user.workspaceId, user.role, socket);
      socket.send(JSON.stringify({ type: "connected", channel }));

      socket.on("close", () => {
        void app.redis.srem(`presence:${channel}`, user.id);
      });
    } catch (error) {
      if (error instanceof Error) {
        request.log.warn({ error }, "WebSocket authentication failed");
      }
      socket.close(1008, unauthorized().message);
    }
  });
}
