"use client";

import { Copy, Forward, MoreHorizontal, Reply, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@atlas/ui";

export interface MessageHoverActionsProps {
  readonly outgoing: boolean;
  readonly canDelete?: boolean;
  readonly onReply: () => void;
  readonly onCopy: () => void;
  readonly onForward: () => void;
  readonly onDelete?: () => void;
}

/**
 * Telegram-style hover toolbar for a message bubble. Hidden until hover/focus.
 */
export function MessageHoverActions({
  outgoing,
  canDelete = false,
  onReply,
  onCopy,
  onForward,
  onDelete
}: MessageHoverActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-black/5 bg-white/95 p-0.5 opacity-0 shadow-md backdrop-blur-sm transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
        outgoing ? "left-0 -translate-x-full pr-1" : "right-0 translate-x-full pl-1"
      )}
    >
      <ActionButton label="Reply" onClick={onReply}>
        <Reply className="size-3.5" />
      </ActionButton>
      <ActionButton label="Copy" onClick={onCopy}>
        <Copy className="size-3.5" />
      </ActionButton>
      <ActionButton label="Forward" onClick={onForward}>
        <Forward className="size-3.5" />
      </ActionButton>
      {canDelete && onDelete ? (
        <ActionButton label="Delete" onClick={onDelete} danger>
          <Trash2 className="size-3.5" />
        </ActionButton>
      ) : null}
      <div className="relative">
        <ActionButton label="More" onClick={() => setMenuOpen((open) => !open)}>
          <MoreHorizontal className="size-3.5" />
        </ActionButton>
        {menuOpen ? (
          <div className="absolute top-full right-0 z-20 mt-1 min-w-[8rem] rounded-md border bg-white py-1 text-xs shadow-lg">
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                setMenuOpen(false);
                onCopy();
              }}
            >
              Copy text
            </button>
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                setMenuOpen(false);
                onReply();
              }}
            >
              Reply
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  children,
  danger = false
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        danger && "hover:bg-red-50 hover:text-red-600"
      )}
    >
      {children}
    </button>
  );
}
