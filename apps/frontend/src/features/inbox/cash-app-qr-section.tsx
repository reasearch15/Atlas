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
  cashAppQrLayout,
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
  const [history, setHistory] = useState<readonly CashAppInvoiceView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tone, setTone] = useState<"neutral" | "ok" | "bad">("neutral");
  const [recoverInvoiceId, setRecoverInvoiceId] = useState<string | null>(null);
  const [unknownHold, setUnknownHold] = useState(false);
  const lock = useRef(createSendLock());
  const chatRef = useRef(chatId);
  chatRef.current = chatId;

  useEffect(() => {
    setAmount(DEFAULT_CASH_APP_AMOUNT);
    setRecoverInvoiceId(null);
    setUnknownHold(false);
    setNotice(null);
    setTone("neutral");
    setHistory([]);
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
    void api.pyeCashInvoices(chatId).then(
      (page) => {
        if (active) setHistory(page.invoices);
      },
      () => {
        if (active) setHistory([]);
      }
    );
    return () => {
      active = false;
    };
  }, [chatId]);

  if (!visible) return null;

  const parsed = parseCashAppAmount(amount, maxAmountCents);
  const amountInvalid = "error" in parsed;

  async function onSend(): Promise<void> {
    if (!canSend || unknownHold || !lock.current.tryBegin()) return;
    const idempotencyKey = recoverInvoiceId ? `recover:${recoverInvoiceId}` : crypto.randomUUID();
    const requestChatId = chatRef.current;
    setBusy(true);
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
    if (result.status === "queued") {
      setRecoverInvoiceId(null);
      setNotice(result.invoice.deliveryState === "SENT" ? "QR sent." : "QR queued for Telegram.");
      setTone("ok");
      setHistory((current) => [result.invoice, ...current.filter((item) => item.id !== result.invoice.id)].slice(0, 8));
    } else if (result.status === "unknown") {
      setRecoverInvoiceId(null);
      setUnknownHold(true);
      setNotice("Invoice outcome is unknown. It was not retried.");
      setTone("bad");
      setHistory((current) => [result.invoice, ...current.filter((item) => item.id !== result.invoice.id)].slice(0, 8));
    } else if (result.status === "failed") {
      setRecoverInvoiceId(result.invoiceId);
      setNotice(result.invoiceId ? "QR was not queued. Send again to reuse this invoice." : result.message);
      setTone("bad");
    } else if (result.status === "invalid") {
      setNotice(result.message);
      setTone("bad");
    } else if (result.status === "disabled") {
      setNotice("Live payments are not enabled.");
      setTone("neutral");
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
      {history.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {history.slice(0, 5).map((invoice) => {
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
          })}
        </ul>
      ) : null}
    </section>
  );
}
