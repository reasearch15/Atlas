"use client";

import type { CrmTagDto } from "@atlas/shared";
import { Archive, Plus, RotateCcw, Tag as TagIcon } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { getCachedCrmTags, invalidateCrmTagsCache } from "@/features/inbox/crm-catalog-cache";

const DEFAULT_COLOR = "#0369a1";

/**
 * Renders Coadmin-owned CRM tag catalog management: create, recolor/rename, and archive.
 * Archiving does not detach the tag from conversations that already carry it.
 */
export function TagsManagementView() {
  const [tags, setTags] = useState<CrmTagDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Record<string, { name: string; color: string }>>({});

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const rows = await getCachedCrmTags(true);
      setTags([...rows]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load tags.");
    } finally {
      setLoading(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api.crmCreateTag({ name: name.trim(), color });
      invalidateCrmTagsCache();
      setName("");
      setColor(DEFAULT_COLOR);
      toast.success("Tag created.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create tag.");
    } finally {
      setCreating(false);
    }
  }

  function draftFor(tag: CrmTagDto): { name: string; color: string } {
    return editing[tag.id] ?? { name: tag.name, color: tag.color };
  }

  function updateDraft(tag: CrmTagDto, patch: Partial<{ name: string; color: string }>): void {
    setEditing((current) => ({ ...current, [tag.id]: { ...draftFor(tag), ...patch } }));
  }

  async function saveTag(tag: CrmTagDto): Promise<void> {
    const draft = draftFor(tag);
    if (draft.name === tag.name && draft.color === tag.color) return;
    try {
      await api.crmUpdateTag(tag.id, { name: draft.name.trim(), color: draft.color });
      invalidateCrmTagsCache();
      toast.success("Tag updated.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update tag.");
    }
  }

  async function toggleArchived(tag: CrmTagDto): Promise<void> {
    try {
      await api.crmUpdateTag(tag.id, { archived: !tag.archivedAt });
      invalidateCrmTagsCache();
      toast.success(tag.archivedAt ? "Tag restored." : "Tag archived.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update tag.");
    }
  }

  const active = tags.filter((tag) => !tag.archivedAt);
  const archived = tags.filter((tag) => tag.archivedAt);

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-5">
        <div>
          <h1 className="text-xl font-semibold">Tags</h1>
          <p className="text-sm text-muted-foreground">Manage the workspace CRM tag catalog used to label conversations.</p>
        </div>
        <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={create}>
          <div className="min-w-[14rem] flex-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="tag-name">
              Tag name
            </label>
            <Input id="tag-name" placeholder="e.g. VIP" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="tag-color">
              Color
            </label>
            <input
              id="tag-color"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="h-10 w-14 rounded-md border bg-white p-1"
            />
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            <Plus className="size-4" aria-hidden="true" />
            Create tag
          </Button>
        </form>
      </section>

      <section className="rounded-lg border bg-white">
        <div className="border-b p-5">
          <h2 className="font-semibold">Active tags</h2>
        </div>
        {loading ? (
          <p className="p-5 text-sm text-muted-foreground">Loading tags…</p>
        ) : active.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No active tags yet. Create one above.</p>
        ) : (
          <div className="divide-y">
            {active.map((tag) => {
              const draft = draftFor(tag);
              return (
                <div key={tag.id} className="flex flex-wrap items-center gap-3 p-4">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: `${draft.color}1a`, color: draft.color }}>
                    <TagIcon className="size-4" aria-hidden="true" />
                  </span>
                  <Input
                    className="h-9 max-w-48"
                    value={draft.name}
                    onChange={(event) => updateDraft(tag, { name: event.target.value })}
                    onBlur={() => void saveTag(tag)}
                  />
                  <input
                    type="color"
                    value={draft.color}
                    onChange={(event) => updateDraft(tag, { color: event.target.value })}
                    onBlur={() => void saveTag(tag)}
                    className="h-9 w-12 rounded-md border bg-white p-1"
                    aria-label={`Color for ${tag.name}`}
                  />
                  <div className="ml-auto">
                    <Button variant="secondary" onClick={() => void toggleArchived(tag)}>
                      <Archive className="size-4" aria-hidden="true" />
                      Archive
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {archived.length > 0 ? (
        <section className="rounded-lg border bg-white">
          <div className="border-b p-5">
            <h2 className="font-semibold">Archived tags</h2>
            <p className="text-sm text-muted-foreground">Archived tags stay on conversations that already carry them but cannot be newly applied.</p>
          </div>
          <div className="divide-y">
            {archived.map((tag) => (
              <div key={tag.id} className="flex items-center gap-3 p-4">
                <span
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
                  style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
                >
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                  {tag.name}
                </span>
                <div className="ml-auto">
                  <Button variant="ghost" onClick={() => void toggleArchived(tag)}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Restore
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
