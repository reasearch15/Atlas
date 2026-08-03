"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export type DeleteMessageScope = "EVERYONE" | "ATLAS_ONLY";

export interface DeleteMessageDialogProps {
  readonly open: boolean;
  readonly loading?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (scope: DeleteMessageScope) => void;
}

/**
 * Confirmation dialog for Coadmin / Platform Admin message deletion.
 */
export function DeleteMessageDialog({ open, loading = false, onCancel, onConfirm }: DeleteMessageDialogProps) {
  const [scope, setScope] = useState<DeleteMessageScope>("EVERYONE");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-message-title">
      <div className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl">
        <h2 id="delete-message-title" className="text-base font-semibold text-foreground">
          Delete message?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how this message should be removed. Telegram deletion only works when Telegram permits it.
        </p>

        <div className="mt-4 space-y-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/40">
            <input
              type="radio"
              name="delete-scope"
              className="mt-1"
              checked={scope === "EVERYONE"}
              disabled={loading}
              onChange={() => setScope("EVERYONE")}
            />
            <span>
              <span className="font-medium text-foreground">Delete for everyone</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Remove from Telegram for all participants where allowed.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm hover:bg-amber-50">
            <input
              type="radio"
              name="delete-scope"
              className="mt-1"
              checked={scope === "ATLAS_ONLY"}
              disabled={loading}
              onChange={() => setScope("ATLAS_ONLY")}
            />
            <span>
              <span className="font-medium text-foreground">Remove from Atlas only</span>
              <span className="mt-0.5 block text-xs text-amber-800/80">
                Hides the message in Atlas. It remains visible in the native Telegram app.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={loading} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={loading}
            onClick={() => onConfirm(scope)}
          >
            {loading ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}
