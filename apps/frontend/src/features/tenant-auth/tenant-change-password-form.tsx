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
import { coadminChangePassword, staffChangePassword } from "@/lib/api";
import { getPostLoginRoute } from "@/lib/post-login-route";
import { tenantPasswordChangeStorageKey } from "./tenant-login-form";

type StoredPasswordChange = {
  readonly changeToken: string;
  readonly username: string;
};

/**
 * Renders the mandatory first-login password change screen for tenant users.
 */
export function TenantChangePasswordForm({ role }: { readonly role: "coadmin" | "staff" }) {
  const router = useRouter();
  const [stored, setStored] = useState<StoredPasswordChange | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const loginRoute = role === "coadmin" ? "/coadmin/login" : "/staff/login";

  useEffect(() => {
    const raw = sessionStorage.getItem(tenantPasswordChangeStorageKey(role));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as StoredPasswordChange;
      if (parsed.changeToken && parsed.username) setStored(parsed);
    } catch {
      sessionStorage.removeItem(tenantPasswordChangeStorageKey(role));
    }
  }, [role]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!stored) {
      toast.error("Password change session expired. Sign in again.");
      router.push(loginRoute as Route);
      return;
    }
    setLoading(true);
    try {
      const change = role === "coadmin" ? coadminChangePassword : staffChangePassword;
      await change({ changeToken: stored.changeToken, password, confirmPassword });
      sessionStorage.removeItem(tenantPasswordChangeStorageKey(role));
      setPassword("");
      setConfirmPassword("");
      router.replace(getPostLoginRoute(role === "coadmin" ? "COADMIN" : "STAFF") as Route);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password change failed.");
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
            />
          </label>

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
