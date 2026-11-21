import { ErrorCodes, type AppSettings } from "@pi-desktop/shared";
import type { GitHubConnector } from "./connector";
import type { createSessionWorkspaceGit } from "../remote/session-workspace-git";
import { remoteError, type SessionWorkspaces } from "../remote/session-workspaces";

export const githubSessionPullRequestTool = {
  name: "plugin_pi_github_CreateSessionPullRequest",
  description: "Use PI-Desktop's built-in GitHub connector to open or return a pull request for this cloud session's repository and base branch. Use this tool for the current workspace when the user requests a PR. Commit the intended changes first. The tool pushes the session branch if needed and returns the PR URL.",
  risk: "high" as const,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", maxLength: 65_536 },
      draft: { type: "boolean" },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

type RepositorySessions = {
  workspaces: Pick<SessionWorkspaces, "binding">;
  connector: Pick<GitHubConnector, "status">;
  git: Pick<ReturnType<typeof createSessionWorkspaceGit>, "create">;
};

function pullRequestInput(args: unknown) {
  const { title, body = "", draft = false } =
    (args ?? {}) as { title?: unknown; body?: unknown; draft?: unknown };
  if (typeof title !== "string" || !title.trim() || title.length > 256 || /[\u0000-\u001f]/.test(title)
    || typeof body !== "string" || body.length > 65_536 || typeof draft !== "boolean") {
    throw remoteError(ErrorCodes.INVALID_ARGUMENT, "A pull request needs a title, optional body, and optional draft flag");
  }
  return { title: title.trim(), body, draft };
}

export function createGitHubSessionPullRequestTool(getSessions: () => RepositorySessions | null) {
  return {
    async available(sessionId: string) {
      const sessions = getSessions();
      if (!sessions) return false;
      const binding = await sessions.workspaces.binding(sessionId);
      if (binding?.state !== "ready" || !binding.workBranch) return false;
      const status = await sessions.connector.status();
      return status.connected && !status.needsReauthentication;
    },
    async execute(input: {
      sessionId?: string;
      mode?: string;
      args: unknown;
      settings: Pick<AppSettings, "githubAgentTools">;
      isCurrent(): boolean;
    }) {
      if (input.mode !== "agent" || input.settings.githubAgentTools === false) {
        throw remoteError(ErrorCodes.PERMISSION_DENIED, "GitHub PR creation requires enabled GitHub Agent tools and an Agent turn");
      }
      const sessions = getSessions();
      if (!sessions || !input.sessionId) {
        throw remoteError(ErrorCodes.REMOTE_SESSION_NOT_REPOSITORY, "This is not a repository session");
      }
      const args = pullRequestInput(input.args);
      const assertCurrent = () => {
        if (!input.isCurrent()) throw remoteError("TOOL_TURN_CANCELLED", "The turn ended before publishing the pull request");
      };
      assertCurrent();
      return sessions.git.create(input.sessionId, args, assertCurrent);
    },
  };
}
