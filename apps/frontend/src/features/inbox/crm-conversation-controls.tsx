"use client";

import type { CrmAssigneeDto, CrmConversationPanelDto, CrmConversationStatus, CrmTagDto, Role } from "@atlas/shared";
import { crmConversationStatuses } from "@atlas/shared";
import { PanelRight, Tag as TagIcon, UserCheck, UserMinus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { crmStatusLabels } from "./inbox-utils";

interface CrmConversationControlsProps {
  readonly panel: CrmConversationPanelDto | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly tagCatalog: readonly CrmTagDto[];
  readonly assignees: readonly CrmAssigneeDto[];
  readonly currentUserId: string | null;
  readonly role: Role | undefined;
  readonly panelOpen: boolean;
  readonly onTogglePanel: () => void;
  readonly onClaim: () => void;
  readonly onRelease: () => void;
  readonly onAssign: (userId: string | null) => void;
  readonly onSetStatus: (status: CrmConversationStatus) => void;
  readonly onAddTag: (tagId: string) => void;
  readonly onRemoveTag: (tagId: string) => void;
}

/**
 * Compact header controls for the active conversation: status, claim/release/assign,
 * a tag picker, and the CRM panel toggle. Assignment reassignment is Coadmin-only,
 * matching the backend `crmAssignGuard`.
 */
export function CrmConversationControls({
  panel,
  loading,
  busy,
  tagCatalog,
  assignees,
  currentUserId,
  role,
  panelOpen,
  onTogglePanel,
  onClaim,
  onRelease,
  onAssign,
  onSetStatus,
  onAddTag,
  onRemoveTag
}: CrmConversationControlsProps) {
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!tagPickerOpen) return;
    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setTagPickerOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setTagPickerOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [tagPickerOpen]);

  if (loading && !panel) {
    return <div className="h-8 w-40 shrink-0 animate-pulse rounded-md bg-muted" aria-hidden="true" />;
  }
  if (!panel) return null;

  const isCoadmin = role === "COADMIN";
  const assignedToMe = panel.assignee !== null && panel.assignee.id === currentUserId;
  const activeTagIds = new Set(panel.tags.map((tag) => tag.id));
  const activeTags = tagCatalog.filter((tag) => !tag.archivedAt);

  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5">
      <select
        value={panel.crmStatus}
        disabled={busy}
        onChange={(event) => onSetStatus(event.target.value as CrmConversationStatus)}
        className="h-8 rounded-md border bg-white px-2 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
        aria-label="Conversation status"
      >
        {crmConversationStatuses.map((status) => (
          <option key={status} value={status}>
            {crmStatusLabels[status]}
          </option>
        ))}
      </select>

      {panel.assignee === null ? (
        <Button variant="secondary" className="h-8 px-2.5 text-xs" disabled={busy} onClick={onClaim}>
          <UserCheck className="size-3.5" aria-hidden="true" />
          Claim
        </Button>
      ) : assignedToMe ? (
        <Button variant="secondary" className="h-8 px-2.5 text-xs" disabled={busy} onClick={onRelease}>
          <UserMinus className="size-3.5" aria-hidden="true" />
          Release
        </Button>
      ) : !isCoadmin ? (
        <span className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground" title={`Assigned to ${panel.assignee.name}`}>
          Assigned to {panel.assignee.name}
        </span>
      ) : null}

      {isCoadmin ? (
        <select
          value={panel.assignee?.id ?? ""}
          disabled={busy}
          onChange={(event) => onAssign(event.target.value.length > 0 ? event.target.value : null)}
          className="h-8 max-w-32 rounded-md border bg-white px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          aria-label="Assign conversation"
        >
          <option value="">Unassigned</option>
          {assignees.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      ) : null}

      <div className="relative">
        <button
          ref={anchorRef}
          type="button"
          onClick={() => setTagPickerOpen((open) => !open)}
          className="flex h-8 items-center gap-1 rounded-md border bg-white px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-haspopup="true"
          aria-expanded={tagPickerOpen}
        >
          <TagIcon className="size-3.5" aria-hidden="true" />
          Tags
          {panel.tags.length > 0 ? <span className="text-muted-foreground/70">({panel.tags.length})</span> : null}
        </button>
        {tagPickerOpen ? (
          <div
            ref={pickerRef}
            role="menu"
            aria-label="Conversation tags"
            className="absolute right-0 top-[calc(100%+0.25rem)] z-30 w-56 rounded-md border bg-white p-1.5 shadow-lg"
          >
            {activeTags.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No workspace tags yet.</p>
            ) : (
              activeTags.map((tag) => {
                const active = activeTagIds.has(tag.id);
                return (
                  <label key={tag.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={active}
                      disabled={busy}
                      onChange={() => (active ? onRemoveTag(tag.id) : onAddTag(tag.id))}
                    />
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                    <span className="truncate">{tag.name}</span>
                  </label>
                );
              })
            )}
          </div>
        ) : null}
      </div>

      <Button
        variant={panelOpen ? "secondary" : "ghost"}
        className="h-8 w-8 px-0"
        onClick={onTogglePanel}
        aria-pressed={panelOpen}
        aria-label={panelOpen ? "Hide CRM panel" : "Show CRM panel"}
      >
        <PanelRight className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
