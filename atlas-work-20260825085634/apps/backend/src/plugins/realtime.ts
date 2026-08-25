import fp from "fastify-plugin";
import { publishWorkspaceEvent } from "../modules/telegram/telegram.events";

/**
 * Bridges Redis workspace events into authenticated WebSocket connections.
 */
export const realtimePlugin = fp(async (app) => {
  const subscriber = app.redis.duplicate();
  await subscriber.subscribe("atlas.workspace-events");

  subscriber.on("message", (_channel, payload) => {
    try {
      const event = JSON.parse(payload) as { workspaceId?: string };
      if (event.workspaceId) {
        publishWorkspaceEvent(event.workspaceId, event);
      }
    } catch (error) {
      app.log.warn({ error }, "Unable to parse realtime workspace event");
    }
  });

  app.addHook("onClose", async () => {
    await subscriber.unsubscribe("atlas.workspace-events");
    await subscriber.quit();
  });
});
