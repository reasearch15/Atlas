"use client";

import type { DeveloperAppDto, TelegramAccountDto } from "@atlas/shared";
import {
  buildTelegramAccountDeleteConfirmation,
  getTelegramAccountActionKind,
  normalizeTelegramAccountDisplay,
  telegramAccountIsReadyForPermanentDelete,
  telegramAccountNeedsDisconnectBeforeDelete
} from "@atlas/shared";
import { Cable, KeyRound, Phone, RefreshCw, ShieldAlert, Trash2, Unplug } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

type Step = "developer-app" | "restart" | "phone" | "code" | "password" | "connecting" | "connected";

interface TelegramWorkspaceProps {
  readonly initialAccountId?: string | null;
  readonly initialDeveloperAppId?: string | null;
}

/**
 * Renders Coadmin Telegram account connection and account management.
 */
export function TelegramWorkspace({ initialAccountId = null, initialDeveloperAppId = null }: TelegramWorkspaceProps) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<TelegramAccountDto[]>([]);
  const [developerApps, setDeveloperApps] = useState<DeveloperAppDto[]>([]);
  const [selectedDeveloperAppId, setSelectedDeveloperAppId] = useState("");
  const [activeAccount, setActiveAccount] = useState<TelegramAccountDto | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [step, setStep] = useState<Step>("developer-app");
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlightedAccountId, setHighlightedAccountId] = useState<string | null>(initialAccountId);
  const [filterDeveloperAppId, setFilterDeveloperAppId] = useState<string | null>(initialDeveloperAppId);
  const [deleteTarget, setDeleteTarget] = useState<TelegramAccountDto | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteStats, setDeleteStats] = useState<{ conversations: number; loading: boolean } | null>(null);
  const [deleteModalError, setDeleteModalError] = useState<string | null>(null);
  const [disconnectContinuing, setDisconnectContinuing] = useState(false);
  const [authPanelError, setAuthPanelError] = useState<string | null>(null);
  const [submittingCode, setSubmittingCode] = useState(false);
  const [submittingPassword, setSubmittingPassword] = useState(false);
  const accountRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setHighlightedAccountId(initialAccountId);
    setFilterDeveloperAppId(initialDeveloperAppId);
  }, [initialAccountId, initialDeveloperAppId]);

  useEffect(() => {
    if (!highlightedAccountId || loading) return;
    const node = accountRefs.current[highlightedAccountId];
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedAccountId, loading, accounts]);

  useEffect(() => {
    if (!deleteTarget) {
      setDeleteStats(null);
      setDeleteModalError(null);
      setDisconnectContinuing(false);
      return;
    }
    const fresh = accounts.find((account) => account.id === deleteTarget.id);
    if (
      fresh &&
      (fresh.status !== deleteTarget.status ||
        fresh.authorizationState !== deleteTarget.authorizationState ||
        fresh.syncState !== deleteTarget.syncState ||
        fresh.lastErrorMessage !== deleteTarget.lastErrorMessage)
    ) {
      setDeleteTarget(fresh);
    }
  }, [accounts, deleteTarget]);

  useEffect(() => {
    if (!deleteTarget) {
      setDeleteStats(null);
      return;
    }
    let cancelled = false;
    setDeleteStats({ conversations: 0, loading: true });
    void (async () => {
      try {
        const chats = await api.telegramChats(deleteTarget.id);
        if (!cancelled) setDeleteStats({ conversations: chats.length, loading: false });
      } catch {
        if (!cancelled) setDeleteStats({ conversations: 0, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deleteTarget?.id]);

  useEffect(() => {
    if (!panelOpen || step !== "connecting" || !activeAccount) return;
    let cancelled = false;

    async function pollAuthorizationOutcome(): Promise<void> {
      try {
        const list = await api.telegramAccounts();
        if (cancelled) return;
        setAccounts(list);
        const fresh = list.find((account) => account.id === activeAccount!.id);
        if (!fresh) return;
        setActiveAccount(fresh);

        if (fresh.authorizationState === "AUTHORIZED" || fresh.status === "CONNECTED" || fresh.status === "SYNCING") {
          setAuthPanelError(null);
          setStep("connected");
          toast.success("Telegram account connected.");
          window.setTimeout(() => {
            if (!cancelled) {
              setPanelOpen(false);
              setStep("developer-app");
            }
          }, 600);
          return;
        }

        if (fresh.status === "WAITING_FOR_PASSWORD" || fresh.authorizationState === "PASSWORD_REQUESTED") {
          setAuthPanelError(null);
          setPassword("");
          setStep("password");
          toast.message("Two-factor authentication required.");
          return;
        }

        if (fresh.lastErrorCode === "PHONE_CODE_INVALID") {
          setAuthPanelError(fresh.lastErrorMessage ?? "The Telegram verification code was incorrect.");
          setStep("code");
          return;
        }

        if (fresh.lastErrorCode === "PHONE_CODE_EXPIRED") {
          setAuthPanelError(fresh.lastErrorMessage ?? "The Telegram verification code expired.");
          setCode("");
          setStep("phone");
          return;
        }

        if (
          fresh.lastErrorCode === "TELEGRAM_AUTH_NETWORK_TIMEOUT" ||
          fresh.lastErrorCode === "TELEGRAM_NETWORK_ERROR"
        ) {
          setAuthPanelError(fresh.lastErrorMessage ?? "Telegram authorization timed out. You can retry.");
          return;
        }

        if (fresh.status === "FAILED") {
          setAuthPanelError(fresh.lastErrorMessage ?? "Telegram authorization failed.");
        }
      } catch {
        // Keep polling; transient list failures should not leave the modal stuck forever.
      }
    }

    void pollAuthorizationOutcome();
    const timer = window.setInterval(() => void pollAuthorizationOutcome(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [panelOpen, step, activeAccount?.id]);

  const activeDeveloperApps = useMemo(() => developerApps.filter((app) => app.status === "ACTIVE"), [developerApps]);
  const visibleAccounts = useMemo(() => {
    if (!filterDeveloperAppId) return accounts;
    return accounts.filter((account) => account.developerAppId === filterDeveloperAppId);
  }, [accounts, filterDeveloperAppId]);
  const filteredDeveloperAppName = developerApps.find((app) => app.id === filterDeveloperAppId)?.displayName;
  const cameFromDeveloperApps = Boolean(initialAccountId || initialDeveloperAppId);
  const expectedDeleteConfirmation = deleteTarget
    ? buildTelegramAccountDeleteConfirmation({
        telegramUsername: deleteTarget.telegramUsername ?? null,
        displayName: deleteTarget.displayName
      })
    : "";

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [nextAccounts, nextApps] = await Promise.all([api.telegramAccounts(), api.developerApps()]);
      setAccounts(nextAccounts);
      setDeveloperApps(nextApps);
      setSelectedDeveloperAppId((current) => current || nextApps.find((app) => app.status === "ACTIVE")?.id || "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load Telegram accounts.");
    } finally {
      setLoading(false);
    }
  }

  function openPanel(): void {
    setActiveAccount(null);
    setDisplayName("");
    setPhoneNumber("");
    setCode("");
    setPassword("");
    setAuthPanelError(null);
    setSubmittingCode(false);
    setSubmittingPassword(false);
    setStep("developer-app");
    setPanelOpen(true);
  }

  function closePanel(): void {
    setPanelOpen(false);
    setActiveAccount(null);
    setAuthPanelError(null);
    setSubmittingCode(false);
    setSubmittingPassword(false);
  }

  async function createAndStart(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const account = await api.createTelegramAccount(selectedDeveloperAppId, displayName || "Telegram Account");
      const started = await api.startTelegramAuth(account.id);
      setActiveAccount(started);
      setStep("phone");
      await load();
    } catch (submitError) {
      toast.error(submitError instanceof Error ? submitError.message : "Unable to start Telegram authorization.");
    }
  }

  async function submitPhone(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activeAccount) return;
    try {
      const account = await api.submitTelegramPhone(activeAccount.id, phoneNumber);
      setActiveAccount(account);
      setStep("code");
      await load();
      toast.success("Phone submitted. Enter the Telegram code.");
    } catch (submitError) {
      toast.error(submitError instanceof Error ? submitError.message : "Unable to submit phone number.");
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activeAccount || submittingCode) return;
    setSubmittingCode(true);
    setAuthPanelError(null);
    try {
      const account = await api.submitTelegramCode(activeAccount.id, code);
      setActiveAccount(account);
      setStep("connecting");
      await load();
      toast.success("Code submitted. Waiting for Telegram authorization.");
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit code.";
      setAuthPanelError(message);
      toast.error(message);
    } finally {
      setSubmittingCode(false);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activeAccount || submittingPassword) return;
    setSubmittingPassword(true);
    setAuthPanelError(null);
    try {
      const account = await api.submitTelegramPassword(activeAccount.id, password);
      setActiveAccount(account);
      setStep("connecting");
      await load();
      toast.success("Password submitted. Waiting for connection.");
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit 2FA password.";
      setAuthPanelError(message);
      toast.error(message);
    } finally {
      setSubmittingPassword(false);
    }
  }

  async function retryCodeSubmission(): Promise<void> {
    if (!activeAccount || !code.trim() || submittingCode) return;
    setAuthPanelError(null);
    setStep("code");
    setSubmittingCode(true);
    try {
      const account = await api.submitTelegramCode(activeAccount.id, code);
      setActiveAccount(account);
      setStep("connecting");
      await load();
      toast.success("Retrying Telegram authorization.");
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to retry code submission.";
      setAuthPanelError(message);
      toast.error(message);
    } finally {
      setSubmittingCode(false);
    }
  }

  async function reauthorize(account: TelegramAccountDto): Promise<void> {
    setActionId(account.id);
    try {
      const next = await api.reauthorizeTelegramAccount(account.id);
      setActiveAccount(next);
      setPanelOpen(true);
      setStep(next.authorizationState === "REAUTH_REQUIRED" ? "restart" : "phone");
      await load();
    } catch (reauthError) {
      toast.error(reauthError instanceof Error ? reauthError.message : "Unable to reauthorize account.");
    } finally {
      setActionId(null);
    }
  }

  async function restartAuthorization(account: TelegramAccountDto): Promise<void> {
    setActionId(account.id);
    try {
      const next = await api.restartTelegramAuthorization(account.id);
      setActiveAccount(next);
      setPhoneNumber("");
      setCode("");
      setPassword("");
      setPanelOpen(true);
      setStep("phone");
      await load();
      toast.success("Telegram authorization restarted.");
    } catch (restartError) {
      toast.error(restartError instanceof Error ? restartError.message : "Unable to restart authorization.");
    } finally {
      setActionId(null);
    }
  }

  async function disconnect(account: TelegramAccountDto): Promise<void> {
    if (!window.confirm(`Disconnect ${account.displayName}? Chat and message history is kept.`)) return;
    setActionId(account.id);
    try {
      await api.disconnectTelegramAccount(account.id);
      toast.success("Telegram account disconnected.");
      await load();
      if (cameFromDeveloperApps) {
        router.replace("/workspace/developer-apps" as Route);
      }
    } catch (disconnectError) {
      toast.error(disconnectError instanceof Error ? disconnectError.message : "Unable to disconnect account.");
    } finally {
      setActionId(null);
    }
  }

  function openPermanentDelete(account: TelegramAccountDto): void {
    setDeleteTarget(account);
    setDeleteConfirmation("");
    setDeleteModalError(null);
    setDisconnectContinuing(false);
  }

  function closePermanentDelete(): void {
    setDeleteTarget(null);
    setDeleteConfirmation("");
    setDeleteStats(null);
    setDeleteModalError(null);
    setDisconnectContinuing(false);
  }

  /**
   * Disconnects via the real API, waits for a backend-reported inactive status, keeps the delete modal open.
   */
  async function disconnectAndContinue(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteModalError(null);
    setActionId(deleteTarget.id);
    setDisconnectContinuing(true);
    try {
      const disconnected = await api.disconnectTelegramAccount(deleteTarget.id);
      setAccounts((current) => current.map((account) => (account.id === disconnected.id ? disconnected : account)));
      setDeleteTarget(disconnected);

      let ready = disconnected;
      for (let attempt = 0; attempt < 20 && !telegramAccountIsReadyForPermanentDelete(ready); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const list = await api.telegramAccounts();
        setAccounts(list);
        const refreshed = list.find((account) => account.id === deleteTarget.id);
        if (!refreshed) {
          throw new Error("Telegram account disappeared after disconnect.");
        }
        ready = refreshed;
        setDeleteTarget(refreshed);
      }

      if (!telegramAccountIsReadyForPermanentDelete(ready)) {
        throw new Error("Disconnect completed but the account is not yet ready for permanent deletion. Try again shortly.");
      }
      toast.success("Account disconnected. Confirm permanent deletion below.");
    } catch (disconnectError) {
      const message = disconnectError instanceof Error ? disconnectError.message : "Unable to disconnect account.";
      setDeleteModalError(message);
      toast.error(message);
    } finally {
      setActionId(null);
      setDisconnectContinuing(false);
    }
  }

  async function confirmPermanentDelete(): Promise<void> {
    if (!deleteTarget || deleteConfirmation !== expectedDeleteConfirmation) return;
    if (telegramAccountNeedsDisconnectBeforeDelete(deleteTarget)) {
      setDeleteModalError("This account must be disconnected before it can be permanently deleted.");
      return;
    }
    setDeleteModalError(null);
    setActionId(deleteTarget.id);
    try {
      const result = await api.permanentDeleteTelegramAccount(deleteTarget.id, deleteConfirmation);
      setAccounts((current) => current.filter((account) => account.id !== deleteTarget.id));
      closePermanentDelete();
      toast.success(
        `Telegram account and associated inbox data permanently deleted. (${result.conversationCount} conversations, ${result.messageCount} messages)`
      );
      await load();
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Unable to permanently delete account.";
      setDeleteModalError(message);
      toast.error(message);
    } finally {
      setActionId(null);
    }
  }

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Connected Telegram Accounts</h1>
            <p className="mt-1 text-sm text-muted-foreground">Connect and manage Telegram user accounts for this workspace.</p>
            {filterDeveloperAppId ? (
              <p className="mt-2 text-sm text-amber-800">
                Showing accounts linked to {filteredDeveloperAppName ?? "selected Developer App"}.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setFilterDeveloperAppId(null);
                    setHighlightedAccountId(null);
                    router.replace("/workspace/telegram" as Route);
                  }}
                >
                  Show all accounts
                </button>
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {cameFromDeveloperApps ? (
              <Button variant="secondary" onClick={() => router.push("/workspace/developer-apps" as Route)}>
                Back to Developer Apps
              </Button>
            ) : null}
            <Button onClick={openPanel}>
              <Cable className="size-4" aria-hidden="true" />
              Connect Telegram Account
            </Button>
          </div>
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
            Loading Telegram accounts...
          </div>
        ) : visibleAccounts.length === 0 ? (
          <div className="flex flex-col items-start gap-4 p-8">
            <div className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Cable className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-medium">
                {filterDeveloperAppId ? "No Telegram accounts are linked to this Developer App." : "No Telegram accounts have been connected yet."}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">Choose an active Developer App and authorize a Telegram user account.</p>
            </div>
            <Button onClick={openPanel}>Connect Telegram Account</Button>
          </div>
        ) : (
          <div className="divide-y">
            {visibleAccounts.map((account) => {
              const actionKind = getTelegramAccountActionKind(account);
              const display = normalizeTelegramAccountDisplay(account);
              return (
              <article
                key={account.id}
                ref={(node) => {
                  accountRefs.current[account.id] = node;
                }}
                className={`grid gap-4 p-5 xl:grid-cols-[1fr_1fr_auto] ${
                  highlightedAccountId === account.id ? "bg-amber-50/80 ring-2 ring-inset ring-amber-300" : ""
                }`}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{accountTitle(account)}</h2>
                    <StatusBadge status={display.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{account.telegramUsername ? `@${account.telegramUsername}` : account.displayName}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{account.maskedPhoneNumber ?? "Phone not submitted"}</p>
                  {display.progressLabel ? <p className="mt-2 text-sm text-amber-800">{display.progressLabel}</p> : null}
                </div>
                <div className="grid gap-1 text-sm text-muted-foreground">
                  <p>Developer App: {developerApps.find((app) => app.id === account.developerAppId)?.displayName ?? account.developerAppId}</p>
                  <p>Auth: {display.authorizationState}</p>
                  <p>Sync: {display.syncState}</p>
                  <p>Last connected: {formatDate(account.lastConnectedAt)}</p>
                  <p>Last update: {formatDate(account.lastUpdateAt)}</p>
                  {account.lastErrorMessage ? <p className="text-red-700">Error: {account.lastErrorMessage}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  {actionKind === "deleting" ? (
                    <p className="text-sm font-medium text-red-700">Deletion in progress…</p>
                  ) : null}
                  {actionKind === "inactive" ? (
                    <>
                      {(account.authorizationState === "REAUTH_REQUIRED" || account.status === "FAILED") ? (
                        <Button variant="secondary" disabled={actionId === account.id} onClick={() => void restartAuthorization(account)}>
                          <RefreshCw className="size-4" aria-hidden="true" />
                          Restart authorization
                        </Button>
                      ) : null}
                      <Button variant="secondary" disabled={actionId === account.id} onClick={() => void reauthorize(account)}>
                        <KeyRound className="size-4" aria-hidden="true" />
                        Reauthorize
                      </Button>
                    </>
                  ) : null}
                  {actionKind === "active" ? (
                    <Button variant="ghost" disabled={actionId === account.id} onClick={() => void disconnect(account)}>
                      <Unplug className="size-4" aria-hidden="true" />
                      Disconnect
                    </Button>
                  ) : null}
                  {actionKind !== "deleting" ? (
                    <Button variant="ghost" disabled={actionId === account.id} onClick={() => openPermanentDelete(account)}>
                      <Trash2 className="size-4" aria-hidden="true" />
                      Permanently Delete
                    </Button>
                  ) : null}
                </div>
              </article>
              );
            })}
          </div>
        )}
      </section>

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-0 sm:items-center sm:px-4">
          <div className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-red-200 bg-white shadow-lg sm:rounded-lg" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <h2 className="text-lg font-semibold text-red-700">Permanently delete {accountTitle(deleteTarget)}?</h2>
            <p className="mt-3 text-sm text-muted-foreground">This will permanently delete:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                {deleteStats?.loading
                  ? "Loading conversation count..."
                  : `${deleteStats?.conversations ?? 0} conversation${deleteStats?.conversations === 1 ? "" : "s"}`}
              </li>
              <li>all synced messages</li>
              <li>media and thumbnails</li>
              <li>CRM history for this account</li>
            </ul>
            <p className="mt-3 text-sm font-medium text-red-700">This cannot be undone.</p>
            {telegramAccountNeedsDisconnectBeforeDelete(deleteTarget) ? (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">This account must be disconnected first.</p>
                <p className="mt-1">
                  Disconnect stops the live worker for this account. After disconnect succeeds, you can confirm permanent deletion here.
                </p>
              </div>
            ) : null}
            {deleteModalError ? <p className="mt-3 text-sm font-medium text-red-700">{deleteModalError}</p> : null}
            {telegramAccountIsReadyForPermanentDelete(deleteTarget) ? (
              <label className="mt-4 grid gap-2 text-sm font-medium">
                Type {expectedDeleteConfirmation} to confirm
                <Input
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={actionId === deleteTarget.id}
                />
              </label>
            ) : null}
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closePermanentDelete} disabled={disconnectContinuing}>
                Cancel
              </Button>
              {telegramAccountNeedsDisconnectBeforeDelete(deleteTarget) ? (
                <Button
                  type="button"
                  disabled={actionId === deleteTarget.id || disconnectContinuing}
                  onClick={() => void disconnectAndContinue()}
                >
                  <Unplug className="size-4" aria-hidden="true" />
                  {disconnectContinuing ? "Disconnecting…" : "Disconnect and Continue"}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={actionId === deleteTarget.id || deleteConfirmation !== expectedDeleteConfirmation}
                  onClick={() => void confirmPermanentDelete()}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Permanently Delete
                </Button>
              )}
            </div>
            </div>
          </div>
        </div>
      ) : null}

      {panelOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 px-0 sm:items-center sm:px-4">
          <section
            className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border bg-white shadow-lg sm:rounded-lg"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mb-5">
              <p className="text-sm font-medium text-muted-foreground">Step {stepLabel(step)}</p>
              <h2 className="mt-1 text-lg font-semibold">Connect Telegram Account</h2>
              {activeAccount?.maskedPhoneNumber ? <p className="mt-1 text-sm text-muted-foreground">{activeAccount.maskedPhoneNumber}</p> : null}
            </div>
            {activeDeveloperApps.length === 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <ShieldAlert className="mb-2 size-5" aria-hidden="true" />
                Add an active Telegram Developer App before connecting an account.
              </div>
            ) : null}
            {step === "developer-app" ? (
              <form onSubmit={createAndStart} className="grid gap-4">
                <label className="grid gap-2 text-sm font-medium">
                  Developer App
                  <select
                    className="h-10 rounded-md border bg-white px-3 text-sm"
                    value={selectedDeveloperAppId}
                    onChange={(event) => setSelectedDeveloperAppId(event.target.value)}
                    required
                  >
                    {activeDeveloperApps.map((app) => (
                      <option key={app.id} value={app.id}>
                        {app.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-sm font-medium">
                  Account label
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Support phone" required />
                </label>
                <PanelActions onCancel={closePanel} nextLabel="Continue" disabled={activeDeveloperApps.length === 0} />
              </form>
            ) : null}
            {step === "restart" && activeAccount ? (
              <div className="grid gap-4">
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Telegram authorization needs to be restarted.</div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={closePanel}>
                    Cancel
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => void disconnect(activeAccount)}>
                    <Unplug className="size-4" aria-hidden="true" />
                    Disconnect
                  </Button>
                  <Button type="button" disabled={actionId === activeAccount.id} onClick={() => void restartAuthorization(activeAccount)}>
                    <RefreshCw className="size-4" aria-hidden="true" />
                    Restart authorization
                  </Button>
                </div>
              </div>
            ) : null}
            {step === "phone" ? (
              <form onSubmit={submitPhone} className="grid gap-4">
                <label className="grid gap-2 text-sm font-medium">
                  Phone number
                  <Input value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="+15551234567" required />
                </label>
                <PanelActions onCancel={closePanel} back={() => setStep("developer-app")} nextLabel="Send code" />
              </form>
            ) : null}
            {step === "code" ? (
              <form onSubmit={submitCode} className="grid gap-4">
                <label className="grid gap-2 text-sm font-medium">
                  OTP code
                  <Input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" required disabled={submittingCode} />
                </label>
                {authPanelError ? <p className="text-sm font-medium text-red-700">{authPanelError}</p> : null}
                <PanelActions onCancel={closePanel} back={() => setStep("phone")} nextLabel={submittingCode ? "Submitting…" : "Submit OTP"} disabled={submittingCode} />
              </form>
            ) : null}
            {step === "password" ? (
              <form onSubmit={submitPassword} className="grid gap-4">
                <label className="grid gap-2 text-sm font-medium">
                  Telegram 2FA password
                  <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={submittingPassword} />
                </label>
                {authPanelError ? <p className="text-sm font-medium text-red-700">{authPanelError}</p> : null}
                <PanelActions
                  onCancel={closePanel}
                  back={() => setStep("code")}
                  nextLabel={submittingPassword ? "Submitting…" : "Submit password"}
                  disabled={submittingPassword}
                />
              </form>
            ) : null}
            {step === "connecting" || step === "connected" ? (
              <div className="grid gap-4">
                <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground">
                  {step === "connecting"
                    ? "Submitting OTP to Telegram and waiting for authorization…"
                    : "Telegram account connected."}
                </div>
                {authPanelError ? <p className="text-sm font-medium text-red-700">{authPanelError}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={closePanel}>
                    Cancel
                  </Button>
                  {step === "connecting" &&
                  (activeAccount?.lastErrorCode === "TELEGRAM_AUTH_NETWORK_TIMEOUT" ||
                    activeAccount?.lastErrorCode === "TELEGRAM_NETWORK_ERROR" ||
                    authPanelError) ? (
                    <Button type="button" disabled={submittingCode || !code.trim()} onClick={() => void retryCodeSubmission()}>
                      <RefreshCw className="size-4" aria-hidden="true" />
                      Retry
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function PanelActions({
  onCancel,
  back,
  nextLabel,
  disabled,
  onNext
}: {
  readonly onCancel: () => void;
  readonly back?: () => void;
  readonly nextLabel: string;
  readonly disabled?: boolean;
  readonly onNext?: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {back ? (
        <Button type="button" variant="secondary" onClick={back}>
          Back
        </Button>
      ) : null}
      <Button type={onNext ? "button" : "submit"} disabled={disabled} onClick={onNext}>
        {nextLabel}
      </Button>
    </div>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  const className =
    status === "CONNECTED"
      ? "bg-emerald-50 text-emerald-700"
      : status === "FAILED" || status === "DELETING"
        ? "bg-red-50 text-red-700"
        : "bg-slate-100 text-slate-700";
  return <span className={`rounded-md px-2 py-1 text-xs font-medium ${className}`}>{status}</span>;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function stepLabel(step: Step): string {
  const order: Record<Step, string> = {
    "developer-app": "1 of 5",
    restart: "Recovery",
    phone: "2 of 5",
    code: "3 of 5",
    password: "4 of 5",
    connecting: "5 of 5",
    connected: "5 of 5"
  };
  return order[step];
}

function accountTitle(account: TelegramAccountDto): string {
  if (account.telegramUsername) return `@${account.telegramUsername}`;
  if (/^\+?[1-9]\d{7,14}$/.test(account.displayName.trim())) return "Telegram account";
  return account.displayName || "Telegram account";
}
