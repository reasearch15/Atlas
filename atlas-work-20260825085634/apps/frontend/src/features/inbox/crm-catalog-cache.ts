import type { CrmAssigneeDto, CrmTagDto } from "@atlas/shared";
import { api } from "@/lib/api";

interface CatalogCache<T> {
  value: T | null;
  inflight: Promise<T> | null;
  fetchedAt: number;
}

const TAG_TTL_MS = 30 * 60 * 1000;
const ASSIGNEE_TTL_MS = 30 * 60 * 1000;

const tagsCache: CatalogCache<readonly CrmTagDto[]> = { value: null, inflight: null, fetchedAt: 0 };
const assigneesCache: CatalogCache<readonly CrmAssigneeDto[]> = { value: null, inflight: null, fetchedAt: 0 };

/**
 * Returns workspace CRM tags, loading once and reusing until invalidated.
 */
export async function getCachedCrmTags(force = false): Promise<readonly CrmTagDto[]> {
  return getCached(tagsCache, () => api.crmTags(), TAG_TTL_MS, force);
}

/**
 * Returns workspace assignees, loading once and reusing until TTL/invalidation.
 */
export async function getCachedCrmAssignees(force = false): Promise<readonly CrmAssigneeDto[]> {
  return getCached(assigneesCache, () => api.crmAssignees(), ASSIGNEE_TTL_MS, force);
}

/** Call after tag create / update / archive so the next reader refetches. */
export function invalidateCrmTagsCache(): void {
  tagsCache.value = null;
  tagsCache.inflight = null;
  tagsCache.fetchedAt = 0;
}

export function invalidateCrmAssigneesCache(): void {
  assigneesCache.value = null;
  assigneesCache.inflight = null;
  assigneesCache.fetchedAt = 0;
}

async function getCached<T>(
  cache: CatalogCache<T>,
  loader: () => Promise<T>,
  ttlMs: number,
  force: boolean
): Promise<T> {
  if (!force && cache.value && Date.now() - cache.fetchedAt < ttlMs) {
    return cache.value;
  }
  if (!force && cache.inflight) {
    return cache.inflight;
  }
  const inflight = loader()
    .then((value) => {
      cache.value = value;
      cache.fetchedAt = Date.now();
      cache.inflight = null;
      return value;
    })
    .catch((error) => {
      cache.inflight = null;
      throw error;
    });
  cache.inflight = inflight;
  return inflight;
}
