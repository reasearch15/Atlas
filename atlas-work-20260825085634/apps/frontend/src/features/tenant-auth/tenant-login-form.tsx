"use client";

import { LogIn } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTenantLoginSessionGate } from "@/features/auth/use-tenant-login-session-gate";
import { loginPasswordInputProps, loginUsernameInputProps } from "@/lib/auth-form-fields";
import { ApiClientError } from "@/lib/api-client-error";
import { coadminLogin, staffLogin } from "@/lib/api";
import { getPostLoginRoute } from "@/lib/post-login-route";
import { isPasswordChangeRequired, readPasswordChangeToken } from "@/lib/tenant-login-response";
import {
  storeTenantPasswordChangeChallenge,
  tenantPasswordChangeStorageKey
} from "@/lib/tenant-password-change-storage";
import {
  applyRememberUsernamePreference,
  getRememberedUsername,
  normalizeUsername
} from "@/lib/remembered-username";
import {
  formatLoginRetryCountdown,
  loginErrorMessage,
  shouldAcceptLoginSubmit
} from "./login-error";

export { tenantPasswordChangeStorageKey };

/**
 * Renders username/password login with mandatory first-login password change.
 */
export function TenantLoginForm({ role }: { readonly role: "coadmin" | "staff" }) {
  const router = useRouter();
  const sessionGate = useTenantLoginSessionGate({ expectedRole: role === "coadmin" ? "COADMIN" : "STAFF" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberUsername, setRememberUsername] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const title = role === "coadmin" ? "Coadmin Login" : "Staff Login";
  const changeRoute = role === "coadmin" ? "/coadmin/change-password" : "/staff/change-password";

  useEffect(() => {
    const remembered = getRememberedUsername();
    if (!remembered) return;
    setUsername(remembered);
    setRememberUsername(true);
  }, []);

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setRetryAfterSeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
    // Restart only when entering/leaving lockout, not every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boolean lock gate
  }, [retryAfterSeconds > 0]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!shouldAcceptLoginSubmit(pendingRef.current) || retryAfterSeconds > 0) return;
    pendingRef.current = true;
    setLoading(true);
    setFormError(null);
    try {
      const normalized = normalizeUsername(username);
      const login = role === "coadmin" ? coadminLogin : staffLogin;
      const response = await login({ username: normalized, password });
      applyRememberUsernamePreference(normalized, rememberUsername);
      setPassword("");
      setRetryAfterSeconds(0);
      if (isPasswordChangeRequired(response)) {
        const passwordChangeToken = readPasswordChangeToken(response);
        if (!passwordChangeToken) {
          throw new Error("Password change is required, but no change token was returned.");
        }
        // Store before navigation. Hard navigate so soft-router races cannot remount login.
        storeTenantPasswordChangeChallenge(role, { passwordChangeToken, username: normalized });
        window.location.assign(changeRoute);
        return;
      }
      router.replace(getPostLoginRoute(response.user.role) as Route);
    } catch (error) {
      if (error instanceof ApiClientError && error.isRateLimited) {
        const seconds = error.retryAfterSeconds && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
        setRetryAfterSeconds(seconds);
        const message = loginErrorMessage(error, seconds);
        setFormError(message);
        toast.error(message);
      } else {
        const message = loginErrorMessage(error);
        setFormError(message);
        toast.error(message);
      }
    } finally {
      pendingRef.current = false;
      setLoading(false);
    }
  }

  if (sessionGate.status === "checking" || sessionGate.status === "authenticated") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[linear-gradient(135deg,#f8fbfa,#eef4f2)] px-4 text-sm text-muted-foreground">
        Restoring your session...
      </main>
    );
  }

  const lockedOut = retryAfterSeconds > 0;
  const signInDisabled = loading || lockedOut;

  return (
    <main className="min-h-screen bg-[linear-gradient(135deg,#f8fbfa,#eef4f2)] px-4 py-10">
      <section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
        <form method="post" onSubmit={submit} className="w-full rounded-lg border bg-white p-6 shadow-sm" autoComplete="on">
          <div className="mb-6">
            <div className="mb-4 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <LogIn className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Use the username and password provided by your administrator.</p>
          </div>

          <label className="grid gap-2 text-sm font-medium">
            Username
            <Input
              value={username}
              onChange={(event) => setUsername(normalizeUsername(event.target.value))}
              placeholder="Username"
              {...loginUsernameInputProps}
              required
              disabled={loading}
            />
          </label>
          <label className="mt-3 grid gap-2 text-sm font-medium">
            Password
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              {...loginPasswordInputProps}
              required
              disabled={loading}
            />
          </label>

          <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 rounded border"
              checked={rememberUsername}
              onChange={(event) => setRememberUsername(event.target.checked)}
              disabled={loading}
            />
            Remember username
          </label>

          {formError ? (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {formError}
              {lockedOut ? ` (${formatLoginRetryCountdown(retryAfterSeconds)} remaining)` : null}
            </p>
          ) : null}

          <Button className="mt-5 w-full" disabled={signInDisabled}>
            {loading
              ? "Please wait..."
              : lockedOut
                ? `Try again in ${formatLoginRetryCountdown(retryAfterSeconds)}`
                : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
}
