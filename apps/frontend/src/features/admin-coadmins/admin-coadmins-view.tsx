"use client";

import type { AdminCoadminListItem } from "@atlas/shared";
import { Eye, MailPlus, Search, UserPlus } from "lucide-react";
import type { FormEvent } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const statuses = ["", "INVITED", "ACTIVE", "SUSPENDED", "ARCHIVED", "DISABLED"] as const;

/**
 * Renders Platform Admin Coadmin list and creation workflow.
 */
export function AdminCoadminsView() {
  const [items, setItems] = useState<AdminCoadminListItem[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    username: "",
    temporaryPassword: "",
    confirmTemporaryPassword: ""
  });
  const [oneTimePassword, setOneTimePassword] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => items, [items]);

  async function load(next = { search, status }): Promise<void> {
    setLoading(true);
    try {
      const params: { search?: string; status?: string } = {};
      if (next.search) params.search = next.search;
      if (next.status) params.status = next.status;
      setItems(await api.adminCoadmins(params));
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCreating(true);
    try {
      const created = await api.createAdminCoadmin(form) as AdminCoadminListItem & { temporaryPassword?: string };
      setOneTimePassword(created.temporaryPassword ?? null);
      toast.success("Coadmin created. Copy the temporary password now.");
      setForm({ username: "", temporaryPassword: "", confirmTemporaryPassword: "" });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create Coadmin.");
      await load();
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Coadmins</h2>
            <p className="text-sm text-muted-foreground">Create and manage workspace owners.</p>
          </div>
          <Button form="create-coadmin-form" disabled={creating}>
            <UserPlus className="size-4" aria-hidden="true" />
            Create Coadmin
          </Button>
        </div>
        <form className="mt-5 grid gap-3 md:grid-cols-[1fr_12rem_auto]" onSubmit={(event) => { event.preventDefault(); void load(); }}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input className="pl-9" placeholder="Search name, email, workspace, status" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <select className="h-10 rounded-md border bg-white px-3 text-sm" value={status} onChange={(event) => setStatus(event.target.value)}>
            {statuses.map((item) => (
              <option key={item || "all"} value={item}>
                {item || "All statuses"}
              </option>
            ))}
          </select>
          <Button variant="secondary">Apply</Button>
        </form>
      </section>

      <section className="rounded-lg border bg-white p-5">
        <h3 className="font-semibold">Create Coadmin</h3>
        <form id="create-coadmin-form" className="mt-4 grid gap-4 md:grid-cols-3" onSubmit={submit}>
          <Input placeholder="Username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} required />
          <Input placeholder="Temporary password" type="password" value={form.temporaryPassword} onChange={(event) => setForm({ ...form, temporaryPassword: event.target.value })} required />
          <Input placeholder="Confirm temporary password" type="password" value={form.confirmTemporaryPassword} onChange={(event) => setForm({ ...form, confirmTemporaryPassword: event.target.value })} required />
        </form>
        {oneTimePassword ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium">Temporary password visible once</p>
            <p className="mt-2 font-mono text-sm">{oneTimePassword}</p>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border bg-white">
        {loading ? (
          <p className="p-5 text-sm text-muted-foreground">Loading coadmins...</p>
        ) : filtered.length === 0 ? (
          <div className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
            <MailPlus className="size-5" aria-hidden="true" />
            No coadmins have been created yet.
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((coadmin) => (
              <div key={coadmin.id} className="grid gap-3 p-5 lg:grid-cols-[1fr_auto]">
                <div>
                  <p className="font-medium">{coadmin.name}</p>
                  <p className="text-sm text-muted-foreground">@{coadmin.username}</p>
                  <p className="text-sm text-muted-foreground">{coadmin.contactEmail ?? "No contact email"}</p>
                  <p className="text-sm text-muted-foreground">
                    {coadmin.workspaceName} / {coadmin.workspaceSlug}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-muted px-2 py-1 text-xs">{coadmin.status}</span>
                  {coadmin.mustChangePassword ? <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">Password change required</span> : null}
                  <Link href={`/admin/coadmins/${coadmin.id}` as Route}>
                    <Button variant="secondary">
                      <Eye className="size-4" aria-hidden="true" />
                      View
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
