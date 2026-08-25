/**
 * Message-pane auto-scroll policy — kept pure so inbox-list reorders cannot
 * accidentally couple to center-pane scroll behavior.
 */
export function shouldAutoScrollMessagePane(input: {
  readonly isForSelectedChat: boolean;
  readonly nearBottom: boolean;
  readonly userSentMessage: boolean;
}): boolean {
  if (!input.isForSelectedChat) return false;
  return input.nearBottom || input.userSentMessage;
}
