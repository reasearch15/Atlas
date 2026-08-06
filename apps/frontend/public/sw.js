/* Atlas PWA service worker — installability + FCM / Web Push. */
const CACHE_NAME = "atlas-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

/**
 * Network-first with cache fallback for navigations; pass-through for other requests.
 * A fetch handler is required for Chrome's installability criteria.
 */
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          void cache.put(request, networkResponse.clone());
          return networkResponse;
        } catch {
          const cached = await caches.match(request);
          return cached ?? Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(fetch(request));
});

/**
 * Background / terminated push: show one independent notification per message.
 * Unique tag (atlas-n-{uuid}) prevents Android/Web from collapsing prior alerts.
 * requireInteraction keeps the alert until the user opens/dismisses it.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  const nested = payload.notification || {};
  const data = payload.data || payload;
  const title = nested.title || data.title || "Atlas";
  const body = nested.body || data.body || "New message";
  const notificationId = data.notificationId || null;
  const tag =
    (notificationId ? `atlas-n-${notificationId}` : null) ||
    nested.tag ||
    `atlas-${data.messageId || data.chatId || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const deepLinkPath = data.deepLinkPath || nested.click_action || "/";
  const options = {
    body,
    tag,
    renotify: true,
    requireInteraction: true,
    silent: data.sound === "0",
    timestamp: data.sentAt ? Date.parse(data.sentAt) : Date.now(),
    data: {
      deepLinkPath,
      chatId: data.chatId || null,
      messageId: data.messageId || null,
      workspaceId: data.workspaceId || null,
      type: data.type || null,
      notificationId
    },
    actions: [
      { action: "open", title: "Open" },
      { action: "mark_read", title: "Mark read" },
      { action: "claim", title: "Claim" }
    ],
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png"
  };

  if (nested.image || data.image) {
    options.image = nested.image || data.image;
  }

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      await broadcastToClients({
        type: "atlas.push.ack",
        notificationId,
        event: "delivered"
      });
      const badge = Number(data.badge);
      if (Number.isFinite(badge) && self.navigator && self.navigator.setAppBadge) {
        try {
          await self.navigator.setAppBadge(badge);
        } catch {
          // Badge API is best-effort.
        }
      }
    })()
  );
});

/**
 * Deep-link / action handling. Notifications stay until user interacts.
 */
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const action = event.action || "open";
  event.notification.close();

  const targetPath =
    typeof data.deepLinkPath === "string" && data.deepLinkPath.startsWith("/") ? data.deepLinkPath : "/";

  event.waitUntil(
    (async () => {
      await broadcastToClients({
        type: "atlas.push.action",
        notificationId: data.notificationId || null,
        action,
        path: targetPath
      });

      if (action === "mark_read" || action === "claim") {
        // Stay in place after side-effect actions unless no client is open.
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (clients.length > 0) {
          await clients[0].focus();
          return;
        }
      }

      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(targetPath);
            return;
          }
          client.postMessage({ type: "atlas.push.navigate", path: targetPath });
          return;
        }
      }
      await self.clients.openWindow(targetPath);
    })()
  );
});

self.addEventListener("notificationclose", (event) => {
  const data = event.notification.data || {};
  event.waitUntil(
    broadcastToClients({
      type: "atlas.push.ack",
      notificationId: data.notificationId || null,
      event: "dismissed"
    })
  );
});

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(message);
  }
}
