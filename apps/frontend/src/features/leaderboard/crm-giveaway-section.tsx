"use client";

import type { LeaderboardPlayerSearchHitDto, LeaderboardPlayerStatusDto, Role } from "@atlas/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { crmGiveawayCapabilities } from "./crm-giveaway-capabilities";
import {
  formatMoneyFromCents,
  mapLeaderboardError,
  newIdempotencyKey,
  parseDollarsToCents
} from "./leaderboard-errors";
import { PlayerSearchAutocomplete } from "./player-search-autocomplete";
import { WheelSpinPanel } from "./wheel-spin-panel";

const SUBSCRIPTION_REMINDER =
  "Prize reminder: winners must be subscribed to the official leaderboard Telegram channel at the eligibility deadline.";

type PendingAction = "deposit" | "referral" | "promotion" | "give-info" | "bind" | null;

export interface CrmGiveawaySectionProps {
  readonly chatId: string;
  readonly crmContactId: string | null;
  readonly role: Role | null | undefined;
}

/**
 * CRM side-panel Leaderboard / Giveaway operational controls (Staff + Coadmin).
 * Coadmin-only admin controls live on the Leaderboard settings page — never here.
 */
export function CrmGiveawaySection({ chatId, crmContactId, role }: CrmGiveawaySectionProps) {
  const caps = crmGiveawayCapabilities(role);
  const [status, setStatus] = useState<LeaderboardPlayerStatusDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<PendingAction>(null);

  const [depositDollars, setDepositDollars] = useState("");
  const [depositFieldError, setDepositFieldError] = useState<string | null>(null);
  const [selectedReferred, setSelectedReferred] = useState<LeaderboardPlayerSearchHitDto | null>(null);

  const depositKeyRef = useRef(newIdempotencyKey());
  const promotionKeyRef = useRef(newIdempotencyKey());
  const referralKeyRef = useRef(newIdempotencyKey());
  const giveInfoKeyRef = useRef(newIdempotencyKey());
  const depositInputId = useId();
  const referralInputId = useId();

  const refresh = useCallback(async (): Promise<void> => {
    if (!crmContactId || !caps.canRead) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      if (caps.canBind) {
        try {
          await api.leaderboardEnsureAutoBind(crmContactId);
        } catch {
          // Non-fatal — fall through to player status.
        }
      }
      const next = await api.leaderboardPlayer(crmContactId);
      setStatus(next);
      setError(null);
    } catch (loadError) {
      setError(mapLeaderboardError(loadError));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [caps.canBind, caps.canRead, crmContactId]);

  useEffect(() => {
    setSuccess(null);
    setConfirming(null);
    setDepositDollars("");
    setDepositFieldError(null);
    setSelectedReferred(null);
    depositKeyRef.current = newIdempotencyKey();
    promotionKeyRef.current = newIdempotencyKey();
    referralKeyRef.current = newIdempotencyKey();
    giveInfoKeyRef.current = newIdempotencyKey();
    void refresh();
  }, [refresh]);

  if (!caps.canRead) {
    return null;
  }

  if (!crmContactId) {
    return (
      <section className="rounded-xl border border-amber-200/80 bg-gradient-to-b from-amber-50/80 to-white p-3 shadow-sm">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">🏆 Leaderboard</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">CRM contact not linked yet.</p>
      </section>
    );
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await action();
      setConfirming(null);
    } catch (actionError) {
      setError(mapLeaderboardError(actionError));
    } finally {
      setPending(false);
    }
  }

  async function submitDeposit(): Promise<void> {
    const amountCents = parseDollarsToCents(depositDollars);
    if (amountCents == null) {
      setDepositFieldError("Enter a valid USD amount (e.g. 40 or 40.50).");
      return;
    }
    setDepositFieldError(null);
    await runAction(async () => {
      const result = await api.leaderboardDeposit({
        crmContactId: crmContactId!,
        amountCents,
        idempotencyKey: depositKeyRef.current
      });
      const prev = result.previousRank != null ? `#${result.previousRank}` : "—";
      const message = `${formatMoneyFromCents(result.amountCents)} deposit recorded / +${result.pointsAdded} points / Rank ${prev} → #${result.newRank}`;
      setSuccess(message);
      toast.success(message);
      setDepositDollars("");
      depositKeyRef.current = newIdempotencyKey();
      await refresh();
    });
  }

  async function submitReferral(): Promise<void> {
    if (!selectedReferred) {
      setError("Select a referred player first.");
      return;
    }
    if (selectedReferred.crmContactId === crmContactId) {
      setError("A player cannot refer themselves.");
      return;
    }
    await runAction(async () => {
      await api.leaderboardSetReferral({
        referrerCrmContactId: crmContactId!,
        referredCrmContactId: selectedReferred.crmContactId,
        idempotencyKey: referralKeyRef.current
      });
      setSuccess("Referral linked");
      toast.success("Referral linked");
      setSelectedReferred(null);
      referralKeyRef.current = newIdempotencyKey();
      await refresh();
    });
  }

  async function submitPromotion(): Promise<void> {
    await runAction(async () => {
      const result = await api.leaderboardPromotion({
        crmContactId: crmContactId!,
        idempotencyKey: promotionKeyRef.current
      });
      const prev = result.previousRank != null ? `#${result.previousRank}` : "—";
      const message = `Promotion verified / +${result.pointsAwarded} points / Rank ${prev} → #${result.newRank}`;
      setSuccess(message);
      toast.success(message);
      promotionKeyRef.current = newIdempotencyKey();
      await refresh();
    });
  }

  async function submitGiveInfo(): Promise<void> {
    await runAction(async () => {
      await api.leaderboardGiveInfo({
        crmContactId: crmContactId!,
        chatId,
        idempotencyKey: giveInfoKeyRef.current
      });
      setSuccess("Leaderboard info sent to this chat.");
      toast.success("Leaderboard info sent.");
      giveInfoKeyRef.current = newIdempotencyKey();
    });
  }

  async function submitBind(): Promise<void> {
    await runAction(async () => {
      await api.leaderboardBindParticipant(crmContactId!);
      setSuccess("Player bound — enable leaderboard in Leaderboard settings to start scoring.");
      toast.success("Connected to your leaderboard.");
      await refresh();
    });
  }

  const bound = status?.bound === true;
  const competition = status?.competition ?? null;
  const showBind = caps.canBind && status != null && !bound;
  const prizePool = competition ? formatMoneyFromCents(competition.prizePoolCents) : "—";

  return (
    <section
      className="rounded-xl border border-amber-200/70 bg-gradient-to-b from-amber-50/90 via-white to-white p-3 shadow-sm"
      aria-labelledby="crm-leaderboard-heading"
      data-testid="crm-leaderboard-panel"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="crm-leaderboard-heading" className="text-sm font-semibold tracking-wide text-foreground">
          🏆 Leaderboard
        </h2>
        {bound ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
            Bound
          </span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
            Unbound
          </span>
        )}
      </div>

      {error ? (
        <p className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {success ? (
        <p
          className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800"
          role="status"
        >
          {success}
        </p>
      ) : null}

      {loading && !status ? (
        <p className="text-sm text-muted-foreground">Loading leaderboard status…</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-2">
            <MetricCard label="Rank" value={status?.rank != null ? `#${status.rank}` : "—"} emphasize />
            <MetricCard label="Points" value={formatPoints(status?.totalPoints)} emphasize />
            <MetricCard label="Prize Pool" value={prizePool} emphasize accent="pool" wide />
            <MetricCard
              label="Ends"
              value={competition ? formatCompetitionEnd(competition.endsAt) : "—"}
              wide
            />
          </div>

          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            <BreakdownChip label="Deposit" value={formatPoints(status?.depositPoints)} />
            <BreakdownChip label="Referral" value={formatPoints(status?.referralPoints)} />
            <BreakdownChip label="Promotion" value={formatPoints(status?.promotionPoints)} />
            <BreakdownChip label="Wheel" value={formatPoints(status?.wheelPoints)} />
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">{SUBSCRIPTION_REMINDER}</p>

          {bound && status?.wheel ? (
            <WheelSpinPanel
              crmContactId={crmContactId}
              status={status.wheel}
              canSpin={caps.canWheelSpin}
              onRefresh={refresh}
            />
          ) : null}

          {showBind ? (
            <ConfirmAction
              label="Connect to my leaderboard"
              confirmLabel="Confirm bind"
              confirming={confirming === "bind"}
              pending={pending}
              onAsk={() => setConfirming("bind")}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void submitBind()}
              variant="secondary"
            />
          ) : null}

          {bound && !competition ? (
            <p className="text-[11px] leading-snug text-amber-800">
              Player bound — enable the leaderboard in Leaderboard settings to open the active competition.
            </p>
          ) : null}

          {bound && caps.canDeposit ? (
            <div className="space-y-2 rounded-lg border bg-white/80 p-2.5">
              <label className="block text-xs font-semibold text-foreground" htmlFor={depositInputId}>
                Deposit amount
              </label>
              <div className="flex items-stretch gap-2">
                <div className="relative min-w-0 flex-1">
                  <span
                    className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-semibold text-muted-foreground"
                    aria-hidden="true"
                  >
                    $
                  </span>
                  <Input
                    id={depositInputId}
                    inputMode="decimal"
                    placeholder="40.00"
                    value={depositDollars}
                    disabled={pending}
                    aria-invalid={depositFieldError != null}
                    aria-describedby={depositFieldError ? `${depositInputId}-error` : undefined}
                    onChange={(event) => {
                      setDepositDollars(event.target.value);
                      setDepositFieldError(null);
                    }}
                    className="h-11 pl-7 text-base font-medium tabular-nums"
                  />
                </div>
              </div>
              {depositFieldError ? (
                <p id={`${depositInputId}-error`} className="text-xs text-red-600" role="alert">
                  {depositFieldError}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">USD · $1 = 1 deposit point</p>
              )}
              <ConfirmAction
                label="Record Deposit"
                confirmLabel="Confirm deposit"
                confirming={confirming === "deposit"}
                pending={pending}
                disabled={depositDollars.trim().length === 0}
                onAsk={() => {
                  setDepositFieldError(null);
                  setConfirming("deposit");
                }}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void submitDeposit()}
                variant="primary"
                fullWidth
              />
            </div>
          ) : null}

          {bound && caps.canReferral ? (
            <div className="space-y-2 rounded-lg border bg-white/80 p-2.5">
              <label className="block text-xs font-semibold text-foreground" htmlFor={referralInputId}>
                Referred player
              </label>
              <PlayerSearchAutocomplete
                id={referralInputId}
                excludeContactId={crmContactId ?? undefined}
                disabled={pending}
                selected={selectedReferred}
                onSelect={setSelectedReferred}
                onClear={() => setSelectedReferred(null)}
                placeholder="Search player by name or username…"
                limit={25}
              />
              <ConfirmAction
                label="Link Referral"
                confirmLabel="Confirm referral"
                confirming={confirming === "referral"}
                pending={pending}
                disabled={!selectedReferred}
                onAsk={() => setConfirming("referral")}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void submitReferral()}
                variant="primary"
                fullWidth
              />
            </div>
          ) : null}

          {bound && (caps.canPromotion || caps.canGiveInfo) ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {caps.canPromotion ? (
                <ConfirmAction
                  label="Verify Promotion"
                  confirmLabel="Confirm promotion"
                  confirming={confirming === "promotion"}
                  pending={pending}
                  onAsk={() => setConfirming("promotion")}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => void submitPromotion()}
                  variant="action"
                  fullWidth
                />
              ) : null}
              {caps.canGiveInfo ? (
                <ConfirmAction
                  label="Give Info"
                  confirmLabel="Send info message"
                  confirming={confirming === "give-info"}
                  pending={pending}
                  onAsk={() => setConfirming("give-info")}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => void submitGiveInfo()}
                  variant="action-alt"
                  fullWidth
                />
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3" data-testid="crm-link-status">
            <LinkStatusCard label="Payment" linked={false} />
            <LinkStatusCard label="AppBeg" linked={false} />
            <LinkStatusCard label="Vendor Automation" linked={false} />
          </div>
        </div>
      )}
    </section>
  );
}

