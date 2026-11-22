import type { WorkspaceGitEnvironment, WorkspaceGitJob, WorkspaceGitRepository, WorkspaceGitWorktree } from "../racp-workspace-git";
import type { GitHubCommitChecks } from "./github-connector";

export type RemoteEnvironmentInput = {
  id?: string;
  name: string;
  hostKey: string;
  setupScript?: string;
  variables?: WorkspaceGitEnvironment["variables"];
  idleReclaimHours?: number;
  regenerableDirs?: string[];
};

export type RemoteEnvironment = {
  id: string;
  name: string;
  hostKey: string;
  setupScript: string;
  variables: WorkspaceGitEnvironment["variables"];
  idleReclaimHours: number;
  regenerableDirs: string[];
  isDefault: boolean;
};

export type RepositoryProject = WorkspaceGitRepository & { defaultBranch: string; hostKey: string };

/**
 * The pull request recorded for a session's work branch. `state` and `draft`
 * are additive: links recorded by older releases carry only the number and
 * URL, and their state is unknown until GitHub is asked again.
 */
export type SessionPullRequestLink = {
  number: number;
  url: string;
  state?: "open" | "closed" | "merged";
  draft?: boolean;
};

export type SessionRemoteRepository = {
  environmentId: string;
  hostKey: string;
  hostLabel?: string;
  repository: WorkspaceGitRepository;
  baseBranch: string;
  workBranch?: string;
  state: "preparing" | "ready" | "reclaiming" | "reclaimed" | "failed" | "removing";
  phase?: WorkspaceGitJob["phase"];
  progress?: WorkspaceGitJob["progress"];
  error?: NonNullable<WorkspaceGitJob["error"]>;
  setup?: WorkspaceGitWorktree["setup"];
  pullRequest?: SessionPullRequestLink;
  lastActivityAt?: string;
  reclaimedAt?: string;
  reclaimedCommit?: string;
};

export type RemoteSessionTarget = {
  environmentId: string;
  repository: WorkspaceGitRepository;
  defaultBranch: string;
};

export type RemoteSessionWorkspaceStart = {
  sessionId: string;
  environmentId: string;
  repository: WorkspaceGitRepository;
  baseBranch: string;
};

export type RemoteSessionGitStatus = {
  reachable: boolean;
  workBranch: string;
  baseBranch: string;
  ahead?: number;
  aheadOfBase?: number;
  behind?: number;
  uncommittedFiles?: number;
  unpushedCommits?: number;
  pushedOnce?: boolean;
};

/**
 * What GitHub shows for a repository session's work branch. `pushed` is true
 * once the branch exists on GitHub. `checks` summarizes CI on its head commit
 * while a pull request is recorded; `checksError` says why they could not be
 * read when the branch itself could.
 */
export type RemoteSessionGitHubActivity = {
  pushed: boolean;
  checks?: GitHubCommitChecks;
  checksError?: { code: string; message: string };
};

export type RemoteSessionDeletePreflight =
  | { kind: "none" | "clean" | "unknown" }
  | { kind: "atRisk"; uncommittedFiles: number; unpushedCommits: number };

export type LeftoverWorktree = {
  hostKey: string;
  sessionId: string;
  repository: WorkspaceGitRepository;
  workBranch: string;
  path: string;
  createdAt: string;
  uncommittedFiles: number;
  unpushedCommits: number;
};
