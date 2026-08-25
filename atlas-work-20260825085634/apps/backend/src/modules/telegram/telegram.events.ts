import type { RawData, WebSocket } from "ws";
import type { Role, TelegramWorkspaceRealtimeEvent } from "@atlas/shared";
import { applyRealtimeEventPrivacy } from "../privacy/customer-privacy-mapper";

interface Client {
  readonly workspaceId: string | null;
  readonly role: Role;
  readonly socket: WebSocket;
}

const clients = new Set<Client>();

/**
 * Registers an authenticated browser socket for workspace-scoped events.
 */
export function registerWorkspaceSocket(workspaceId: string | null, role: Role, socket: WebSocket): void {
  const client = { workspaceId, role, socket };
  clients.add(client);
  socket.on("close", () => {
    clients.delete(client);
  });
  socket.on("message", (_message: RawData) => undefined);
}

/**
 * Publishes an event only to sockets authenticated for the target workspace.
 * Each client receives a role-redacted payload so Staff never get external identifiers.
 */
export function publishWorkspaceEvent(workspaceId: string, event: unknown): void {
  for (const client of clients) {
    if (client.workspaceId !== workspaceId || client.socket.readyState !== client.socket.OPEN) {
      continue;
    }
    const typed = event as TelegramWorkspaceRealtimeEvent;
    const redacted =
      typed && typeof typed === "object" && "type" in typed
        ? applyRealtimeEventPrivacy(typed, client.role)
        : event;
    client.socket.send(JSON.stringify(redacted));
  }
}
