"use client";

import type { DeveloperAppDto, TelegramAccountDto } from "@atlas/shared";
import { CalendarClock, MoreHorizontal, Plus, RefreshCw, ShieldCheck, Trash2, WalletCards } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface FormState {
  readonly displayName: string;
  readonly apiId: string;
  readonly apiHash: string;
}

const emptyForm: FormState = { displayName: "", apiId: "", apiHash: "" };

/**
 * Renders Coadmin management for encrypted Telegram Developer Apps.
 */
export function DeveloperAppsView() {
  const router = useRouter();
  const [apps, setApps] = useState<DeveloperAppDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"create" | "edit" | null>(null);
  const [editingApp, setEditingApp] = useState<DeveloperAppDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeveloperAppDto | null>(null);
  const [linkedAccounts, setLinkedAccounts] = useState<TelegramAccountDto[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const [deleteBlockedMessage, setDeleteBlockedMessage] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setApps(await api.developerApps());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load Developer Apps.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function refreshOnFocus(): void {
      void load();
    }
    function onVisibility(): void {
      if (document.visibilityState === "visible") refreshOnFocus();
    }
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (!deleteTarget) return;
    const fresh = apps.find((app) => app.id === deleteTarget.id);
    if (!fresh) {
      setDeleteTarget(null);
      setLinkedAccounts([]);
      setDeleteBlockedMessage(null);
      return;
    }
    if (fresh.connectedTelegramAccountCount !== deleteTarget.connectedTelegramAccountCount || fresh.status !== deleteTarget.status) {
      setDeleteTarget(fresh);
      setDeleteBlockedMessage(null);
    }
  }, [apps, deleteTarget]);

  const sortedApps = useMemo(() => apps, [apps]);
  const linkedTelegramAccountCount = deleteTarget?.connectedTelegramAccountCount ?? 0;
  const deleteBlocked = linkedTelegramAccountCount > 0;

  async function openDelete(app: DeveloperAppDto): Promise<void> {
    setDeleteTarget(app);
    setDeleteBlockedMessage(null);
    setLinkedAccounts([]);
    if (app.connectedTelegramAccountCount <= 0) return;
    setLinkedLoading(true);
    try {
      const accounts = await api.telegramAccounts();
      setLinkedAccounts(accounts.filter((account) => account.developerAppId === app.id && account.status !== "DISCONNECTED" && account.status !== "DELETING"));
    } catch {
      setLinkedAccounts([]);
    } finally {
      setLinkedLoading(false);
    }
  }

  function closeDelete(): void {
    setDeleteTarget(null);
    setLinkedAccounts([]);
    setDeleteBlockedMessage(null);
  }

  function openCreate(): void {
    setEditingApp(null);
    setForm(emptyForm);
    setPanelMode("create");
  }

  function openEdit(app: DeveloperAppDto): void {
    setEditingApp(app);
    setForm({ displayName: app.displayName, apiId: String(app.apiId), apiHash: "" });
    setPanelMode("edit");
  }

  function closePanel(): void {
    setPanelMode(null);
    setEditingApp(null);
    setForm(emptyForm);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      const apiId = Number(form.apiId);
      if (panelMode === "create") {
        await api.createDeveloperApp({ displayName: form.displayName, apiId, apiHash: form.apiHash });
        toast.success("Developer App added.");
      } else if (editingApp) {
        await api.updateDeveloperApp(editingApp.id, {
          displayName: form.displayName,
          apiId,
          ...(form.apiHash.trim() ? { apiHash: form.apiHash } : {})
        });
        toast.success("Developer App updated.");
      }
      closePanel();
      await load();
    } catch (submitError) {
      toast.error(submitError instanceof Error ? submitError.message : "Unable to save Developer App.");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(app: DeveloperAppDto): Promise<void> {
    setActionId(app.id);
    try {
      if (app.status === "ACTIVE") {
        await api.disableDeveloperApp(app.id);
        toast.success("Developer App disabled.");
      } else {
        await api.enableDeveloperApp(app.id);
        toast.success("Developer App enabled.");
      }
      await load();
    } catch (statusError) {
      toast.error(statusError instanceof Error ? statusError.message : "Unable to update status.");
    } finally {
      setActionId(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleteTarget.connectedTelegramAccountCount > 0) return;
    setActionId(deleteTarget.id);
    setDeleteBlockedMessage(null);
    try {
      await api.deleteDeveloperApp(deleteTarget.id);
      toast.success("Developer App deleted.");
      closeDelete();
      await load();
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Unable to delete Developer App.";
      const isLinkedBlock = message.includes("DEVELOPER_APP_HAS_TELEGRAM_ACCOUNTS");
      if (isLinkedBlock) {
        setDeleteBlockedMessage("Disconnect Telegram accounts before deleting this developer app.");
        await load();
        const accounts = await api.telegramAccounts().catch(() => [] as TelegramAccountDto[]);
        setLinkedAccounts(accounts.filter((account) => account.developerAppId === deleteTarget.id && account.status !== "DISCONNECTED" && account.status !== "DELETING"));
      } else {
        toast.error(message);
      }
    } finally {
      setActionId(null);
    }
  }

  function viewLinkedAccount(): void {
    if (!deleteTarget) return;
    const primary = linkedAccounts[0];
    if (primary) {
      router.push(`/workspace/telegram?accountId=${encodeURIComponent(primary.id)}&developerAppId=${encodeURIComponent(deleteTarget.id)}` as Route);
      return;
    }
    router.push(`/workspace/telegram?developerAppId=${encodeURIComponent(deleteTarget.id)}` as Route);
  }

  function goToTelegramAccounts(): void {
    if (!deleteTarget) {
      router.push("/workspace/telegram" as Route);
      return;
    }
    router.push(`/workspace/telegram?developerAppId=${encodeURIComponent(deleteTarget.id)}` as Route);
  }

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Developer Apps</h1>
            <p className="mt-1 text-sm text-muted-foreground">Manage encrypted Telegram API credentials for this workspace.</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Disable prevents future use but keeps connections and data. Delete is only allowed after no Telegram accounts reference the app.
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            Add Developer App
          </Button>
        </div>
      </section>

      {error ? (
        <section className="rounded-lg border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-medium text-red-700">{error}</p>
          <Button className="mt-3" variant="secondary" onClick={() => void load()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Retry
          </Button>
        </section>
      ) : null}

      <section className="rounded-lg border bg-white">
        {loading ? (
          <div className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
            Loading Developer Apps...
          </div>
        ) : sortedApps.length === 0 ? (
          <div className="flex flex-col items-start gap-4 p-8">
            <div className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <WalletCards className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-medium">No Developer Apps have been added yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Add Telegram API credentials before connecting Telegram accounts.</p>
            </div>
            <Button onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Add Developer App
            </Button>
          </div>
        ) : (
          <div className="divide-y">
            {sortedApps.map((app) => (
              <article key={app.id} className="grid gap-4 p-5 xl:grid-cols-[1.2fr_0.8fr_auto]">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{app.displayName}</h2>
                    <StatusBadge status={app.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{app.provider}</p>
                  <p className="mt-3 text-sm text-muted-foreground">API ID: {app.apiId}</p>
                </div>

                <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3 xl:grid-cols-1">
                  <span className="flex items-center gap-2">
                    <ShieldCheck className="size-4" aria-hidden="true" />
                    {app.connectedTelegramAccountCount} Telegram account{app.connectedTelegramAccountCount === 1 ? "" : "s"} linked
                  </span>
                  <span className="flex items-center gap-2">
                    <CalendarClock className="size-4" aria-hidden="true" />
                    Created {formatDate(app.createdAt)}
                  </span>
                  <span className="flex items-center gap-2">
                    <CalendarClock className="size-4" aria-hidden="true" />
                    Updated {formatDate(app.updatedAt)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  <Button variant="secondary" onClick={() => openEdit(app)}>
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                    Edit
                  </Button>
                  <Button variant="secondary" disabled={actionId === app.id} onClick={() => void setStatus(app)} title="Prevents future use but keeps connections and data">
                    {app.status === "ACTIVE" ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="ghost" disabled={actionId === app.id} onClick={() => void openDelete(app)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {panelMode ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4">
          <form onSubmit={submit} className="w-full max-w-lg rounded-lg border bg-white p-5 shadow-lg">
            <div className="mb-5">
              <h2 className="text-lg font-semibold">{panelMode === "create" ? "Add Developer App" : "Edit Developer App"}</h2>
              <p className="mt-1 text-sm text-muted-foreground">API hash is encrypted and never displayed after saving.</p>
            </div>
            <label className="grid gap-2 text-sm font-medium">
              Display Name
              <Input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} required />
            </label>
            <label className="mt-4 grid gap-2 text-sm font-medium">
              Provider
              <select className="h-10 rounded-md border bg-white px-3 text-sm" value="TELEGRAM" disabled>
                <option value="TELEGRAM">Telegram</option>
              </select>
            </label>
            <label className="mt-4 grid gap-2 text-sm font-medium">
              API ID
              <Input inputMode="numeric" value={form.apiId} onChange={(event) => setForm({ ...form, apiId: event.target.value })} required />
            </label>
            <label className="mt-4 grid gap-2 text-sm font-medium">
              API Hash
              <Input
                value={form.apiHash}
                onChange={(event) => setForm({ ...form, apiHash: event.target.value })}
                placeholder={panelMode === "edit" ? "Leave blank to keep existing secret" : "32-character Telegram API hash"}
                required={panelMode === "create"}
              />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closePanel}>
                Cancel
              </Button>
              <Button disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4">
          <div className="w-full max-w-md rounded-lg border bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold">Delete Developer App</h2>
            {deleteBlocked ? (
              <>
                <p className="mt-2 text-sm text-muted-foreground">
                  {linkedAccountBlockMessage(linkedTelegramAccountCount)}
                </p>
                {deleteBlockedMessage ? <p className="mt-2 text-sm text-amber-800">{deleteBlockedMessage}</p> : null}
                {linkedLoading ? <p className="mt-3 text-sm text-muted-foreground">Loading linked accounts...</p> : null}
                {!linkedLoading && linkedAccounts.length > 0 ? (
                  <ul className="mt-3 space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
                    {linkedAccounts.map((account) => (
                      <li key={account.id} className="text-muted-foreground">
                        {account.displayName}
                        {account.telegramUsername ? ` (@${account.telegramUsername})` : ""} · {account.status}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-3 text-xs text-muted-foreground">
                  Disable keeps this app and its connections. Delete requires every linked Telegram account to be disconnected first.
                </p>
                <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                  <Button type="button" variant="secondary" onClick={closeDelete}>
                    Cancel
                  </Button>
                  <Button type="button" variant="secondary" onClick={goToTelegramAccounts}>
                    Go to Telegram Accounts
                  </Button>
                  <Button type="button" onClick={viewLinkedAccount} disabled={linkedLoading}>
                    {linkedTelegramAccountCount === 1 ? "View linked account" : "View linked accounts"}
                  </Button>
                  <Button type="button" disabled title="Disconnect linked Telegram accounts before deleting">
                    Delete
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-muted-foreground">
                  Soft-delete {deleteTarget.displayName}. This removes the app from the workspace list. Existing Telegram chat and message history is not deleted.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Disable would only prevent future use while keeping connections. Delete is allowed because no Telegram accounts still reference this app.
                </p>
                {deleteBlockedMessage ? <p className="mt-2 text-sm text-amber-800">{deleteBlockedMessage}</p> : null}
                <div className="mt-6 flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={closeDelete}>
                    Cancel
                  </Button>
                  <Button disabled={actionId === deleteTarget.id} onClick={() => void confirmDelete()}>
                    Delete
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function linkedAccountBlockMessage(count: number): string {
  if (count === 1) {
    return "This Developer App is connected to 1 Telegram account. Disconnect or move that account before deleting this app.";
  }
  return `This Developer App is connected to ${count} Telegram accounts. Disconnect or move those accounts before deleting this app.`;
}

function StatusBadge({ status }: { readonly status: DeveloperAppDto["status"] }) {
  const className = status === "ACTIVE" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700";
  return <span className={`rounded-md px-2 py-1 text-xs font-medium ${className}`}>{status}</span>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
