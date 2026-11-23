/**
 * Exact lookups for a repository or branch the capped listings left out.
 *
 * The connector lists at most 1000 repositories and 500 branches, and an
 * organization's SSO can trim either. When the search text names one exactly
 * and the loaded list does not have it, the picker asks GitHub for that one
 * name instead of saying nothing matches.
 */
import { useEffect, useRef, useState } from "react";
import {
  isGitBranchName,
  isGitHubOwner,
  isGitHubRepositoryName,
  type GitHubBranchSummary,
  type GitHubRepositoryRef,
  type GitHubRepositorySummary,
} from "@pi-desktop/shared";

/** How long typing must pause before a lookup is sent. */
export const LOOKUP_DELAY_MS = 300;

/** The `owner/name` the search names exactly, when the loaded list lacks it. */
export function unlistedRepositoryQuery(
  query: string,
  listed: readonly GitHubRepositorySummary[] | undefined,
): GitHubRepositoryRef | null {
  if (!listed) return null;
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(query.trim());
  if (!match) return null;
  const [, owner, name] = match;
  if (!isGitHubOwner(owner) || !isGitHubRepositoryName(name)) return null;
  const fullName = `${owner}/${name}`.toLowerCase();
  return listed.some((item) => item.fullName.toLowerCase() === fullName) ? null : { owner, name };
}

/** The branch the search names exactly, when the loaded list lacks it. */
export function unlistedBranchQuery(query: string, listed: readonly GitHubBranchSummary[] | undefined): string | null {
  if (!listed) return null;
  const name = query.trim();
  if (!name || !isGitBranchName(name)) return null;
  return listed.some((item) => item.name === name) ? null : name;
}

export type LookupState<T> =
  | { status: "loading" }
  | { status: "found"; value: T }
  | { status: "missing" }
  | { status: "error"; cause: unknown };

/**
 * Look `key` up once typing pauses. A newer key, or unmounting, discards the
 * answer for the older one. `null` turns the lookup off.
 */
export function useUnlistedLookup<T>(key: string | null, lookup: () => Promise<T | null>): LookupState<T> | undefined {
  const [state, setState] = useState<{ key: string; result: LookupState<T> }>();
  const latest = useRef(lookup);
  latest.current = lookup;
  useEffect(() => {
    if (!key) return;
    let current = true;
    const timer = setTimeout(() => {
      setState({ key, result: { status: "loading" } });
      latest.current().then(
        (value) => { if (current) setState({ key, result: value ? { status: "found", value } : { status: "missing" } }); },
        (cause: unknown) => { if (current) setState({ key, result: { status: "error", cause } }); },
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key]);
  if (!key) return undefined;
  return state?.key === key ? state.result : { status: "loading" };
}
