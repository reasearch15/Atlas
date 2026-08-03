"use client";

import { LogIn } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTenantLoginSessionGate } from "@/features/auth/use-tenant-login-session-gate";
import { loginPasswordInputProps, loginUsernameInputProps } from "@/lib/auth-form-fields";
import { coadminLogin, staffLogin } from "@/lib/api";
import { getPostLoginRoute } from "@/lib/post-login-route";
import {
  applyRememberUsernamePreference,
  getRememberedUsername,
  normalizeUsername
} from "@/lib/remembered-username";

export const tenantPasswordChangeStorageKey = (role: "coadmin" | "staff") => `atlas:${role}:password-change`;

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
  const title = role === "coadmin" ? "Coadmin Login" : "Staff Login";
  const changeRoute = role === "coadmin" ? "/coadmin/change-password" : "/staff/change-password";

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
      const login = role === "coadmin" ? coadminLogin : staffLogin;
      const response = await login({ username: normalized, password });
      applyRememberUsernamePreference(normalized, rememberUsername);
      setPassword("");
      if ("requiresPasswordChange" in response) {
        sessionStorage.setItem(tenantPasswordChangeStorageKey(role), JSON.stringify({ changeToken: response.changeToken, username: normalized }));
        router.replace(changeRoute as Route);
        return;
      }
      router.replace(getPostLoginRoute(response.user.role) as Route);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign in failed.");
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
            />
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

          <Button className="mt-5 w-full" disabled={loading}>
            {loading ? "Please wait..." : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
}
