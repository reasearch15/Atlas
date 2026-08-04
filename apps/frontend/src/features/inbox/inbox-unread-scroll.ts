/**
 * Decides whether the inbox list may auto-scroll to a newly arrived unread row.
 * Never interrupt when the staff member is reading a different chat.
 */
export function shouldAutoScrollToUnreadArrival(params: {
  readonly listVisible: boolean;
  readonly selectedChatId: string | null;
  readonly arrivedChatId: string;
  readonly scrollTop: number;
  readonly nearTopThresholdPx?: number;
  readonly rowFullyOrPartiallyVisible: boolean;
}): boolean {
  if (!params.listVisible) return false;
  if (params.selectedChatId && params.selectedChatId !== params.arrivedChatId) return false;
  const nearTop = params.scrollTop <= (params.nearTopThresholdPx ?? 80);
  return nearTop || params.rowFullyOrPartiallyVisible;
}

/**
 * Returns whether a row intersects the scroll container viewport.
 */
export function isRowIntersectingContainer(params: {
  readonly containerTop: number;
  readonly containerBottom: number;
  readonly rowTop: number;
  readonly rowBottom: number;
}): boolean {
  return params.rowBottom > params.containerTop && params.rowTop < params.containerBottom;
}
