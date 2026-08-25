/**
 * Leaderboard referral/player autocomplete matching helpers.
 * Ranking and field matching are pure so tests do not need Prisma.
 */

export type PlayerSearchFieldSource = {
  readonly crmContactId: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly chatFirstNames: readonly string[];
  readonly chatLastNames: readonly string[];
  readonly chatUsernames: readonly string[];
};

export type RankedPlayerSearchHit = PlayerSearchFieldSource & {
  readonly score: number;
};

/** Strip whitespace and optional leading @ used when pasting Telegram usernames. */
export function normalizePlayerSearchQuery(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim();
}

function includesInsensitive(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function startsWithInsensitive(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.toLocaleLowerCase().startsWith(needle.toLocaleLowerCase());
}

function equalsInsensitive(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.toLocaleLowerCase() === needle.toLocaleLowerCase();
}

function combinedNames(row: PlayerSearchFieldSource): string[] {
  const out: string[] = [];
  const firsts = row.chatFirstNames.length > 0 ? row.chatFirstNames : [""];
  const lasts = row.chatLastNames.length > 0 ? row.chatLastNames : [""];
  for (const first of firsts) {
    for (const last of lasts) {
      const combined = `${first} ${last}`.trim().replace(/\s+/g, " ");
      if (combined) out.push(combined);
    }
  }
  return out;
}

/**
 * Collects searchable text surfaces for a participant contact.
 */
export function playerSearchHaystacks(row: PlayerSearchFieldSource): string[] {
  return [
    row.displayName,
    row.username ?? "",
    ...row.chatFirstNames,
    ...row.chatLastNames,
    ...row.chatUsernames,
    ...combinedNames(row)
  ].filter((value) => value.length > 0);
}

export function playerMatchesSearchQuery(row: PlayerSearchFieldSource, query: string): boolean {
  const needle = normalizePlayerSearchQuery(query);
  if (!needle) return true;
  return playerSearchHaystacks(row).some((hay) => includesInsensitive(hay, needle));
}

/**
 * Lower score = better. Exact → startsWith → contains.
 */
export function scorePlayerSearchMatch(row: PlayerSearchFieldSource, query: string): number {
  const needle = normalizePlayerSearchQuery(query);
  if (!needle) return 100;

  const surfaces = playerSearchHaystacks(row);
  if (surfaces.some((hay) => equalsInsensitive(hay, needle))) return 0;
  if (surfaces.some((hay) => startsWithInsensitive(hay, needle))) return 1;
  if (surfaces.some((hay) => includesInsensitive(hay, needle))) return 2;
  return Number.POSITIVE_INFINITY;
}

/**
 * Filters owner-scoped candidates, ranks matches, and caps the list.
 * Empty query returns alphabetical browse list (still capped).
 */
export function selectPlayerSearchHits(
  rows: readonly PlayerSearchFieldSource[],
  query: string,
  limit: number
): RankedPlayerSearchHit[] {
  const needle = normalizePlayerSearchQuery(query);
  const capped = Math.max(1, Math.min(limit, 50));

  if (!needle) {
    return [...rows]
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }))
      .slice(0, capped)
      .map((row) => ({ ...row, score: 100 }));
  }

  return rows
    .map((row) => ({ ...row, score: scorePlayerSearchMatch(row, needle) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
    })
    .slice(0, capped);
}
