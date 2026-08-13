"use client";

import type {
  LeaderboardAdminCompetitionDto,
  LeaderboardCompetitionReviewDto,
  LeaderboardEventRowDto,
  LeaderboardPayoutDto,
  LeaderboardPlayerSearchHitDto,
  LeaderboardPoolRateHistoryDto,
  LeaderboardReferralAdminRowDto,
  LeaderboardSettingsDto,
  LeaderboardStandingRowDto,
  LeaderboardTelegramIntegrationDto
} from "@atlas/shared";
import { ApiClientError } from "@/lib/api-client-error";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatMoneyFromCents, mapLeaderboardError, newIdempotencyKey } from "./leaderboard-errors";
import { PlayerSearchAutocomplete } from "./player-search-autocomplete";
import { WheelCoadminControls } from "./wheel-coadmin-controls";

const POOL_RATE_OPTIONS = [
  { bps: 200 as const, label: "2%" },
  { bps: 300 as const, label: "3%" },
  { bps: 400 as const, label: "4%" },
  { bps: 500 as const, label: "5%" }
];

const EVENTS_PAGE_SIZE = 25;
const REVERSIBLE_TYPES = new Set(["DEPOSIT", "PROMOTION"]);

type ConfirmKind =
  | "disable"
  | "finalize"
  | "disconnect-bot"
  | { kind: "reverse"; eventId: string }
  | { kind: "override"; referralId: string }
  | { kind: "payout"; payoutId: string }
  | null;

/**
 * Coadmin-only Phase 3 control center. Never mount on Staff routes.
 * Separated from the player standings board above.
 */
