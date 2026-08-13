"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { LeaderboardPlayerSearchHitDto } from "@atlas/shared";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

type PlayerSearchAutocompleteProps = {
  readonly id?: string;
  readonly excludeContactId?: string;
  readonly disabled?: boolean;
  readonly selected: LeaderboardPlayerSearchHitDto | null;
  readonly onSelect: (hit: LeaderboardPlayerSearchHitDto) => void;
  readonly onClear: () => void;
  readonly placeholder?: string;
  readonly limit?: number;
};

/**
 * Debounced leaderboard participant autocomplete.
 * Selection always stores a hit with crmContactId — never raw typed text.
 */
export function PlayerSearchAutocomplete({
  id,
  excludeContactId,
  disabled = false,
  selected,
  onSelect,
  onClear,
  placeholder = "Search player by name or username…",
  limit = 25
}: PlayerSearchAutocompleteProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly LeaderboardPlayerSearchHitDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [focused, setFocused] = useState(false);
  const requestSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selected) {
      setQuery("");
      setHits([]);
      setOpen(false);
      setActiveIndex(-1);
      setError(null);
    }
  }, [selected]);

  useEffect(() => {
    if (selected || disabled) return;

    const trimmed = query.trim();
    // Browse eligible players when focused with empty query; otherwise require 1+ chars.
    if (!focused && trimmed.length < 1) {
      setHits([]);
      setSearching(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const seq = ++requestSeq.current;
    const handle = window.setTimeout(() => {
      setSearching(true);
      setError(null);
      void api
        .leaderboardPlayersSearch({
          q: trimmed,
          limit,
          ...(excludeContactId ? { excludeContactId } : {})
        })
        .then((next) => {
          if (cancelled || seq !== requestSeq.current) return;
          setHits(next);
          setActiveIndex(next.length > 0 ? 0 : -1);
          setOpen(true);
        })
        .catch(() => {
          if (cancelled || seq !== requestSeq.current) return;
          setHits([]);
          setActiveIndex(-1);
          setError("Could not search players");
          setOpen(true);
        })
        .finally(() => {
          if (cancelled || seq !== requestSeq.current) return;
          setSearching(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [disabled, excludeContactId, focused, limit, query, selected]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setFocused(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  if (selected) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/80 px-2.5 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-800/80">Selected</p>
          <p className="truncate text-sm font-medium text-foreground">{selected.displayName}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {selected.telegramUsername ? `@${selected.telegramUsername}` : selected.shortId}
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-white hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={disabled}
          onClick={onClear}
        >
          Clear
        </button>
      </div>
    );
  }

  function choose(hit: LeaderboardPlayerSearchHitDto): void {
    onSelect(hit);
    setQuery("");
    setHits([]);
    setOpen(false);
    setActiveIndex(-1);
    setError(null);
  }

  return (
    <div ref={rootRef} className="relative space-y-1">
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 && hits[activeIndex] ? `${listboxId}-option-${hits[activeIndex]!.crmContactId}` : undefined
        }
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        autoComplete="off"
        className="h-10 text-sm"
        onFocus={() => {
          setFocused(true);
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setActiveIndex(-1);
            return;
          }
          if (!open || hits.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((prev) => (prev + 1) % hits.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((prev) => (prev <= 0 ? hits.length - 1 : prev - 1));
          } else if (event.key === "Enter" && activeIndex >= 0 && hits[activeIndex]) {
            event.preventDefault();
            choose(hits[activeIndex]!);
          }
        }}
      />

      {searching ? <p className="text-[11px] text-muted-foreground">Searching…</p> : null}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

      {open && !searching && !error && query.trim().length >= 0 ? (
        hits.length > 0 ? (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute z-20 max-h-48 w-full overflow-y-auto rounded-md border bg-white shadow-md"
          >
            {hits.map((hit, index) => {
              const active = index === activeIndex;
              return (
                <li key={hit.crmContactId}>
                  <button
                    type="button"
                    id={`${listboxId}-option-${hit.crmContactId}`}
                    role="option"
                    aria-selected={active}
                    className={`flex w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left text-xs focus-visible:outline-none ${
                      active ? "bg-muted" : "hover:bg-muted"
                    }`}
                    disabled={disabled}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(hit)}
                  >
                    <span className="font-medium text-foreground">{hit.displayName}</span>
                    <span className="text-muted-foreground">
                      {hit.telegramUsername ? `@${hit.telegramUsername}` : hit.shortId}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : focused || query.trim().length > 0 ? (
          <p className="text-[11px] text-muted-foreground">No matching players</p>
        ) : null
      ) : null}
    </div>
  );
}
