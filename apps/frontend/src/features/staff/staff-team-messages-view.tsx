"use client";

import { useEffect, useState } from "react";
import { InternalTeamChatPanel } from "@/features/internal-messages/internal-team-chat-panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { Button } from "@/components/ui/button";
import { getTeamNotificationSoundSettings, setTeamNotificationSoundSettings } from "@/features/inbox/team-notification-sound";

/**
 * Staff-facing team messages page (Coadmin ↔ Staff, Atlas-only).
 */
export function StaffTeamMessagesView() {
  const user = useAuthStore((state) => state.user);
  const [unread, setUnread] = useState(0);
  const [muted, setMuted] = useState(() => getTeamNotificationSoundSettings().muted);

  useEffect(() => {
    if (!user?.id) return;
    void api.internalThreads().then((threads) => {
      const mine = threads.find((thread) => thread.staffUserId === user.id);
      setUnread(mine?.unreadCount ?? 0);
    });
  }, [user?.id]);

  if (!user?.id) {
    return <main className="p-6 text-sm text-muted-foreground">Sign in to view team messages.</main>;
  }

  return (
    <main className="space-y-4 p-6 lg:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Team Messages</h1>
          <p className="text-sm text-muted-foreground">
            Internal messages with Coadmin. Never sent to Telegram.
            {unread > 0 ? ` · ${unread} unread` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            const next = setTeamNotificationSoundSettings({ muted: !muted });
            setMuted(next.muted);
          }}
        >
          {muted ? "Unmute team sounds" : "Mute team sounds"}
        </Button>
      </div>
      <InternalTeamChatPanel staffUserId={user.id} staffName={user.name} embedded />
    </main>
  );
}