export function LeaderboardCoadminControls() {
  const [settings, setSettings] = useState<LeaderboardSettingsDto | null>(null);
  const [history, setHistory] = useState<readonly LeaderboardPoolRateHistoryDto[]>([]);
  const [competition, setCompetition] = useState<LeaderboardAdminCompetitionDto | null>(null);
  const [events, setEvents] = useState<readonly LeaderboardEventRowDto[]>([]);
  const [eventsPage, setEventsPage] = useState(1);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [referrals, setReferrals] = useState<readonly LeaderboardReferralAdminRowDto[]>([]);
  const [review, setReview] = useState<LeaderboardCompetitionReviewDto | null>(null);
  const [payouts, setPayouts] = useState<readonly LeaderboardPayoutDto[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sendingLatest, setSendingLatest] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmKind>(null);

  const [reverseReason, setReverseReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideReferralId, setOverrideReferralId] = useState<string | null>(null);
  const [selectedReferrer, setSelectedReferrer] = useState<LeaderboardPlayerSearchHitDto | null>(null);
  const [payoutNotes, setPayoutNotes] = useState("");
  const [poolReason, setPoolReason] = useState("");
  const [telegram, setTelegram] = useState<LeaderboardTelegramIntegrationDto | null>(null);
  const [botToken, setBotToken] = useState("");
  const [channelRef, setChannelRef] = useState("");
  const [backfillSummary, setBackfillSummary] = useState<string | null>(null);

  const reverseKeyRef = useRef(newIdempotencyKey());
  const overrideKeyRef = useRef(newIdempotencyKey());
  const finalizeKeyRef = useRef(newIdempotencyKey());
  const payoutKeyRef = useRef(newIdempotencyKey());

  const refreshCore = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [nextSettings, nextHistory, nextCompetition, nextEvents, nextReferrals, nextTelegram] =
        await Promise.all([
          api.leaderboardSettings(),
          api.leaderboardPoolRateHistory(),
          api.leaderboardAdminCompetition(),
          api.leaderboardEvents({ page: eventsPage, pageSize: EVENTS_PAGE_SIZE }),
          api.leaderboardReferrals(),
          api.leaderboardTelegramIntegration().catch(() => null)
        ]);
      setSettings(nextSettings);
      setHistory(nextHistory);
      setCompetition(nextCompetition);
      setEvents(nextEvents.rows);
      setEventsTotal(nextEvents.total);
      setReferrals(nextReferrals);
      setTelegram(nextTelegram);
      setError(null);

      const status = nextCompetition?.status;
      if (nextCompetition && (status === "FROZEN" || status === "FINALIZED")) {
        const nextReview = await api.leaderboardCompetitionReview(nextCompetition.competitionId);
        setReview(nextReview);
        if (status === "FINALIZED") {
          const nextPayouts = await api.leaderboardPayouts(nextCompetition.competitionId);
          setPayouts(nextPayouts);
        } else {
          setPayouts([]);
        }
      } else {
        setReview(null);
        setPayouts([]);
      }
    } catch (loadError) {
      setError(mapLeaderboardError(loadError));
    } finally {
      setLoading(false);
    }
  }, [eventsPage]);

  useEffect(() => {
    void refreshCore();
  }, [refreshCore]);

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

  async function toggleEnabled(enabled: boolean, confirmDisable?: boolean): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const next = await api.leaderboardSetEnabled({
        enabled,
        ...(confirmDisable ? { confirmDisable: true } : {})
      });
      setSettings(next);
      toast.success(enabled ? "Leaderboard enabled." : "Leaderboard disabled.");
      setConfirming(null);
      await refreshCore();
    } catch (toggleError) {
      if (
        !enabled &&
        !confirmDisable &&
        toggleError instanceof ApiClientError &&
        toggleError.code === "CONFIRM_DISABLE_REQUIRED"
      ) {
        setConfirming("disable");
        return;
      }
      setError(mapLeaderboardError(toggleError));
    } finally {
      setPending(false);
    }
  }

  async function setPoolRate(poolRateBps: 200 | 300 | 400 | 500): Promise<void> {
    await runAction(async () => {
      const next = await api.leaderboardSetPoolRate({
        poolRateBps,
        ...(poolReason.trim() ? { reason: poolReason.trim() } : {})
      });
      setSettings(next);
      setPoolReason("");
      toast.success(`Prize pool contribution set to ${poolRateBps / 100}%.`);
      const nextHistory = await api.leaderboardPoolRateHistory();
      setHistory(nextHistory);
    });
  }

  async function submitReverse(eventId: string): Promise<void> {
    const reason = reverseReason.trim();
    if (reason.length < 3) {
      setError("Enter a reason (at least 3 characters) to reverse this event.");
      return;
    }
    await runAction(async () => {
      await api.leaderboardReverseEvent(eventId, {
        reason,
        idempotencyKey: reverseKeyRef.current
      });
      toast.success("Event reversed.");
      setReverseReason("");
      reverseKeyRef.current = newIdempotencyKey();
      await refreshCore();
    });
  }

  async function submitOverride(referralId: string): Promise<void> {
    if (!selectedReferrer) {
      setError("Select a new referrer first.");
      return;
    }
    const reason = overrideReason.trim();
    if (reason.length < 3) {
      setError("Enter a reason (at least 3 characters) to override this referral.");
      return;
    }
    await runAction(async () => {
      await api.leaderboardOverrideReferral(referralId, {
        newReferrerCrmContactId: selectedReferrer.crmContactId,
        reason,
        idempotencyKey: overrideKeyRef.current
      });
      toast.success("Referral override applied.");
      setOverrideReason("");
      setSelectedReferrer(null);
      setOverrideReferralId(null);
      overrideKeyRef.current = newIdempotencyKey();
      await refreshCore();
    });
  }

  async function setEligibility(
    crmContactId: string,
    membershipStatus: "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW"
  ): Promise<void> {
    if (!competition) return;
    await runAction(async () => {
      await api.leaderboardSetEligibility(competition.competitionId, crmContactId, {
        membershipStatus,
        idempotencyKey: newIdempotencyKey(),
        ...(membershipStatus === "NOT_ELIGIBLE"
          ? { ineligibilityReason: "Manual coadmin review" }
          : {})
      });
      toast.success("Eligibility updated.");
      const nextReview = await api.leaderboardCompetitionReview(competition.competitionId);
      setReview(nextReview);
    });
  }

  async function submitFinalize(): Promise<void> {
    if (!competition) return;
    await runAction(async () => {
      await api.leaderboardFinalize(competition.competitionId, {
        idempotencyKey: finalizeKeyRef.current,
        confirm: true
      });
      toast.success("Competition finalized.");
      finalizeKeyRef.current = newIdempotencyKey();
      await refreshCore();
    });
  }

  async function markPayoutPaid(payoutId: string): Promise<void> {
    await runAction(async () => {
      await api.leaderboardMarkPayout(payoutId, {
        status: "PAID",
        confirm: true,
        idempotencyKey: payoutKeyRef.current,
        ...(payoutNotes.trim() ? { notes: payoutNotes.trim() } : {})
      });
      toast.success("Payout marked as paid.");
      setPayoutNotes("");
      payoutKeyRef.current = newIdempotencyKey();
      if (competition) {
        const nextPayouts = await api.leaderboardPayouts(competition.competitionId);
        setPayouts(nextPayouts);
      }
    });
  }

  const eventPages = Math.max(1, Math.ceil(eventsTotal / EVENTS_PAGE_SIZE));
  const historyAscending = [...history].sort(
    (a, b) => new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime()
  );

  return (
    <div className="space-y-4 border-t border-border px-4 pb-10 pt-6 md:px-6 lg:px-8">
      <header className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Coadmin control center
        </p>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Leaderboard settings</h2>
        <p className="text-sm text-muted-foreground">
          Admin tools for enabling scoring, reviewing frozen results, and settling payouts. Not shown to
          staff.
        </p>
      </header>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading && !settings ? (
        <p className="text-sm text-muted-foreground">Loading control center…</p>
      ) : (
        <>
          {/* A. Status / Settings */}
          <section className="space-y-4 rounded-lg border bg-white p-5">
            <h3 className="text-sm font-semibold text-foreground">Leaderboard status</h3>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted-foreground">
                Status:{" "}
                <span className="font-medium text-foreground">
                  {settings?.enabled ? "Enabled" : "Disabled"}
                </span>
              </span>
              {confirming === "disable" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs text-amber-800">
                    An ACTIVE competition is running. Disable anyway?
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    disabled={pending}
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    className="h-8 px-3 text-xs"
                    disabled={pending}
                    onClick={() => void toggleEnabled(false, true)}
                  >
                    {pending ? "Working…" : "Confirm disable"}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant={settings?.enabled ? "danger" : "primary"}
                  className="h-8 px-3 text-xs"
                  disabled={pending || settings == null}
                  onClick={() => {
                    if (settings?.enabled) {
                      if (competition?.status === "ACTIVE") {
                        setConfirming("disable");
                        return;
                      }
                      void toggleEnabled(false);
                      return;
                    }
                    void toggleEnabled(true);
                  }}
                >
                  {settings?.enabled ? "Turn OFF" : "Turn ON"}
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Prize pool contribution
              </p>
              <div className="flex flex-wrap gap-1.5">
                {POOL_RATE_OPTIONS.map((option) => {
                  const active = settings?.poolRateBps === option.bps;
                  return (
                    <Button
                      key={option.bps}
                      type="button"
                      variant={active ? "primary" : "secondary"}
                      className="h-8 px-3 text-xs"
                      disabled={pending || settings == null}
                      onClick={() => {
                        if (!active) void setPoolRate(option.bps);
                      }}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
              <Input
                value={poolReason}
                onChange={(event) => setPoolReason(event.target.value)}
                placeholder="Optional reason for rate change"
                disabled={pending}
                className="h-8 max-w-md text-sm"
              />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Current prize pool</dt>
                <dd className="font-medium text-foreground">
                  {competition
                    ? formatMoneyFromCents(competition.prizePoolCents)
                    : formatMoneyFromCents(0)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Current contribution</dt>
                <dd className="font-medium text-foreground">
                  {settings ? `${settings.poolRateBps / 100}%` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Timezone</dt>
                <dd className="font-medium text-foreground">{settings?.timezone ?? "—"}</dd>
              </div>
            </dl>

            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Rate history
              </p>
              {historyAscending.length === 0 ? (
                <p className="text-xs text-muted-foreground">No rate changes recorded yet.</p>
              ) : (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {historyAscending.map((row, index) => {
                    const previous = index > 0 ? historyAscending[index - 1] : null;
                    return (
                      <li key={row.id} className="rounded-md border bg-muted/20 px-2 py-1.5">
                        {previous
                          ? `${previous.rateBps / 100}% → ${row.rateBps / 100}%`
                          : `${row.rateBps / 100}%`}
                        <span className="ml-2 text-muted-foreground">
                          {formatDateTime(row.effectiveFrom)}
                          {row.reason ? ` · ${row.reason}` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

          </section>

          <WheelCoadminControls />

          {/* A2. Telegram bot integration (Coadmin only) */}
          <section className="space-y-4 rounded-lg border bg-white p-5">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">Telegram bot integration</h3>
              <p className="text-xs text-muted-foreground">
                Dedicated Bot API bot for the public leaderboard channel and prize membership checks.
                Token is never shown after connect.
              </p>
            </div>

            {telegram?.disconnectWarning ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {telegram.disconnectWarning}
              </p>
            ) : null}

            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Bot</dt>
                <dd className="font-medium text-foreground">
                  {telegram?.connected
                    ? telegram.botUsername
                      ? `@${telegram.botUsername}`
                      : telegram.botDisplayName ?? "Connected"
                    : "Not connected"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Channel</dt>
                <dd className="font-medium text-foreground">
                  {telegram?.channelTitle || telegram?.channelId || "Not configured"}
                  {telegram?.channelVerified ? " · verified" : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Posting</dt>
                <dd className="font-medium text-foreground">
                  {telegram?.postingEnabled ? "Enabled" : "Disabled"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last error</dt>
                <dd className="font-medium text-foreground">{telegram?.lastError ?? "—"}</dd>
              </div>
            </dl>

            {!telegram?.connected ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] flex-1 space-y-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Bot token
                  </label>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={botToken}
                    onChange={(event) => setBotToken(event.target.value)}
                    placeholder="123456:ABC..."
                    className="h-9"
                  />
                </div>
                <Button
                  type="button"
                  className="h-9 px-3 text-xs"
                  disabled={pending || botToken.trim().length < 20}
                  onClick={() =>
                    void runAction(async () => {
                      const next = await api.leaderboardTelegramConnect({ token: botToken.trim() });
                      setTelegram(next);
                      setBotToken("");
                      toast.success("Leaderboard bot connected.");
                    })
                  }
                >
                  Connect bot
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {telegram.botDeepLink ? (
                  <p className="text-sm text-muted-foreground">
                    Player bot link:{" "}
                    <a
                      href={telegram.botDeepLink}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      {telegram.botDeepLink}
                    </a>
                  </p>
                ) : null}
                {telegram.webhookConfigured ? (
                  <p className="text-xs text-muted-foreground">
                    Webhook registered
                    {telegram.lastInboundAt
                      ? ` · last inbound ${new Date(telegram.lastInboundAt).toLocaleString()}`
                      : ""}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Webhook not registered — players cannot use /start until configured.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    disabled={pending}
                    onClick={() =>
                      void runAction(async () => {
                        const next = await api.leaderboardTelegramTest();
                        setTelegram(next);
                        toast.success("Bot connection OK.");
                      })
                    }
                  >
                    Test connection
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    disabled={pending}
                    onClick={() =>
                      void runAction(async () => {
                        const next = await api.leaderboardTelegramRegisterWebhook();
                        setTelegram(next);
                        toast.success("Webhook registered.");
                      })
                    }
                  >
                    Register webhook
                  </Button>
                  <Button
                    type="button"
                    variant={telegram.postingEnabled ? "danger" : "primary"}
                    className="h-8 px-3 text-xs"
                    disabled={pending || (!telegram.postingEnabled && !telegram.channelVerified)}
                    onClick={() =>
                      void runAction(async () => {
                        const next = await api.leaderboardTelegramSetPosting({
                          postingEnabled: !telegram.postingEnabled
                        });
                        setTelegram(next);
                        toast.success(
                          next.postingEnabled ? "Public posting enabled." : "Public posting disabled."
                        );
                      })
                    }
                  >
                    {telegram.postingEnabled ? "Disable posting" : "Enable posting"}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    className="h-8 px-3 text-xs font-semibold"
                    disabled={
                      pending ||
                      sendingLatest ||
                      !telegram.channelId ||
                      !telegram.channelVerified ||
                      !telegram.postingEnabled
                    }
                    title={
                      !telegram.postingEnabled
                        ? "Enable posting first."
                        : !telegram.channelVerified
                          ? "Verify the channel first."
                          : !telegram.channelId
                            ? "Set a channel first."
                            : "Publish the current Top 10 leaderboard snapshot to Telegram."
                    }
                    onClick={() =>
                      void (async () => {
                        setSendingLatest(true);
                        setError(null);
                        try {
                          const result = await api.leaderboardTelegramSendLatest();
                          toast.success(`✓ ${result.message}`);
                        } catch (actionError) {
                          const mapped = mapLeaderboardError(actionError);
                          setError(mapped);
                          toast.error(mapped);
                        } finally {
                          setSendingLatest(false);
                        }
                      })()
                    }
                  >
                    {sendingLatest ? "Sending..." : "🏆 Send Leaderboard"}
                  </Button>
                  {confirming === "disconnect-bot" ? (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-8 px-3 text-xs"
                        disabled={pending}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        className="h-8 px-3 text-xs"
                        disabled={pending}
                        onClick={() =>
                          void runAction(async () => {
                            const next = await api.leaderboardTelegramDisconnect({ confirm: true });
                            setTelegram(next);
                            setConfirming(null);
                            toast.success("Bot disconnected.");
                          })
                        }
                      >
                        Confirm disconnect
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="danger"
                      className="h-8 px-3 text-xs"
                      disabled={pending}
                      onClick={() => setConfirming("disconnect-bot")}
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
                {!telegram.postingEnabled ? (
                  <p className="text-[11px] text-muted-foreground">
                    Enable posting to use Send Leaderboard.
                  </p>
                ) : !telegram.channelVerified ? (
                  <p className="text-[11px] text-muted-foreground">
                    Verify the channel to use Send Leaderboard.
                  </p>
                ) : null}

                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[220px] flex-1 space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Channel (@username or id)
                    </label>
                    <Input
                      value={channelRef}
                      onChange={(event) => setChannelRef(event.target.value)}
                      placeholder={telegram.channelId ?? "@mychannel"}
                      className="h-9"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-9 px-3 text-xs"
                    disabled={pending || channelRef.trim().length < 1}
                    onClick={() =>
                      void runAction(async () => {
                        const next = await api.leaderboardTelegramSetChannel({
                          channelRef: channelRef.trim()
                        });
                        setTelegram(next);
                        toast.success("Channel saved. Verify before enabling posting.");
                      })
                    }
                  >
                    Save channel
                  </Button>
                  <Button
                    type="button"
                    className="h-9 px-3 text-xs"
                    disabled={pending || !telegram.channelId}
                    onClick={() =>
                      void runAction(async () => {
                        const next = await api.leaderboardTelegramVerifyChannel();
                        setTelegram(next);
                        toast.success("Channel verified.");
                      })
                    }
                  >
                    Verify channel
                  </Button>
                </div>

                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[220px] flex-1 space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Rotate token
                    </label>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={botToken}
                      onChange={(event) => setBotToken(event.target.value)}
                      placeholder="New bot token"
                      className="h-9"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-9 px-3 text-xs"
                    disabled={pending || botToken.trim().length < 20}
                    onClick={() =>
                      void runAction(async () => {
                        const next = await api.leaderboardTelegramRotateToken({
                          token: botToken.trim()
                        });
                        setTelegram(next);
                        setBotToken("");
                        toast.success("Bot token rotated.");
                      })
                    }
                  >
                    Rotate
                  </Button>
                </div>

                {competition?.status === "FROZEN" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    disabled={pending}
                    onClick={() =>
                      void runAction(async () => {
                        await api.leaderboardVerifyMembership(competition.competitionId);
                        toast.success("Membership verification queued.");
                        const nextReview = await api.leaderboardCompetitionReview(
                          competition.competitionId
                        );
                        setReview(nextReview);
                      })
                    }
                  >
                    Verify membership now
                  </Button>
                ) : null}

                <div className="space-y-2 border-t pt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Participant backfill (sole-owner workspaces)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 px-3 text-xs"
                      disabled={pending}
                      onClick={() =>
                        void runAction(async () => {
                          const result = await api.leaderboardParticipantsBackfill({ dryRun: true });
                          const summary = `Dry run: scanned ${result.scanned}, would bind ${result.bound}, already ${result.alreadyBound}, ambiguous ${result.ambiguous}, skipped ${result.skipped}`;
                          setBackfillSummary(summary);
                          toast.success("Backfill dry-run complete.");
                        })
                      }
                    >
                      Backfill dry-run
                    </Button>
                    <Button
                      type="button"
                      className="h-8 px-3 text-xs"
                      disabled={pending}
                      onClick={() =>
                        void runAction(async () => {
                          const result = await api.leaderboardParticipantsBackfill({ dryRun: false });
                          const summary = `Bound ${result.bound}, already ${result.alreadyBound}, skipped ${result.skipped}, failed ${result.failed}`;
                          setBackfillSummary(summary);
                          toast.success("Backfill complete.");
                        })
                      }
                    >
                      Run backfill
                    </Button>
                  </div>
                  {backfillSummary ? (
                    <p className="text-xs text-muted-foreground">{backfillSummary}</p>
                  ) : null}
                </div>
              </div>
            )}
          </section>

          {/* B. Competition admin */}
          <section className="space-y-3 rounded-lg border bg-white p-5">
            <h3 className="text-sm font-semibold text-foreground">Competition admin</h3>
            {!competition ? (
              <p className="text-sm text-muted-foreground">No competition available.</p>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
                  <Stat label="Status" value={competition.status} />
                  <Stat label="Sequence" value={`#${competition.sequence}`} />
                  <Stat label="Players" value={String(competition.playerCount)} />
                  <Stat label="Prize pool" value={formatMoneyFromCents(competition.prizePoolCents)} />
                  <Stat label="Starts" value={formatDateTime(competition.startsAt)} />
                  <Stat label="Ends" value={formatDateTime(competition.endsAt)} />
                  <Stat label="Time remaining" value={formatTimeRemaining(competition.endsAt)} wide />
                </dl>
                <StandingSummary title="Top 3" rows={competition.top3} />
                <StandingSummary title="Top 10" rows={competition.top10} />
              </>
            )}
          </section>

          {/* C. Event history */}
          <section className="space-y-3 rounded-lg border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Event history</h3>
              <p className="text-xs text-muted-foreground">
                Page {eventsPage} of {eventPages} · {eventsTotal} events
              </p>
            </div>
            <div className="overflow-x-auto">
              {events.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">No events yet.</p>
              ) : (
                <table className="min-w-[56rem] w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-2 font-semibold">When</th>
                      <th className="px-2 py-2 font-semibold">Player</th>
                      <th className="px-2 py-2 font-semibold">Type</th>
                      <th className="px-2 py-2 font-semibold">Points</th>
                      <th className="px-2 py-2 font-semibold">Deposit</th>
                      <th className="px-2 py-2 font-semibold">Pool</th>
                      <th className="px-2 py-2 font-semibold">Status</th>
                      <th className="px-2 py-2 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => {
                      const canReverse =
                        REVERSIBLE_TYPES.has(event.type) && !event.reversed && !event.reversesEventId;
                      const reversing =
                        confirming !== null &&
                        typeof confirming === "object" &&
                        confirming.kind === "reverse" &&
                        confirming.eventId === event.id;
                      return (
                        <tr key={event.id} className="border-b last:border-0">
                          <td className="px-2 py-2 text-xs text-muted-foreground">
                            {formatDateTime(event.occurredAt)}
                          </td>
                          <td className="px-2 py-2">{event.displayName}</td>
                          <td className="px-2 py-2">{event.type}</td>
                          <td className="px-2 py-2">{event.pointsDelta}</td>
                          <td className="px-2 py-2">
                            {event.depositAmountCents != null
                              ? formatMoneyFromCents(event.depositAmountCents)
                              : "—"}
                          </td>
                          <td className="px-2 py-2">
                            {event.poolContributionCents != null
                              ? formatMoneyFromCents(event.poolContributionCents)
                              : "—"}
                          </td>
                          <td className="px-2 py-2 text-xs">
                            {event.reversed ? "Reversed" : event.reversesEventId ? "Reversal" : "Active"}
                          </td>
                          <td className="px-2 py-2">
                            {canReverse ? (
                              reversing ? (
                                <div className="space-y-1.5">
                                  <Input
                                    value={reverseReason}
                                    onChange={(e) => setReverseReason(e.target.value)}
                                    placeholder="Reason required"
                                    disabled={pending}
                                    className="h-8 text-xs"
                                  />
                                  <div className="flex flex-wrap gap-1.5">
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      className="h-7 px-2 text-xs"
                                      disabled={pending}
                                      onClick={() => {
                                        setConfirming(null);
                                        setReverseReason("");
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="danger"
                                      className="h-7 px-2 text-xs"
                                      disabled={pending}
                                      onClick={() => void submitReverse(event.id)}
                                    >
                                      {pending ? "Working…" : "Confirm reverse"}
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <Button
                                  type="button"
                                  variant="danger"
                                  className="h-7 px-2 text-xs"
                                  disabled={pending}
                                  onClick={() => {
                                    setReverseReason("");
                                    setConfirming({ kind: "reverse", eventId: event.id });
                                  }}
                                >
                                  Reverse
                                </Button>
                              )
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="h-8 px-3 text-xs"
                disabled={pending || eventsPage <= 1}
                onClick={() => setEventsPage((page) => Math.max(1, page - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="h-8 px-3 text-xs"
                disabled={pending || eventsPage >= eventPages}
                onClick={() => setEventsPage((page) => page + 1)}
              >
                Next
              </Button>
            </div>
          </section>

          {/* D. Referrals */}
          <section className="space-y-3 rounded-lg border bg-white p-5">
            <h3 className="text-sm font-semibold text-foreground">Referrals</h3>
            {referrals.length === 0 ? (
              <p className="text-sm text-muted-foreground">No referrals linked yet.</p>
            ) : (
              <ul className="space-y-3">
                {referrals.map((row) => {
                  const overriding =
                    overrideReferralId === row.id ||
                    (confirming !== null &&
                      typeof confirming === "object" &&
                      confirming.kind === "override" &&
                      confirming.referralId === row.id);
                  return (
                    <li key={row.id} className="rounded-md border px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-foreground">
                            {row.referrerDisplayName} → {row.referredDisplayName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Lifetime qualifying:{" "}
                            {formatMoneyFromCents(row.lifetimeQualifyingDepositCents)} · Linked{" "}
                            {formatDateTime(row.createdAt)}
                            {row.overriddenAt
                              ? ` · Overridden ${formatDateTime(row.overriddenAt)}`
                              : ""}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Milestones:{" "}
                            {row.milestones.length === 0
                              ? "None yet"
                              : row.milestones
                                  .map((m) => `${m.code} (+${m.points}, ${m.status})`)
                                  .join(" · ")}
                          </p>
                        </div>
                        {!overriding ? (
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-8 px-3 text-xs"
                            disabled={pending}
                            onClick={() => {
                              setOverrideReferralId(row.id);
                              setSelectedReferrer(null);
                              setOverrideReason("");
                              setConfirming(null);
                            }}
                          >
                            Override referrer
                          </Button>
                        ) : null}
                      </div>
                      {overriding ? (
                        <div className="mt-2 space-y-2 border-t pt-2">
                          <PlayerSearchAutocomplete
                            excludeContactId={row.referredCrmContactId}
                            disabled={pending}
                            selected={selectedReferrer}
                            onSelect={setSelectedReferrer}
                            onClear={() => setSelectedReferrer(null)}
                            placeholder="Search new referrer…"
                            limit={25}
                          />
                          <Input
                            value={overrideReason}
                            onChange={(event) => setOverrideReason(event.target.value)}
                            placeholder="Reason required"
                            disabled={pending}
                            className="h-8 text-sm"
                          />
                          {confirming !== null &&
                          typeof confirming === "object" &&
                          confirming.kind === "override" &&
                          confirming.referralId === row.id ? (
                            <div className="flex flex-wrap gap-1.5">
                              <Button
                                type="button"
                                variant="secondary"
                                className="h-8 px-3 text-xs"
                                disabled={pending}
                                onClick={() => setConfirming(null)}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                variant="danger"
                                className="h-8 px-3 text-xs"
                                disabled={pending || !selectedReferrer}
                                onClick={() => void submitOverride(row.id)}
                              >
                                {pending ? "Working…" : "Confirm override"}
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              <Button
                                type="button"
                                variant="secondary"
                                className="h-8 px-3 text-xs"
                                disabled={pending}
                                onClick={() => {
                                  setOverrideReferralId(null);
                                  setSelectedReferrer(null);
                                  setOverrideReason("");
                                }}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                variant="danger"
                                className="h-8 px-3 text-xs"
                                disabled={pending || !selectedReferrer || overrideReason.trim().length < 3}
                                onClick={() => setConfirming({ kind: "override", referralId: row.id })}
                              >
                                Review & confirm
                              </Button>
                            </div>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* E. Frozen review / finalize / payouts */}
          {competition && (competition.status === "FROZEN" || competition.status === "FINALIZED") ? (
            <section className="space-y-4 rounded-lg border bg-white p-5">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-foreground">
                  Frozen review / finalize / payouts
                </h3>
                <p className="text-xs text-amber-800">
                  Leaderboard rank is not the same as prize rank. Prize winners are selected only from
                  eligible players after membership review.
                </p>
              </div>

              {!review ? (
                <p className="text-sm text-muted-foreground">Loading review…</p>
              ) : (
                <>
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Leaderboard results (points rank)
                    </h4>
                    <StandingSummary title="Top 10 by points" rows={review.leaderboardTop10} />
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Eligibility review
                    </h4>
                    <div className="overflow-x-auto">
                      <table className="min-w-[48rem] w-full border-collapse text-left text-sm">
                        <thead>
                          <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th className="px-2 py-2 font-semibold">LB rank</th>
                            <th className="px-2 py-2 font-semibold">Player</th>
                            <th className="px-2 py-2 font-semibold">Points</th>
                            <th className="px-2 py-2 font-semibold">Membership</th>
                            <th className="px-2 py-2 font-semibold">Prize rank</th>
                            <th className="px-2 py-2 font-semibold">Set status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {review.eligibilityCandidates.map((candidate) => (
                            <tr key={candidate.crmContactId} className="border-b last:border-0">
                              <td className="px-2 py-2">#{candidate.leaderboardRank}</td>
                              <td className="px-2 py-2">{candidate.displayName}</td>
                              <td className="px-2 py-2">{candidate.totalPoints}</td>
                              <td className="px-2 py-2 text-xs">
                                {candidate.membershipStatus === "PENDING_REVIEW"
                                  ? "Subscription verification pending"
                                  : candidate.membershipStatus}
                              </td>
                              <td className="px-2 py-2">
                                {candidate.prizeRank != null ? `#${candidate.prizeRank}` : "—"}
                              </td>
                              <td className="px-2 py-2">
                                {review.winnersLocked || competition.status === "FINALIZED" ? (
                                  <span className="text-xs text-muted-foreground">Locked</span>
                                ) : (
                                  <div className="flex flex-wrap gap-1">
                                    {(
                                      ["ELIGIBLE", "NOT_ELIGIBLE", "PENDING_REVIEW"] as const
                                    ).map((status) => (
                                      <Button
                                        key={status}
                                        type="button"
                                        variant={
                                          candidate.membershipStatus === status
                                            ? "primary"
                                            : "secondary"
                                        }
                                        className="h-7 px-2 text-[10px]"
                                        disabled={pending || candidate.membershipStatus === status}
                                        onClick={() =>
                                          void setEligibility(candidate.crmContactId, status)
                                        }
                                      >
                                        {status === "PENDING_REVIEW" ? "Pending" : status}
                                      </Button>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Prize winners preview
                    </h4>
                    {review.prizeWinnersPreview.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No prize winners selected yet (pending eligibility may block selection).
                      </p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {review.prizeWinnersPreview.map((winner) => (
                          <li key={winner.crmContactId} className="rounded-md border px-2 py-1.5">
                            Prize #{winner.prizeRank} · {winner.displayName} · LB #
                            {winner.leaderboardRank} · {winner.totalPoints} pts
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {competition.status === "FROZEN" ? (
                    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-3">
                      {review.finalizeBlockReason ? (
                        <p className="text-xs text-amber-900">{review.finalizeBlockReason}</p>
                      ) : null}
                      {confirming === "finalize" ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-8 px-3 text-xs"
                            disabled={pending}
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            variant="danger"
                            className="h-8 px-3 text-xs"
                            disabled={pending || !review.canFinalize}
                            onClick={() => void submitFinalize()}
                          >
                            {pending ? "Working…" : "Confirm finalize"}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="danger"
                          className="h-8 px-3 text-xs"
                          disabled={pending || !review.canFinalize}
                          onClick={() => setConfirming("finalize")}
                        >
                          Finalize competition
                        </Button>
                      )}
                    </div>
                  ) : null}

                  {competition.status === "FINALIZED" ? (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Payouts
                      </h4>
                      <Input
                        value={payoutNotes}
                        onChange={(event) => setPayoutNotes(event.target.value)}
                        placeholder="Optional notes when marking paid"
                        disabled={pending}
                        className="h-8 max-w-md text-sm"
                      />
                      {payouts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No payouts recorded.</p>
                      ) : (
                        <ul className="space-y-2">
                          {payouts.map((payout) => {
                            const marking =
                              confirming !== null &&
                              typeof confirming === "object" &&
                              confirming.kind === "payout" &&
                              confirming.payoutId === payout.id;
                            return (
                              <li
                                key={payout.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                              >
                                <div>
                                  <p className="font-medium">
                                    Prize #{payout.prizeRank} · {payout.displayName}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    LB rank #{payout.leaderboardRank} ·{" "}
                                    {formatMoneyFromCents(payout.payoutCents)} · {payout.status}
                                    {payout.notes ? ` · ${payout.notes}` : ""}
                                  </p>
                                </div>
                                {payout.status === "UNPAID" ? (
                                  marking ? (
                                    <div className="flex flex-wrap gap-1.5">
                                      <Button
                                        type="button"
                                        variant="secondary"
                                        className="h-8 px-3 text-xs"
                                        disabled={pending}
                                        onClick={() => setConfirming(null)}
                                      >
                                        Cancel
                                      </Button>
                                      <Button
                                        type="button"
                                        className="h-8 px-3 text-xs"
                                        disabled={pending}
                                        onClick={() => void markPayoutPaid(payout.id)}
                                      >
                                        {pending ? "Working…" : "Confirm paid"}
                                      </Button>
                                    </div>
                                  ) : (
                                    <Button
                                      type="button"
                                      className="h-8 px-3 text-xs"
                                      disabled={pending}
                                      onClick={() =>
                                        setConfirming({ kind: "payout", payoutId: payout.id })
                                      }
                                    >
                                      Mark paid
                                    </Button>
                                  )
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
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
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function StandingSummary({
  title,
  rows
}: {
  readonly title: string;
  readonly rows: readonly LeaderboardStandingRowDto[];
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{title}: none</p>;
  }
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="space-y-1 text-xs">
        {rows.map((row) => (
          <li key={`${title}-${row.crmContactId}`} className="rounded-md border bg-muted/20 px-2 py-1">
            #{row.rank} {row.displayName}
            {row.telegramUsername ? ` (@${row.telegramUsername})` : ""} · {row.totalPoints} pts
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatTimeRemaining(endsAt: string): string {
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return "—";
  const ms = end - Date.now();
  if (ms <= 0) return "Ended";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
