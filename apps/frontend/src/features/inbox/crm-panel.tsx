"use client";

import type {
  CrmActivityDto,
  CrmAssigneeDto,
  CrmConversationPanelDto,
  CrmConversationStatus,
  CrmTagDto
} from "@atlas/shared";
import { PanelRightClose } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CrmGiveawaySection } from "@/features/leaderboard/crm-giveaway-section";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import type { ContactIdentity } from "./contact-identity";
import { getCachedCrmAssignees, getCachedCrmTags } from "./crm-catalog-cache";
import { avatarInitials, crmStatusLabels, crmStatusStyles } from "./inbox-utils";

export interface CrmConversationState {
  readonly panel: CrmConversationPanelDto | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly tagCatalog: readonly CrmTagDto[];
  readonly assignees: readonly CrmAssigneeDto[];
  readonly refresh: () => Promise<void>;
  readonly claim: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly assign: (assigneeUserId: string | null) => Promise<void>;
  readonly setStatus: (status: CrmConversationStatus) => Promise<void>;
  readonly addTag: (tagId: string) => Promise<void>;
  readonly removeTag: (tagId: string) => Promise<void>;
  readonly createNote: (body: string) => Promise<void>;
  readonly updateNote: (noteId: string, body: string) => Promise<void>;
}

/**
 * Loads and mutates the CRM panel for a conversation. Shared by `CrmConversationControls`
 * and `CrmPanel` so both read/write from a single fetch source of truth.
 */
export function useCrmConversationPanel(chatId: string): CrmConversationState {
  const [panel, setPanel] = useState<CrmConversationPanelDto | null>(null);
  const [tagCatalog, setTagCatalog] = useState<readonly CrmTagDto[]>([]);
  const [assignees, setAssignees] = useState<readonly CrmAssigneeDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextPanel, tags, people] = await Promise.all([
        api.crmPanel(chatId),
        getCachedCrmTags(),
        getCachedCrmAssignees()
      ]);
      setPanel(nextPanel);
      setTagCatalog(tags);
      setAssignees(people);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to load CRM data.");
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    setLoading(true);
    setPanel(null);
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(async (action: () => Promise<CrmConversationPanelDto>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setPanel(next);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const runNoteMutation = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await action();
        // Notes only need the panel refresh — reuse cached tags/assignees.
        const nextPanel = await api.crmPanel(chatId);
        setPanel(nextPanel);
      } catch (noteError) {
        setError(noteError instanceof Error ? noteError.message : "Note action failed.");
      } finally {
        setBusy(false);
      }
    },
    [chatId]
  );

  return {
    panel,
    loading,
    error,
    busy,
    tagCatalog,
    assignees,
    refresh,
    claim: () => runMutation(() => api.crmClaim(chatId)),
    release: () => runMutation(() => api.crmRelease(chatId)),
    assign: (assigneeUserId) => runMutation(() => api.crmAssign(chatId, assigneeUserId)),
    setStatus: (status) => runMutation(() => api.crmSetStatus(chatId, status)),
    addTag: (tagId) => runMutation(() => api.crmAddChatTag(chatId, tagId)),
    removeTag: (tagId) => runMutation(() => api.crmRemoveChatTag(chatId, tagId)),
    createNote: (body) => runNoteMutation(() => api.crmCreateNote(chatId, body)),
    updateNote: (noteId, body) => runNoteMutation(() => api.crmUpdateNote(chatId, noteId, body))
  };
}

interface CrmPanelProps {
  readonly state: CrmConversationState;
  readonly identity: ContactIdentity;
  readonly avatarColor: string;
  readonly onClose: () => void;
  /** When true, render without the fixed desktop aside chrome (mobile sheet). */
  readonly embedded?: boolean;
}

/**
 * Collapsible right-hand CRM panel: leaderboard ops (top), contact, assignee,
 * status, tags, internal notes, and activity history.
 * Payment / AppBeg / Vendor link status cards live inside the leaderboard section.
 */
