/**
 * What GitHub shows for a repository session's work branch: whether it has
 * been pushed and, once a pull request is recorded, the CI state of its head
 * commit. The renderer names only the session; main picks the repository and
 * branch from the session's binding and spends the connector token itself.
 */
import { ErrorCodes, type RemoteSessionGitHubActivity } from "@pi-desktop/shared";
import type { GitHubConnector } from "../github/connector";
import { remoteCode, remoteError, type SessionWorkspaces } from "./session-workspaces";

export function createSessionGitHubActivity(deps: {
  workspaces: Pick<SessionWorkspaces, "binding">;
  connector: Pick<GitHubConnector, "getBranch" | "getCommitChecks">;
}) {
  return async function activity(sessionId: string): Promise<RemoteSessionGitHubActivity> {
    const binding = await deps.workspaces.binding(sessionId);
    if (!binding) throw remoteError(ErrorCodes.REMOTE_SESSION_NOT_REPOSITORY, "This is not a repository session");
    if (!binding.workBranch) return { pushed: false };
    const head = await deps.connector.getBranch(binding.repository, binding.workBranch);
    if (!head) return { pushed: false };
    if (!binding.pullRequest) return { pushed: true };
    try {
      return { pushed: true, checks: await deps.connector.getCommitChecks(binding.repository, head.sha) };
    } catch (error) {
      // The branch is on GitHub either way; say why its checks are missing.
      return { pushed: true, checksError: {
        code: remoteCode(error) ?? ErrorCodes.GITHUB_NETWORK,
        message: error instanceof Error ? error.message : String(error),
      } };
    }
  };
}
