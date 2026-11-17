"use client";

import { rolePermissions, type Role } from "@atlas/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import {
  amountAfterBlur,
  canShowCashAppQr,
  cashAppAccessNotice,
  cashAppAttemptFeedback,
  cashAppQrLayout,
  CASH_APP_RESULT_VISIBLE_MS,
  createSendLock,
  DEFAULT_CASH_APP_AMOUNT,
  formatCashAppHistory,
  parseCashAppAmount,
  sendCashAppQr,
  type CashAppInvoiceView
} from "./cash-app-qr";

/**
 * Cash App QR controls for the open Telegram chat.
 * Visible for every authorized player, including players with no leaderboard profile.
 */
export function CashAppQrSection({ chatId, embedded = false }: { readonly chatId: string; readonly embedded?: boolean }) {
  const role = useAuthStore((state) => state.user?.role);
  const permissions = role ? rolePermissions[role as Role] : [];
  const visible = canShowCashAppQr(role, permissions);
  const layout = cashAppQrLayout(embedded ? "mobile" : "desktop-panel");
  const [amount, setAmount] = useState(DEFAULT_CASH_APP_AMOUNT);
  const [canSend, setCanSend] = useState(false);
  const [maxAmountCents, setMaxAmountCents] = useState(500);
  const [attempt, setAttempt] = useState<CashAppInvoiceView | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archive, setArchive] = useState<readonly CashAppInvoiceView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tone, setTone] = useState<"neutral" | "ok" | "bad">("neutral");
  const [recoverInvoiceId, setRecoverInvoiceId] = useState<string | null>(null);
  const [unknownHold, setUnknownHold] = useState(false);
  const lock = useRef(createSendLock());
  const chatRef = useRef(chatId);
  const hideTimer = useRef<number | null>(null);
  const hideToken = useRef(0);
  chatRef.current = chatId;

  function clearResultTimer(): void {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }

  function showTemporaryResult(invoice: CashAppInvoiceView | null, message: string, nextTone: "neutral" | "ok" | "bad"): void {
    clearResultTimer();
    const token = hideToken.current + 1;
    hideToken.current = token;
    setAttempt(invoice);
    setNotice(message);
    setTone(nextTone);
    hideTimer.current = window.setTimeout(() => {
      if (hideToken.current !== token) return;
      setAttempt(null);
      setNotice((current) => (current === message ? null : current));
      hideTimer.current = null;
    }, CASH_APP_RESULT_VISIBLE_MS);
  }

  useEffect(() => {
    setAmount(DEFAULT_CASH_APP_AMOUNT);
    setRecoverInvoiceId(null);
    setUnknownHold(false);
    setNotice(null);
    setTone("neutral");
    setAttempt(null);
    setArchiveOpen(false);
    setArchive([]);
    clearResultTimer();
    hideToken.current += 1;
    let active = true;
    void api.pyeCashCapability(chatId).then(
      (capability) => {
        if (!active) return;
        setCanSend(capability.canSend);
        setMaxAmountCents(capability.maxAmountCents);
        const blocked = cashAppAccessNotice(capability);
        if (blocked) {
          setNotice(blocked);
          setTone("neutral");
        }
      },
      () => {
        if (!active) return;
        setCanSend(false);
        setNotice("Live payments are not enabled.");
      }
    );
    return () => {
      active = false;
      clearResultTimer();
      hideToken.current += 1;
    };
  }, [chatId]);

  if (!visible) return null;

  async function toggleArchive(): Promise<void> {
    if (archiveOpen) {
      setArchiveOpen(false);
      return;
    }
    const requestChatId = chatRef.current;
    setArchiveOpen(true);
    try {
      const page = await api.pyeCashInvoices(requestChatId);
      if (chatRef.current !== requestChatId) return;
      setArchive(page.invoices);
    } catch {
      if (chatRef.current === requestChatId) setArchive([]);
    }
  }

  const parsed = parseCashAppAmount(amount, maxAmountCents);
  const amountInvalid = "error" in parsed;

  async function onSend(): Promise<void> {
    if (!canSend || unknownHold || !lock.current.tryBegin()) return;
    const idempotencyKey = recoverInvoiceId ? `recover:${recoverInvoiceId}` : crypto.randomUUID();
    const requestChatId = chatRef.current;
    setBusy(true);
    clearResultTimer();
    hideToken.current += 1;
    setAttempt(null);
    setTone("neutral");
    setNotice("Sending QR…");
    const result = await sendCashAppQr({
      chatId: requestChatId,
      amountRaw: amount,
      maxAmountCents,
      enabled: canSend,
      idempotencyKey,
      recoverInvoiceId,
      gateway: {
        createInvoice: (id, body) => api.pyeCashCreateInvoice(id, body),
        queueQr: (id, invoiceId) => api.pyeCashQueueQr(id, invoiceId)
      },
      stillOnChat: () => chatRef.current === requestChatId
    });
    if (chatRef.current !== requestChatId) {
      lock.current.end();
      setBusy(false);
      return;
    }
    const feedback = cashAppAttemptFeedback(result);
    if (result.status === "queued" || (result.status === "failed" && result.invoice?.deliveryState === "SENT")) {
      setRecoverInvoiceId(null);
    } else if (result.status === "unknown") {
      setRecoverInvoiceId(null);
      setUnknownHold(true);
    } else if (result.status === "failed") {
      setRecoverInvoiceId(result.invoiceId);
    }
    if (feedback?.temporary) {
      showTemporaryResult(feedback.invoice, feedback.message, feedback.tone);
    } else if (feedback) {
      setNotice(feedback.message);
      setTone(feedback.tone);
    }
    lock.current.end();
    setBusy(false);
  }

  return (
    <section aria-label="Cash App QR">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Cash App QR</p>
      <div className={layout.row}>
        <label className={`${layout.input} flex h-9 items-center rounded-md border bg-white`}>
          <span className="pl-2 text-sm text-muted-foreground">$</span>
          <input
            value={amount}
            inputMode="decimal"
            disabled={busy || !canSend}
            aria-label="Cash App amount"
            className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none"
            onChange={(event) => setAmount(event.target.value)}
            onBlur={() => setAmount((current) => amountAfterBlur(current, maxAmountCents))}
          />
        </label>
        <Button type="button" className={`h-9 px-3 text-xs ${layout.button}`} disabled={busy || !canSend || unknownHold || amountInvalid} onClick={() => void onSend()}>
          {busy ? "Sending…" : "Send QR"}
        </Button>
      </div>
      {amountInvalid ? <p className="mt-1 text-xs text-red-700">{parsed.error}</p> : null}
      {notice ? (
        <p className={`mt-1 text-xs ${tone === "bad" ? "text-red-700" : tone === "ok" ? "text-emerald-700" : "text-muted-foreground"}`} role="status">
          {notice}
        </p>
      ) : null}
      {attempt ? <ul className="mt-2 space-y-1">{renderInvoice(attempt)}</ul> : null}
      <button
        type="button"
        className="mt-2 text-[11px] text-muted-foreground underline"
        onClick={() => void toggleArchive()}
      >
        Payment history
      </button>
      {archiveOpen ? (
        <ul className="mt-1 space-y-1">
          {archive.length > 0 ? archive.map((invoice) => renderInvoice(invoice)) : <li className="text-[11px] text-muted-foreground">No invoices stored for this chat.</li>}
        </ul>
      ) : null}
    </section>
  );
}

function renderInvoice(invoice: CashAppInvoiceView) {
  const line = formatCashAppHistory(invoice);
  return (
    <li key={invoice.id} className="rounded-md border px-2 py-1 text-[11px] leading-4">
      <span className="font-medium">{line.amount}</span>
      <span className="text-muted-foreground"> · {line.creationState} · {line.deliveryState}</span>
      <span className="block text-muted-foreground">{line.expiration}</span>
      {line.error ? <span className="block text-red-700">{line.error}</span> : null}
      {line.paid ? <span className="block text-emerald-700">Paid</span> : null}
    </li>
  );
}
