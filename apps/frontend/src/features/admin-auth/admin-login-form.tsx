"use client";

import { Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminLogin } from "@/lib/api";
import { getPostLoginRoute } from "@/lib/post-login-route";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Renders the Platform Admin email/password login step.
 */
export function AdminLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const token = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    if (token && user?.role === "PLATFORM_ADMIN") {
      router.replace(getPostLoginRoute("PLATFORM_ADMIN") as Route);
      return;
    }
    if (!token && sessionStorage.getItem("atlas-admin-challenge")) {
      router.replace("/admin/verify-device" as Route);
    }
  }, [router, token, user?.role]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await adminLogin({ email, password });
      if ("requiresVerification" in response) {
        sessionStorage.setItem("atlas-admin-challenge", JSON.stringify(response));
        router.replace("/admin/verify-device" as Route);
        return;
      }
      router.replace(getPostLoginRoute(response.user.role) as Route);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid email or password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#dff4ef,transparent_32%),linear-gradient(135deg,#f8fbfa,#eef4f2)] px-4 py-10">
      <section className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-5xl items-center gap-8 lg:grid-cols-[1fr_26rem]">
        <div className="max-w-xl">
          <div className="mb-6 flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-4xl font-semibold tracking-normal text-foreground">Platform Admin</h1>
          <p className="mt-4 text-lg leading-8 text-muted-foreground">Platform administration only</p>
        </div>

        <form onSubmit={submit} className="rounded-lg border bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold">Platform Admin</h2>
            <p className="mt-1 text-sm text-muted-foreground">Platform administration only</p>
          </div>
          <label className="grid gap-2 text-sm font-medium">
            Email
            <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
          </label>
          <label className="mt-4 grid gap-2 text-sm font-medium">
            Password
            <div className="relative">
              <Input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                className="pr-11"
                required
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            </div>
          </label>
          <Button className="mt-6 w-full" disabled={loading}>
            <LockKeyhole className="size-4" aria-hidden="true" />
            {loading ? "Signing in..." : "Sign in"}
          </Button>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Workspace User?{" "}
            <Link className="font-medium text-primary hover:underline" href="/login">
              Go to Workspace Login
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}