export function CrmPanel({ state, identity, avatarColor, onClose, embedded = false }: CrmPanelProps) {
  const { panel, loading, error, busy, createNote } = state;
  const [noteBody, setNoteBody] = useState("");
  const user = useAuthStore((auth) => auth.user);

  async function submitNote(): Promise<void> {
    const body = noteBody.trim();
    if (!body) return;
    setNoteBody("");
    await createNote(body);
  }

  const timeline = useMemo(() => buildCrmTimeline(panel), [panel]);

  return (
    <aside
      className={
        embedded
          ? "flex w-full flex-col overflow-hidden bg-white"
          : "flex h-full w-[300px] shrink-0 grow-0 flex-col overflow-hidden border-l bg-white"
      }
    >      <header className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className="flex size-14 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white shadow-sm"
            style={{ backgroundColor: avatarColor }}
            aria-hidden="true"
          >
            {avatarInitials(identity.displayName)}
          </span>
          <div className="min-w-0 pt-0.5">
            <h3 className="truncate text-[15px] font-semibold leading-tight text-foreground">{identity.displayName}</h3>
            {identity.username ? (
              <p className="truncate text-xs text-[#229ED9]">@{identity.username}</p>
            ) : identity.phone ? (
              <p className="truncate text-xs text-muted-foreground">{identity.phone}</p>
            ) : identity.privacyNotice ? (
              <p className="truncate text-xs text-muted-foreground">{identity.privacyNotice}</p>
            ) : null}
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {identity.presenceLabel ?? (identity.privacyNotice ? "Customer" : "Customer")}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          className={`size-11 shrink-0 px-0 ${embedded ? "hidden" : ""}`}
          onClick={onClose}
          aria-label="Close CRM panel"
        >
          <PanelRightClose className="size-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3">
        {error ? <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p> : null}

        {loading && !panel ? (
          <p className="text-sm text-muted-foreground">Loading CRM data…</p>
        ) : !panel ? (
          <p className="text-sm text-muted-foreground">No CRM data available.</p>
        ) : (
          <div className="space-y-4">
            <CrmGiveawaySection
              chatId={panel.chatId}
              crmContactId={panel.contact?.id ?? null}
              role={user?.role}
            />

            <Section title="Contact details">
              <div className="space-y-1 text-sm">
                {identity.firstName || identity.lastName ? (
                  <p className="text-muted-foreground">
                    {[identity.firstName, identity.lastName].filter(Boolean).join(" ")}
                  </p>
                ) : null}
                {panel.contact ? (
                  <p className="text-xs text-muted-foreground">
                    First seen {formatDate(panel.contact.firstSeenAt)} · {panel.contact.conversationCount} conversation
                    {panel.contact.conversationCount === 1 ? "" : "s"}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">CRM contact will link on next inbound sync.</p>
                )}
              </div>
            </Section>

            <Section title="Status">
              <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${crmStatusStyles[panel.crmStatus as CrmConversationStatus]}`}>
                {crmStatusLabels[panel.crmStatus as CrmConversationStatus]}
              </span>
            </Section>

            <Section title="Assignee">
              {panel.assignee ? (
                <p className="text-sm">
                  {panel.assignee.name} <span className="text-xs text-muted-foreground">({panel.assignee.role})</span>
                </p>
              ) : (
                <p className="text-sm text-orange-600">Unassigned</p>
              )}
            </Section>

            <Section title="Tags">
              {panel.tags.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tags</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {panel.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
                      style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
                    >
                      <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                      {tag.name}
                      <button
                        type="button"
                        className="ml-0.5 text-current/70 hover:text-current"
                        disabled={busy}
                        onClick={() => void state.removeTag(tag.id)}
                        aria-label={`Remove tag ${tag.name}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Internal notes" hint="Not visible to the contact">
              <div className="space-y-2">
                <textarea
                  value={noteBody}
                  onChange={(event) => setNoteBody(event.target.value)}
                  placeholder="Add an internal note…"
                  rows={2}
                  className="w-full resize-none rounded-md border bg-muted/30 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    disabled={busy || noteBody.trim().length === 0}
                    onClick={() => void submitNote()}
                  >
                    Add note
                  </Button>
                </div>

                {panel.notes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No internal notes yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {panel.notes.map((note) => (
                      <li key={note.id} className="rounded-md border border-amber-200 bg-amber-50 p-2">
                        <p className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                          Internal note
                        </p>
                        <p className="whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {note.authorName} · {formatDateTime(note.createdAt)}
                          {note.editedAt ? " · edited" : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Section>

            <Section title="Activity">
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ul className="space-y-2 border-l border-border/70 pl-3">
                  {timeline.map((item) => (
                    <li key={item.id} className="relative text-xs">
                      <span className="absolute -left-[0.97rem] top-1.5 size-1.5 rounded-full bg-primary/70" aria-hidden="true" />
                      <p className="font-medium text-foreground">{item.label}</p>
                      <p className="text-muted-foreground">
                        {item.actor}
                        {item.detail ? ` · ${item.detail}` : ""} · {item.when}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </div>
    </aside>
  );
}

interface TimelineItem {
  readonly id: string;
  readonly label: string;
  readonly actor: string;
  readonly detail: string | null;
  readonly when: string;
}

function buildCrmTimeline(panel: CrmConversationPanelDto | null): TimelineItem[] {
  if (!panel) return [];
  const items: Array<TimelineItem & { readonly sortAt: number }> = panel.activities.map((activity) => ({
    id: activity.id,
    label: describeActivity(activity),
    actor: activity.actorName ?? "System",
    detail: activityDetail(activity),
    when: formatDateTime(activity.createdAt),
    sortAt: Date.parse(activity.createdAt) || 0
  }));

  const createdAt = panel.firstSeenAt ?? panel.contact?.firstSeenAt ?? null;
  if (createdAt) {
    items.push({
      id: `created-${panel.chatId}`,
      label: "Conversation created",
      actor: "System",
      detail: null,
      when: formatDateTime(createdAt),
      sortAt: Date.parse(createdAt) || 0
    });
  }

  return items
    .sort((a, b) => b.sortAt - a.sortAt)
    .map(({ id, label, actor, detail, when }) => ({ id, label, actor, detail, when }));
}

function Section({ title, hint, children }: { readonly title: string; readonly hint?: string; readonly children: ReactNode }) {
  return (
    <section>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {hint ? <span className="font-normal normal-case text-muted-foreground/70">— {hint}</span> : null}
      </p>
      {children}
    </section>
  );
}

function describeActivity(activity: CrmActivityDto): string {
  switch (activity.type) {
    case "CLAIMED":
      return "Assigned";
    case "ASSIGNED":
      return "Assigned";
    case "REASSIGNED":
      return "Assigned";
    case "RELEASED":
      return "Released";
    case "STATUS_CHANGED":
      return "Status changed";
    case "TAG_ADDED":
      return "Tag added";
    case "TAG_REMOVED":
      return "Tag removed";
    case "NOTE_CREATED":
      return "Internal note";
    case "NOTE_EDITED":
      return "Internal note edited";
    case "REOPENED":
      return "Reopened";
    case "PAYMENT_LINKED":
      return "Payment linked";
    case "VENDOR_LINKED":
      return "Vendor linked";
    case "APPBEG_LINKED":
      return "AppBeg linked";
    case "CONVERSATION_CREATED":
      return "Conversation created";
    default:
      return activity.type
        .toLowerCase()
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function activityDetail(activity: CrmActivityDto): string | null {
  const payload = activity.payload ?? {};
  if (typeof payload.status === "string") return String(payload.status);
  if (typeof payload.toStatus === "string") return String(payload.toStatus);
  if (typeof payload.tagName === "string") return String(payload.tagName);
  if (typeof payload.assigneeName === "string") return String(payload.assigneeName);
  return null;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
