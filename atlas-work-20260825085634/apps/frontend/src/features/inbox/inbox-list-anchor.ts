/**
 * Pure helpers for anchoring the selected conversation row when the inbox
 * list reorders on realtime activity (keeps scrollTop visually stable).
 */

/** Snapshot of the selected row’s position inside the list scroll container. */
export interface SelectedRowAnchor {
  readonly chatId: string;
  /** Distance from the container’s visible top edge to the row’s top edge. */
  readonly offsetFromContainerTop: number;
}

/**
 * Reads the selected row’s visual offset relative to the list container.
 * Returns null when the row or container is missing.
 */
export function captureSelectedRowAnchor(
  container: HTMLElement | null,
  chatId: string | null
): SelectedRowAnchor | null {
  if (!container || !chatId) return null;
  const row = findConversationRow(container, chatId);
  if (!row) return null;
  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return {
    chatId,
    offsetFromContainerTop: rowRect.top - containerRect.top
  };
}

/**
 * After a DOM reorder, adjusts scrollTop so the selected row stays at the
 * previously captured visual offset. Returns the applied delta (0 if none).
 */
export function restoreSelectedRowAnchor(
  container: HTMLElement | null,
  anchor: SelectedRowAnchor | null
): number {
  if (!container || !anchor) return 0;
  const row = findConversationRow(container, anchor.chatId);
  if (!row) return 0;
  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const newOffset = rowRect.top - containerRect.top;
  const delta = newOffset - anchor.offsetFromContainerTop;
  if (Math.abs(delta) < 0.5) return 0;
  container.scrollTop += delta;
  return delta;
}

/**
 * Ensures the selected row is inside the container’s visible area without
 * forcing it to the top or center (`block: "nearest"`).
 */
export function ensureSelectedRowNearestVisible(
  container: HTMLElement | null,
  chatId: string | null
): void {
  if (!container || !chatId) return;
  const row = findConversationRow(container, chatId);
  if (!row) return;
  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const above = rowRect.top < containerRect.top;
  const below = rowRect.bottom > containerRect.bottom;
  if (above || below) {
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

/**
 * Computes the scrollTop delta needed to keep a row at a fixed viewport
 * offset after its document offset changes (unit-testable pure math).
 */
export function scrollDeltaForAnchor(params: {
  readonly previousOffsetFromContainerTop: number;
  readonly newOffsetFromContainerTop: number;
}): number {
  return params.newOffsetFromContainerTop - params.previousOffsetFromContainerTop;
}

/**
 * Simulates cumulative anchor compensation across rapid reorders to assert
 * no scroll drift when each step restores the same visual offset.
 */
export function applySequentialScrollDeltas(
  initialScrollTop: number,
  deltas: readonly number[]
): number {
  return deltas.reduce((scrollTop, delta) => scrollTop + delta, initialScrollTop);
}

function findConversationRow(container: HTMLElement, chatId: string): HTMLElement | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(chatId) : chatId.replace(/"/g, '\\"');
  return container.querySelector(`[data-chat-id="${escaped}"]`);
}
