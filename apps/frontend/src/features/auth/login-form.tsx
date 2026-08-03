"use client";

import { KeyRound, LogIn, UserRound } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTenantLoginSessionGate } from "@/features/auth/use-tenant-login-session-gate";
import { tenantPasswordChangeStorageKey } from "@/features/tenant-auth/tenant-login-form";
import { loginPasswordInputProps, loginUsernameInputProps } from "@/lib/auth-form-fields";
import { tenantLogin } from "@/lib/api";
import { getPostLoginRoute } from "@/lib/post-login-route";
import { isPasswordChangeRequired } from "@/lib/tenant-login-response";
import {
  applyRememberUsernamePreference,
  getRememberedUsername,
  normalizeUsername
} from "@/lib/remembered-username";

/**
 * Renders the default workspace-user login form for Coadmins and Staff.
 */
export function LoginForm() {
  const router = useRouter();
  const sessionGate = useTenantLoginSessionGate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberUsername, setRememberUsername] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const remembered = getRememberedUsername();
    if (!remembered) return;
    setUsername(remembered);
    setRememberUsername(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    try {
      const normalized = normalizeUsername(username);
      const result = await tenantLogin({ username: normalized, password });
      applyRememberUsernamePreference(normalized, rememberUsername);
      setPassword("");
      const changeRoute = result.role === "coadmin" ? "/coadmin/change-password" : "/staff/change-password";
      if (isPasswordChangeRequired(result.response)) {
        sessionStorage.setItem(
          tenantPasswordChangeStorageKey(result.role),
          JSON.stringify({ changeToken: result.response.changeToken, username: normalized })
        );
        router.replace(changeRoute as Route);
        return;
      }
      const role = result.response.user.role;
      router.replace(getPostLoginRoute(role) as Route);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid username or password.");
    } finally {
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

  return (
    <main className="min-h-screen bg-[linear-gradient(135deg,#f8fbfa,#eef4f2)] px-4 py-10">
      <section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
        <form method="post" onSubmit={submit} className="w-full rounded-lg border bg-white p-6 shadow-sm" autoComplete="on">
          <div className="mb-6">
            <div className="mb-4 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <LogIn className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-xl font-semibold">Sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">Workspace access</p>
          </div>

          <label className="grid gap-2 text-sm font-medium">
            Username
            <div className="relative">
              <UserRound className="pointer-events-none absolute left-3 top-2.5 size-5 text-muted-foreground" aria-hidden="true" />
              <Input
                className="pl-10"
                value={username}
                onChange={(event) => setUsername(normalizeUsername(event.target.value))}
                {...loginUsernameInputProps}
                required
              />
            </div>
          </label>

          <label className="mt-4 grid gap-2 text-sm font-medium">
            Password
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-2.5 size-5 text-muted-foreground" aria-hidden="true" />
              <Input
                className="pl-10"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                {...loginPasswordInputProps}
                required
              />
            </div>
          </label>

          <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 rounded border"
              checked={rememberUsername}
              onChange={(event) => setRememberUsername(event.target.checked)}
            />
            Remember username
          </label>

          <Button className="mt-6 w-full" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </Button>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            Platform Administrator?{" "}
            <Link className="font-medium text-primary hover:underline" href="/admin/login">
              Go to Admin Login
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}
