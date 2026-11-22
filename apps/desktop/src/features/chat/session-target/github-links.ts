import { isGitBranchName, isGitHubOwner, isGitHubRepositoryName, type WorkspaceGitRepository } from "@pi-desktop/shared";

/** A branch name as URL path segments: each part encoded, its slashes kept. */
function refPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * GitHub's compare page for a work branch against its base. `undefined` for a
 * name that could not have come from GitHub, so no other URL is ever built.
 */
export function githubCompareUrl(repository: WorkspaceGitRepository, base: string, work: string): string | undefined {
  if (!isGitHubOwner(repository.owner) || !isGitHubRepositoryName(repository.name)
    || !isGitBranchName(base) || !isGitBranchName(work)) return undefined;
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
    + `/compare/${refPath(base)}...${refPath(work)}`;
}
