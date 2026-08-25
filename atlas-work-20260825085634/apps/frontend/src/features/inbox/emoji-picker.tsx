"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EMOJI_CATEGORIES, searchEmojis, type EmojiEntry } from "./emoji-catalog";
import { loadRecentEmojis, rememberRecentEmoji } from "./recent-emojis";

interface EmojiPickerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (emoji: string) => void;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
}

/**
 * Compact popover emoji picker with search, recent, and keyboard navigation.
 */
export function EmojiPicker({ open, onClose, onSelect, anchorRef }: EmojiPickerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadRecentEmojis());
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => searchEmojis(query), [query]);
  const flat: EmojiEntry[] = useMemo(() => {
    if (query.trim()) return filtered;
    const recentEntries = recent
      .map((emoji) => filtered.find((entry) => entry.emoji === emoji) ?? { emoji, name: emoji, keywords: [] as string[] })
      .filter((entry, index, arr) => arr.findIndex((row) => row.emoji === entry.emoji) === index);
    return [...recentEntries, ...EMOJI_CATEGORIES.flatMap((category) => category.emojis)];
  }, [filtered, query, recent]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setRecent(loadRecentEmojis());
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose, open]);

  if (!open) return null;

  function choose(emoji: string): void {
    setRecent(rememberRecentEmoji(emoji));
    onSelect(emoji);
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, flat.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = flat[activeIndex];
      if (entry) choose(entry.emoji);
    }
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Emoji picker"
      className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-[min(100vw-1.5rem,20rem)] rounded-xl border bg-white p-2 shadow-lg"
    >
      <input
        ref={searchRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={handleSearchKeyDown}
        placeholder="Search emoji"
        className="mb-2 w-full rounded-md border bg-muted/40 px-2 py-1.5 text-sm outline-none"
        aria-controls={listId}
        aria-autocomplete="list"
      />

      <div id={listId} className="max-h-56 overflow-y-auto" role="listbox" aria-label="Emojis">
        {!query.trim() && recent.length > 0 ? (
          <section className="mb-2">
            <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Recent</p>
            <div className="grid grid-cols-8 gap-0.5">
              {recent.map((emoji) => (
                <button
                  key={`recent-${emoji}`}
                  type="button"
                  className="flex size-8 items-center justify-center rounded-md text-lg hover:bg-muted"
                  onClick={() => choose(emoji)}
                  aria-label={`Recent ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {query.trim() ? (
          <div className="grid grid-cols-8 gap-0.5">
            {filtered.length === 0 ? (
              <p className="col-span-8 px-1 py-3 text-center text-xs text-muted-foreground">No matches</p>
            ) : (
              filtered.map((entry, index) => (
                <button
                  key={`${entry.emoji}-${entry.name}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`flex size-8 items-center justify-center rounded-md text-lg hover:bg-muted ${
                    index === activeIndex ? "bg-muted" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(entry.emoji)}
                  aria-label={entry.name}
                >
                  {entry.emoji}
                </button>
              ))
            )}
          </div>
        ) : (
          EMOJI_CATEGORIES.map((category) => (
            <section key={category.id} className="mb-2">
              <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {category.label}
              </p>
              <div className="grid grid-cols-8 gap-0.5">
                {category.emojis.map((entry) => (
                  <button
                    key={`${category.id}-${entry.emoji}`}
                    type="button"
                    className="flex size-8 items-center justify-center rounded-md text-lg hover:bg-muted"
                    onClick={() => choose(entry.emoji)}
                    aria-label={entry.name}
                  >
                    {entry.emoji}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
