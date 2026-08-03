"use client";

import { KeyRound } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmNewPasswordInputProps, newPasswordInputProps } from "@/lib/auth-form-fields";
import { ApiClientError } from "@/lib/api-client-error";
import { coadminChangePassword, staffChangePassword } from "@/lib/api";
import { getPostLoginRoute } from "@/lib/post-login-route";
import {
  clearTenantPasswordChangeChallenge,
  readTenantPasswordChangeChallenge,
  type StoredTenantPasswordChange
} from "@/lib/tenant-password-change-storage";

/**
 * Renders the mandatory first-login password change screen for tenant users.
 */
export function TenantChangePasswordForm({ role }: { readonly role: "coadmin" | "staff" }) {
  const router = useRouter();
  const [stored, setStored] = useState<StoredTenantPasswordChange | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const loginRoute = role === "coadmin" ? "/coadmin/login" : "/staff/login";

  useEffect(() => {
    const challenge = readTenantPasswordChangeChallenge(role);
    if (challenge) {
      setStored(challenge);
      return;
    }
    // Refresh before completion — require temporary password login again.
    clearTenantPasswordChangeChallenge(role);
  }, [role]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!stored) {
      toast.error("Password change session expired. Sign in again.");
      router.push(loginRoute as Route);
      return;
    }
    setLoading(true);
    setFormError(null);
    try {
      const change = role === "coadmin" ? coadminChangePassword : staffChangePassword;
      await change({
        passwordChangeToken: stored.passwordChangeToken,
        newPassword: password,
        confirmPassword
      });
      clearTenantPasswordChangeChallenge(role);
      setPassword("");
      setConfirmPassword("");
      router.replace(getPostLoginRoute(role === "coadmin" ? "COADMIN" : "STAFF") as Route);
    } catch (error) {
      const message =
        error instanceof ApiClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Password change failed.";
      setFormError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(135deg,#f8fbfa,#eef4f2)] px-4 py-10">
      <section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
        <form method="post" onSubmit={submit} className="w-full rounded-lg border bg-white p-6 shadow-sm" autoComplete="on">
          <div className="mb-6">
            <div className="mb-4 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <KeyRound className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-xl font-semibold">Change temporary password</h1>
            <p className="mt-1 text-sm text-muted-foreground">A new password is required before dashboard access.</p>
            {stored ? <p className="mt-3 text-sm font-medium">@{stored.username}</p> : null}
          </div>

          <label className="grid gap-2 text-sm font-medium">
            New password
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="New password"
              {...newPasswordInputProps}
              required
              disabled={loading || !stored}
            />
          </label>
          <label className="mt-3 grid gap-2 text-sm font-medium">
            Confirm new password
            <Input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Confirm new password"
              {...confirmNewPasswordInputProps}
              required
              disabled={loading || !stored}
            />
          </label>

          {formError ? (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {formError}
            </p>
          ) : null}

          <Button className="mt-5 w-full" disabled={loading || !stored}>
            {loading ? "Please wait..." : "Set password and continue"}
          </Button>
          {!stored ? (
            <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => router.push(loginRoute as Route)}>
              Return to login
            </Button>
          ) : null}
        </form>
      </section>
    </main>
  );
}