function MetricCard({
  label,
  value,
  emphasize = false,
  accent,
  wide = false
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasize?: boolean;
  readonly accent?: "pool";
  readonly wide?: boolean;
}) {
  const pool = accent === "pool";
  return (
    <div
      className={[
        "rounded-lg border px-2.5 py-2",
        wide ? "col-span-2" : "",
        pool
          ? "border-emerald-300/80 bg-emerald-50/90"
          : emphasize
            ? "border-border/80 bg-white"
            : "border-border/60 bg-muted/20"
      ].join(" ")}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={[
          "mt-0.5 break-words font-semibold tabular-nums text-foreground",
          pool ? "text-lg text-emerald-900" : emphasize ? "text-base" : "text-sm"
        ].join(" ")}
      >
        {value}
      </p>
    </div>
  );
}

function BreakdownChip({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-1 font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function LinkStatusCard({ label, linked }: { readonly label: string; readonly linked: boolean }) {
  return (
    <div
      className={[
        "rounded-lg border px-2 py-1.5",
        linked ? "border-emerald-200 bg-emerald-50/80" : "border-amber-200/80 bg-amber-50/50"
      ].join(" ")}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-xs font-medium ${linked ? "text-emerald-800" : "text-amber-900"}`}>
        {linked ? "Linked" : "Not linked"}
      </p>
    </div>
  );
}

function formatPoints(value: number | null | undefined): string {
  return value == null ? "—" : String(value);
}

function formatCompetitionEnd(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(date);
  } catch {
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    });
  }
}

function ConfirmAction({
  label,
  confirmLabel = "Confirm",
  confirming,
  pending,
  disabled = false,
  onAsk,
  onCancel,
  onConfirm,
  variant = "secondary",
  fullWidth = false
}: {
  readonly label: string;
  readonly confirmLabel?: string;
  readonly confirming: boolean;
  readonly pending: boolean;
  readonly disabled?: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly variant?: "primary" | "secondary" | "action" | "action-alt";
  readonly fullWidth?: boolean;
}) {
  const width = fullWidth ? "w-full" : "";
  if (confirming) {
    return (
      <div className={`flex flex-wrap gap-1.5 ${fullWidth ? "w-full" : ""}`}>
        <Button
          type="button"
          variant="secondary"
          className={`h-10 px-3 text-xs ${width}`}
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className={`h-10 px-3 text-xs ${width} ${buttonTone(variant)}`}
          disabled={pending || disabled}
          onClick={onConfirm}
        >
          {pending ? "Working…" : confirmLabel}
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant={variant === "primary" ? "primary" : "secondary"}
      className={`h-10 px-3 text-xs font-semibold ${width} ${buttonTone(variant)}`}
      disabled={pending || disabled}
      onClick={onAsk}
    >
      {label}
    </Button>
  );
}

function buttonTone(variant: "primary" | "secondary" | "action" | "action-alt"): string {
  if (variant === "primary") return "bg-emerald-800 text-white hover:bg-emerald-900";
  if (variant === "action") return "border-sky-300 bg-sky-50 text-sky-950 hover:bg-sky-100";
  if (variant === "action-alt") return "border-violet-300 bg-violet-50 text-violet-950 hover:bg-violet-100";
  return "";
}
