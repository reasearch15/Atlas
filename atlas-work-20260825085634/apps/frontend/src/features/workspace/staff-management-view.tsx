"use client";

import type { StaffDetail, StaffListItem } from "@atlas/shared";
import { Archive, Eye, KeyRound, MessageSquare, PauseCircle, PlayCircle, Search, UserPlus, XCircle } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { InternalTeamChatPanel } from "@/features/internal-messages/internal-team-chat-panel";

const statuses = ["", "ACTIVE", "PENDING_PASSWORD_CHANGE", "SUSPENDED", "ARCHIVED", "DISABLED"] as const;

/**
 * Renders Coadmin-owned Staff management.
 */
export function StaffManagementView() {
  const [staff, setStaff] = useState<StaffListItem[]>([]);
  const [selected, setSelected] = useState<StaffDetail | null>(null);
  const [messageStaff, setMessageStaff] = useState<StaffListItem | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [oneTimePassword, setOneTimePassword] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [form, setForm] = useState({ fullName: "", username: "", temporaryPassword: "", confirmTemporaryPassword: "", contactEmail: "", status: "ACTIVE" });

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return staff.filter((item) => {
      const matchesSearch = !q || [item.name, item.username, item.contactEmail ?? "", item.status].some((value) => value.toLowerCase().includes(q));
      const matchesStatus = !status || item.status === status;
      return matchesSearch && matchesStatus;
    });
  }, [search, staff, status]);

  async function load(): Promise<void> {
    setStaff(await api.staffMembers());
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const result = await api.createStaff(form);
      setOneTimePassword(result.temporaryPassword);
      setForm({ fullName: "", username: "", temporaryPassword: "", confirmTemporaryPassword: "", contactEmail: "", status: "ACTIVE" });
      toast.success("Staff created. Copy the temporary password now.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create Staff.");
    }
  }

  async function open(id: string): Promise<void> {
    setSelected(await api.staffMember(id));
  }

  async function update(call: () => Promise<StaffDetail>, message: string): Promise<void> {
    try {
      const next = await call();
      setSelected(next);
      await load();
      toast.success(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    }
  }

  async function reset(): Promise<void> {
    if (!selected) return;
    try {
      const result = await api.resetStaffPassword(selected.id, resetPassword);
      setOneTimePassword(result.temporaryPassword);
      setResetPassword("");
      setSelected(await api.staffMember(selected.id));
      await load();
      toast.success("Password reset. Copy the temporary password now.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password reset failed.");
    }
  }

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Staff</h1>
            <p className="text-sm text-muted-foreground">Manage workspace Staff accounts and sessions.</p>
          </div>
          <Button form="create-staff-form">
            <UserPlus className="size-4" aria-hidden="true" />
            Create Staff
          </Button>
        </div>
        <form id="create-staff-form" className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={create}>
          <Input placeholder="Full name" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required />
          <Input placeholder="Username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} required />
          <Input type="password" placeholder="Temporary password" value={form.temporaryPassword} onChange={(event) => setForm({ ...form, temporaryPassword: event.target.value })} required />
          <Input type="password" placeholder="Confirm temporary password" value={form.confirmTemporaryPassword} onChange={(event) => setForm({ ...form, confirmTemporaryPassword: event.target.value })} required />
          <Input type="email" placeholder="Contact email (optional)" value={form.contactEmail} onChange={(event) => setForm({ ...form, contactEmail: event.target.value })} />
          <select className="h-10 rounded-md border bg-white px-3 text-sm" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
        </form>
      </section>

      {oneTimePassword ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">Temporary password visible once</p>
              <p className="mt-2 font-mono text-sm">{oneTimePassword}</p>
              <p className="mt-2 text-sm text-muted-foreground">After this panel is closed, it cannot be retrieved. Reset the password to issue a new one.</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => void navigator.clipboard.writeText(oneTimePassword)}>Copy</Button>
              <Button type="button" variant="ghost" onClick={() => setOneTimePassword(null)}>Close</Button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border bg-white">
        <div className="grid gap-3 border-b p-5 md:grid-cols-[1fr_14rem]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input className="pl-9" placeholder="Search Staff" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <select className="h-10 rounded-md border bg-white px-3 text-sm" value={status} onChange={(event) => setStatus(event.target.value)}>
            {statuses.map((item) => <option key={item || "all"} value={item}>{item || "All statuses"}</option>)}
          </select>
        </div>
        {visible.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No Staff accounts have been created yet.</p>
        ) : (
          <div className="divide-y">
            {visible.map((item) => (
              <div key={item.id} className="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
                <div>
                  <p className="font-medium">{item.name}</p>
                  <p className="text-sm text-muted-foreground">@{item.username}</p>
                  <p className="text-sm text-muted-foreground">{item.contactEmail ?? "No contact email"}</p>
                  {item.lastInternalMessagePreview ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      Team: {item.lastInternalMessagePreview}
                      {item.lastInternalMessageAt
                        ? ` · ${new Date(item.lastInternalMessageAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                        : ""}
                    </p>
                  ) : null}
                  {item.lastActiveAt ? (
                    <p className="text-[11px] text-muted-foreground">
                      Last active {new Date(item.lastActiveAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-muted px-2 py-1 text-xs">{item.status}</span>
                  {(item.internalUnreadCount ?? 0) > 0 ? (
                    <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
                      {item.internalUnreadCount} unread
                    </span>
                  ) : null}
                  {item.mustChangePassword ? <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">Password change required</span> : null}
                  <Button variant="secondary" onClick={() => setMessageStaff(item)}>
                    <MessageSquare className="size-4" aria-hidden="true" />
                    Message
                  </Button>
                  <Button variant="secondary" onClick={() => void open(item.id)}>
                    <Eye className="size-4" aria-hidden="true" />
                    View
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {selected ? (
        <section className="rounded-lg border bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{selected.name}</h2>
              <p className="text-sm text-muted-foreground">@{selected.username}</p>
              <p className="text-sm text-muted-foreground">{selected.contactEmail ?? "No contact email"}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {selected.status === "SUSPENDED" ? (
                <Button onClick={() => update(() => api.reactivateStaff(selected.id), "Staff reactivated.")}>
                  <PlayCircle className="size-4" aria-hidden="true" />
                  Reactivate
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => update(() => api.suspendStaff(selected.id), "Staff suspended.")}>
                  <PauseCircle className="size-4" aria-hidden="true" />
                  Suspend
                </Button>
              )}
              <Button variant="secondary" onClick={() => update(() => api.archiveStaff(selected.id), "Staff archived.")}>
                <Archive className="size-4" aria-hidden="true" />
                Archive
              </Button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-[1fr_auto]">
            <Input type="password" placeholder="New temporary password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            <Button onClick={reset} disabled={resetPassword.length < 12}>
              <KeyRound className="size-4" aria-hidden="true" />
              Reset password
            </Button>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Sessions</h3>
              <Button variant="secondary" onClick={() => update(() => api.revokeAllStaffSessions(selected.id), "All sessions revoked.")}>
                <XCircle className="size-4" aria-hidden="true" />
                Revoke all
              </Button>
            </div>
            <div className="mt-3 divide-y rounded-md border">
              {selected.sessions.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No sessions.</p> : selected.sessions.map((session) => (
                <div key={session.id} className="grid gap-3 p-3 md:grid-cols-[1fr_auto]">
                  <div className="text-sm">
                    <p className="font-medium">{session.deviceName}</p>
                    <p className="text-muted-foreground">{session.ipAddress} - {new Date(session.lastSeenAt).toLocaleString()}</p>
                    <p className="text-muted-foreground">{session.revokedAt ? "Revoked" : "Active"}</p>
                  </div>
                  <Button variant="secondary" disabled={Boolean(session.revokedAt)} onClick={() => update(() => api.revokeStaffSession(selected.id, session.id), "Session revoked.")}>
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {messageStaff ? (
        <InternalTeamChatPanel
          staffUserId={messageStaff.id}
          staffName={messageStaff.name}
          onClose={() => {
            setMessageStaff(null);
            void load();
          }}
        />
      ) : null}
    </main>
  );
}
