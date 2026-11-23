import { ErrorCodes } from "@pi-desktop/shared";
import type { GitHubConnector } from "./connector";
import type { createSessionWorkspaceGit, PushOptions } from "../remote/session-workspace-git";
import { remoteCode, remoteError, type SessionWorkspaces } from "../remote/session-workspaces";

/*
 * Desktop has no manual push or pull request controls for cloud repository
 * sessions: the Agent publishes its own work through these tools. They use the
 * built-in GitHub connector whenever it is signed in, independent of the
 * "GitHub tools for the agent" switch, which only governs the issues and pull
 * requests MCP server. Each call is a high-risk tool call and needs an Agent
 * turn, so Plan and Goal turns cannot publish.
 */

export const githubSessionPushTool = {
  externalToolSource: "connector" as const,
  name: "plugin_pi_github_PushSessionBranch",
  description: "Use PI-Desktop's built-in GitHub connector to push this cloud session's work branch to GitHub. Commit the intended changes first; uncommitted files are not pushed. The push only ever updates this session's own work branch. Returns whether anything was pushed, the work and base branches, and the commit and uncommitted-file counts afterwards. A push GitHub refuses because the branch is not a fast-forward fails with WORKSPACE_GIT_PUSH_REJECTED: fetch, rebase the work branch onto the remote one, and push again with forceWithLease.",
  risk: "high" as const,
  parameters: {
    type: "object",
    properties: {
      forceWithLease: {
        type: "boolean",
        description: "Only after you rebased the work branch. Replaces the remote work branch if it still points at the commit this session last pushed or fetched; commits pushed by anyone else are never overwritten. Leave unset for a normal push.",
      },
    },
    additionalProperties: false,
  },
};

export const githubSessionPullRequestTool = {
  externalToolSource: "connector" as const,
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

export const githubSessionToolDefinitions = [githubSessionPushTool, githubSessionPullRequestTool];

type RepositorySessions = {
  workspaces: Pick<SessionWorkspaces, "binding">;
  connector: Pick<GitHubConnector, "status">;
  git: Pick<ReturnType<typeof createSessionWorkspaceGit>, "push" | "status" | "create">
    & Partial<Pick<ReturnType<typeof createSessionWorkspaceGit>, "refreshPullRequest">>;
};

function pushInput(args: unknown): PushOptions {
  if (args === undefined || args === null) return {};
  const invalid = () => remoteError(ErrorCodes.INVALID_ARGUMENT, "Pushing the session branch takes only an optional forceWithLease flag");
  if (typeof args !== "object" || Array.isArray(args)) throw invalid();
  const { forceWithLease, ...rest } = args as { forceWithLease?: unknown };
  if (Object.keys(rest).length > 0 || (forceWithLease !== undefined && typeof forceWithLease !== "boolean")) throw invalid();
  return forceWithLease === true ? { forceWithLease: true } : {};
}

function pullRequestInput(args: unknown) {
  const { title, body = "", draft = false } =
    (args ?? {}) as { title?: unknown; body?: unknown; draft?: unknown };
  if (typeof title !== "string" || !title.trim() || title.length > 256 || /[\u0000-\u001f]/.test(title)
    || typeof body !== "string" || body.length > 65_536 || typeof draft !== "boolean") {
    throw remoteError(ErrorCodes.INVALID_ARGUMENT, "A pull request needs a title, optional body, and optional draft flag");
  }
  return { title: title.trim(), body, draft };
}

const signedIn = (status: Awaited<ReturnType<GitHubConnector["status"]>>) => status.connected && !status.needsReauthentication;

/**
 * The tool list is fixed for the length of a turn, while each launch re-reads
 * the connector. A turn launched before a sign-out, or before GitHub rejected
 * the token, must not publish with the list it started with.
 */
async function assertSignedIn(sessions: RepositorySessions) {
  if (!signedIn(await sessions.connector.status())) {
    throw remoteError(ErrorCodes.GITHUB_NOT_CONNECTED, "Sign in to GitHub in Settings > Connectors to publish this session");
  }
}

async function pushSessionBranch(sessions: RepositorySessions, sessionId: string, assertCurrent: () => void, options: PushOptions) {
  try {
    return { pushed: true, ...(await sessions.git.push(sessionId, assertCurrent, options)) };
  } catch (error) {
    // An up-to-date branch is an answer, not a failure: the counts tell the
    // Agent whether it still has uncommitted work to commit first.
    if (remoteCode(error) !== ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH) throw error;
    return { pushed: false, ...(await sessions.git.status(sessionId)) };
  }
}

export function createGitHubSessionTools(getSessions: () => RepositorySessions | null) {
  return {
    owns(toolName: string) {
      return githubSessionToolDefinitions.some((tool) => tool.name === toolName);
    },
    async available(sessionId: string) {
      const sessions = getSessions();
      if (!sessions) return false;
      const binding = await sessions.workspaces.binding(sessionId);
      if (binding?.state !== "ready" || !binding.workBranch) return false;
      // Read on every launch, so a sign-in, sign-out, or reauthentication
      // reaches the next prompt of every live repository session.
      const available = signedIn(await sessions.connector.status());
      // Each launch is a chance to learn that the recorded pull request was
      // merged or closed; it never delays the launch.
      if (available) void sessions.git.refreshPullRequest?.(sessionId);
      return available;
    },
    async execute(input: {
      sessionId?: string;
      toolName: string;
      mode?: string;
      args: unknown;
      isCurrent(): boolean;
    }) {
      if (input.mode !== "agent") {
        throw remoteError(ErrorCodes.PERMISSION_DENIED, "Publishing to GitHub requires an Agent turn");
      }
      const sessions = getSessions();
      if (!sessions || !input.sessionId) {
        throw remoteError(ErrorCodes.REMOTE_SESSION_NOT_REPOSITORY, "This is not a repository session");
      }
      const assertCurrent = () => {
        if (!input.isCurrent()) throw remoteError("TOOL_TURN_CANCELLED", "The turn ended before publishing to GitHub");
      };
      if (input.toolName === githubSessionPushTool.name) {
        const options = pushInput(input.args);
        await assertSignedIn(sessions);
        assertCurrent();
        return pushSessionBranch(sessions, input.sessionId, assertCurrent, options);
      }
      if (input.toolName === githubSessionPullRequestTool.name) {
        const args = pullRequestInput(input.args);
        await assertSignedIn(sessions);
        assertCurrent();
        return sessions.git.create(input.sessionId, args, assertCurrent);
      }
      throw remoteError(ErrorCodes.INVALID_ARGUMENT, `Unknown GitHub session tool: ${input.toolName}`);
    },
  };
}
