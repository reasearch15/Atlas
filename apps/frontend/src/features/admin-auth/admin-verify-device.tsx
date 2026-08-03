"use client";

import type { AdminLoginChallengeResponse } from "@atlas/shared";
import { ArrowLeft, MailCheck, RotateCcw, ShieldCheck } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminResendCode, adminVerifyDevice } from "@/lib/api";
import { getPostLoginRoute } from "@/lib/post-login-route";

/**
 * Renders the Platform Admin new-device verification form.
 */
export function AdminVerifyDevice() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [challenge, setChallenge] = useState<AdminLoginChallengeResponse | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const raw = sessionStorage.getItem("atlas-admin-challenge");
    if (!raw) {
      router.replace("/admin/login" as Route);
      return;
    }
    setChallenge(JSON.parse(raw) as AdminLoginChallengeResponse);
    inputRef.current?.focus();
  }, [router]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const secondsUntilExpiry = Math.max(0, Math.ceil(((challenge ? Date.parse(challenge.expiresAt) : now) - now) / 1000));
  const secondsUntilResend = Math.max(0, Math.ceil(((challenge ? Date.parse(challenge.resendAvailableAt) : now) - now) / 1000));
  const codeDigits = useMemo(() => Array.from({ length: 6 }, (_, index) => code[index] ?? ""), [code]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!challenge || code.length !== 6) return;
    setLoading(true);
    try {
      await adminVerifyDevice({ challengeId: challenge.challengeId, code });
      sessionStorage.removeItem("atlas-admin-challenge");
      router.replace(getPostLoginRoute("PLATFORM_ADMIN") as Route);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed.");
    } finally {
      setLoading(false);
    }
  }

  async function resend(): Promise<void> {
    if (!challenge || secondsUntilResend > 0) return;
    try {
      const response = await adminResendCode(challenge.challengeId);
      const nextChallenge = { ...challenge, ...response };
      sessionStorage.setItem("atlas-admin-challenge", JSON.stringify(nextChallenge));
      setChallenge(nextChallenge);
      setCode("");
      inputRef.current?.focus();
      toast.success("Verification code sent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to resend code.");
    }
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(135deg,#f8fbfa,#eef4f2)] px-4 py-10">
      <section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
        <form onSubmit={submit} className="w-full rounded-lg border bg-white p-6 shadow-sm">
          <div className="mb-6 flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <MailCheck className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Verify new device</h1>
              <p className="mt-1 text-sm text-muted-foreground">We sent a verification code to {challenge?.maskedEmail ?? "your admin email"}.</p>
            </div>
          </div>

          <div className="relative">
            <Input
              ref={inputRef}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="absolute h-px w-px opacity-0"
              aria-label="Six-digit verification code"
            />
            <button type="button" className="grid w-full grid-cols-6 gap-2" onClick={() => inputRef.current?.focus()}>
              {codeDigits.map((digit, index) => (
                <span key={index} className="flex aspect-square items-center justify-center rounded-md border bg-white text-2xl font-semibold">
                  {digit}
                </span>
              ))}
            </button>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">{secondsUntilExpiry > 0 ? `Code expires in ${secondsUntilExpiry}s.` : "This code has expired."}</p>

          <Button className="mt-5 w-full" disabled={loading || code.length !== 6 || secondsUntilExpiry === 0}>
            <ShieldCheck className="size-4" aria-hidden="true" />
            {loading ? "Verifying..." : "Verify"}
          </Button>

          <div className="mt-4 flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => router.push("/admin/login" as Route)}>
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back
            </Button>
            <Button type="button" variant="secondary" onClick={resend} disabled={secondsUntilResend > 0}>
              <RotateCcw className="size-4" aria-hidden="true" />
              {secondsUntilResend > 0 ? `${secondsUntilResend}s` : "Resend"}
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
