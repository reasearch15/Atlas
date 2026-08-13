"use client";

import type { LeaderboardPlayerSearchHitDto, LeaderboardPlayerStatusDto, Role } from "@atlas/shared";
import { hasPermission } from "@atlas/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  formatMoneyFromCents,
  mapLeaderboardError,
  newIdempotencyKey,
  parseDollarsToCents
} from "./leaderboard-errors";
import { WheelSpinPanel } from "./wheel-spin-panel";

const SUBSCRIPTION_REMINDER =
  "To receive a leaderboard prize, winners must be subscribed to the official leaderboard Telegram channel at the eligibility deadline.";

type PendingAction = "deposit" | "referral" | "promotion" | "give-info" | "bind" | null;

export interface CrmGiveawaySectionProps {
  readonly chatId: string;
  readonly crmContactId: string | null;
  /** Coadmin-only bind control when the contact is unbound. */
  readonly canBind: boolean;
  readonly role: Role | null | undefined;
}

/**
 * CRM side-panel Giveaway / Leaderboard controls for the open conversation contact.
 * Failures stay local so the rest of the CRM panel keeps working.
 */
export function CrmGiveawaySection({ chatId, crmContactId, canBind, role }: CrmGiveawaySectionProps) {
  const [status, setStatus] = useState<LeaderboardPlayerStatusDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<PendingAction>(null);

  const [depositDollars, setDepositDollars] = useState("");
  const [referralQuery, setReferralQuery] = useState("");
  const [referralHits, setReferralHits] = useState<readonly LeaderboardPlayerSearchHitDto[]>([]);
  const [selectedReferred, setSelectedReferred] = useState<LeaderboardPlayerSearchHitDto | null>(null);
  const [searching, setSearching] = useState(false);

  const depositKeyRef = useRef(newIdempotencyKey());
  const promotionKeyRef = useRef(newIdempotencyKey());
  const referralKeyRef = useRef(newIdempotencyKey());
  const giveInfoKeyRef = useRef(newIdempotencyKey());

  const canDeposit = role ? hasPermission(role, "leaderboard:deposit") : false;
  const canReferral = role ? hasPermission(role, "leaderboard:referral:set") : false;
  const canPromotion = role ? hasPermission(role, "leaderboard:promotion") : false;
  const canGiveInfo = role ? hasPermission(role, "leaderboard:give-info") : false;
  const canRead = role ? hasPermission(role, "leaderboard:read") : false;
  const canWheelSpin = role ? hasPermission(role, "leaderboard:wheel:spin") : false;

  const refresh = useCallback(async (): Promise<void> => {
    if (!crmContactId || !canRead) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      // Try deterministic auto-bind before showing unbound state (Coadmin sole-owner workspaces).
      if (canBind) {
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
  }, [canBind, canRead, crmContactId]);

  useEffect(() => {
    setSuccess(null);
    setConfirming(null);
    setDepositDollars("");
    setReferralQuery("");
    setReferralHits([]);
    setSelectedReferred(null);
    depositKeyRef.current = newIdempotencyKey();
    promotionKeyRef.current = newIdempotencyKey();
    referralKeyRef.current = newIdempotencyKey();
    giveInfoKeyRef.current = newIdempotencyKey();
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!crmContactId || !canReferral || referralQuery.trim().length < 1) {
      setReferralHits([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setSearching(true);
      void api
        .leaderboardPlayersSearch({
          q: referralQuery.trim(),
          excludeContactId: crmContactId,
          limit: 8
        })
        .then((hits) => {
          if (!cancelled) setReferralHits(hits);
        })
        .catch(() => {
          if (!cancelled) setReferralHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [canReferral, crmContactId, referralQuery]);

  if (!canRead) {
    return null;
  }

  if (!crmContactId) {
    return (
      <section>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Giveaway
        </p>
        <p className="text-sm text-muted-foreground">CRM contact not linked yet.</p>
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
      setError("Enter a valid deposit amount (e.g. 40 or 40.50).");
      return;
    }
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
    await runAction(async () => {
      await api.leaderboardSetReferral({
        referrerCrmContactId: crmContactId!,
        referredCrmContactId: selectedReferred.crmContactId,
        idempotencyKey: referralKeyRef.current
      });
      setSuccess("Referral linked");
      toast.success("Referral linked");
      setSelectedReferred(null);
      setReferralQuery("");
      setReferralHits([]);
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
      setSuccess(
        "Player bound — enable leaderboard in Leaderboard settings to start scoring."
      );
      toast.success("Connected to your leaderboard.");
      await refresh();
    });
  }

  const bound = status?.bound === true;
  const competition = status?.competition ?? null;
  const showBind = canBind && canDeposit && status != null && !bound;

  return (
    <section>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Giveaway
      </p>

      {error ? (
        <p className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800">
          {success}
        </p>
      ) : null}

      {loading && !status ? (
        <p className="text-sm text-muted-foreground">Loading giveaway status…</p>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <Stat label="Rank" value={status?.rank != null ? `#${status.rank}` : "—"} />
            <Stat label="Bound" value={bound ? "Yes" : "No"} />
            <Stat label="Total points" value={formatPoints(status?.totalPoints)} />
            <Stat label="Deposit points" value={formatPoints(status?.depositPoints)} />
            <Stat label="Referral points" value={formatPoints(status?.referralPoints)} />
            <Stat label="Promotion points" value={formatPoints(status?.promotionPoints)} />
            <Stat label="Wheel points" value={formatPoints(status?.wheelPoints)} />
            <Stat
              label="Qualifying deposits"
              value={
                status?.qualifyingDepositCents != null
                  ? formatMoneyFromCents(status.qualifyingDepositCents)
                  : "—"
              }
            />
            <Stat
              label="Prize pool"
              value={
                competition ? formatMoneyFromCents(competition.prizePoolCents) : "—"
              }
            />
            <Stat
              label="Competition ends"
              value={competition ? formatCompetitionEnd(competition.endsAt) : "—"}
              wide
            />
          </dl>

          <p className="text-[11px] leading-snug text-muted-foreground">{SUBSCRIPTION_REMINDER}</p>

          {bound && status?.wheel ? (
            <WheelSpinPanel
              crmContactId={crmContactId}
              status={status.wheel}
              canSpin={canWheelSpin}
              onRefresh={refresh}
            />
          ) : null}

          {showBind ? (
            <ActionRow
              label="Connect to my leaderboard"
              confirming={confirming === "bind"}
              pending={pending}
              onAsk={() => setConfirming("bind")}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void submitBind()}
            />
          ) : null}

          {bound ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              Player bound — enable leaderboard in Leaderboard settings to start scoring.
            </p>
          ) : null}

          {bound && canDeposit ? (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="lb-deposit">
                Deposit amount (USD)
              </label>
              <Input
                id="lb-deposit"
                inputMode="decimal"
                placeholder="e.g. 40"
                value={depositDollars}
                disabled={pending}
                onChange={(event) => setDepositDollars(event.target.value)}
                className="h-8 text-sm"
              />
              <ActionRow
                label="Record deposit"
                confirmLabel="Confirm deposit"
                confirming={confirming === "deposit"}
                pending={pending}
                disabled={depositDollars.trim().length === 0}
                onAsk={() => setConfirming("deposit")}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void submitDeposit()}
              />
            </div>
          ) : null}

          {bound && canReferral ? (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="lb-referral">
                Link referred player
              </label>
              {selectedReferred ? (
                <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
                  <span className="min-w-0 truncate">
                    {selectedReferred.displayName}
                    {selectedReferred.telegramUsername
                      ? ` (@${selectedReferred.telegramUsername})`
                      : ""}{" "}
                    <span className="text-muted-foreground">· {selectedReferred.shortId}</span>
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    disabled={pending}
                    onClick={() => setSelectedReferred(null)}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <>
                  <Input
                    id="lb-referral"
                    placeholder="Search players…"
                    value={referralQuery}
                    disabled={pending}
                    onChange={(event) => setReferralQuery(event.target.value)}
                    className="h-8 text-sm"
                  />
                  {searching ? (
                    <p className="text-[11px] text-muted-foreground">Searching…</p>
                  ) : referralHits.length > 0 ? (
                    <ul className="max-h-36 overflow-y-auto rounded-md border">
                      {referralHits.map((hit) => (
                        <li key={hit.crmContactId}>
                          <button
                            type="button"
                            className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-xs hover:bg-muted"
                            disabled={pending}
                            onClick={() => {
                              setSelectedReferred(hit);
                              setReferralQuery("");
                              setReferralHits([]);
                            }}
                          >
                            <span className="font-medium text-foreground">{hit.displayName}</span>
                            <span className="text-muted-foreground">
                              {hit.telegramUsername ? `@${hit.telegramUsername} · ` : ""}
                              {hit.shortId}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
              <ActionRow
                label="Link referral"
                confirmLabel="Confirm referral"
                confirming={confirming === "referral"}
                pending={pending}
                disabled={!selectedReferred}
                onAsk={() => setConfirming("referral")}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void submitReferral()}
              />
            </div>
          ) : null}

          {bound && canPromotion ? (
            <ActionRow
              label="Verify Promotion"
              confirmLabel="Confirm promotion"
              confirming={confirming === "promotion"}
              pending={pending}
              onAsk={() => setConfirming("promotion")}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void submitPromotion()}
            />
          ) : null}

          {bound && canGiveInfo ? (
            <ActionRow
              label="Give Info"
              confirmLabel="Send info message"
              confirming={confirming === "give-info"}
              pending={pending}
              onAsk={() => setConfirming("give-info")}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void submitGiveInfo()}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  wide = false
}: {
  readonly label: string;
  readonly value: string;
  readonly wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function formatPoints(value: number | null | undefined): string {
  return value == null ? "—" : String(value);
}

function formatCompetitionEnd(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

function ActionRow({
  label,
  confirmLabel = "Confirm",
  confirming,
  pending,
  disabled = false,
  onAsk,
  onCancel,
  onConfirm
}: {
  readonly label: string;
  readonly confirmLabel?: string;
  readonly confirming: boolean;
  readonly pending: boolean;
  readonly disabled?: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  if (confirming) {
    return (
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="secondary"
          className="h-8 px-3 text-xs"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-8 px-3 text-xs"
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
      variant="secondary"
      className="h-8 px-3 text-xs"
      disabled={pending || disabled}
      onClick={onAsk}
    >
      {label}
    </Button>
  );
}
