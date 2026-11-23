import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCodes, IPC, type GitHubPullRequestInput, type GitHubPullRequestSummary, type LeftoverWorktree,
  type RemoteSessionDeletePreflight, type RemoteSessionGitStatus, type SessionPullRequestLink,
  type WorkspaceGitRepository, type WorkspaceGitWorktree,
} from "@pi-desktop/shared";
import type { GitHubConnector } from "../github/connector";
import { busyJob, offlineError, remoteCode, remoteError, type HostCall, type SessionWorkspaces, type WorkspaceBinding } from "./session-workspaces";

type PendingRemoval = { hostKey: string; sessionId: string; repository: WorkspaceGitRepository; workBranch?: string };
type PullRequest = GitHubPullRequestSummary;
/** `forceWithLease`: the work branch was rebased; replace the remote one the Host last saw. */
export type PushOptions = { forceWithLease?: boolean };
const ORPHAN_MIN_AGE = 24 * 60 * 60 * 1_000;
/** How often using a session may ask GitHub about its pull request again. */
const PULL_REQUEST_REFRESH_MS = 5 * 60 * 1_000;
const pullRequestLink = (pullRequest: PullRequest): SessionPullRequestLink => ({
  number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, draft: pullRequest.draft,
});
const missing = (error: unknown) => remoteCode(error) === ErrorCodes.WORKSPACE_GIT_NOT_FOUND;
const lostRemoval = () => remoteError(ErrorCodes.CONFLICT, "The remote worktree has unpushed work. Confirm deletion after reviewing its status.");

export function createSessionWorkspaceGit(deps: {
  call: HostCall;
  workspaces: SessionWorkspaces;
  connector: Pick<GitHubConnector, "findPullRequest" | "createPullRequest">;
  emit(channel: string, payload: unknown): void;
  log?(message: string, error: unknown): void;
}) {
  const { call, workspaces, connector, emit } = deps;
  const pushJobs = new Map<string, { hostKey: string; jobId: string }>();
  const pushes = new Map<string, Promise<RemoteSessionGitStatus>>();
  const requests = new Map<string, Promise<PullRequest>>();
  const reconciling = new Map<string, Promise<void>>();
  const lookups = new Map<string, Promise<PullRequest | null>>();
  /** When GitHub was last asked about each session's pull request. */
  const checkedAt = new Map<string, number>();
  const pending = (hostKey: string) => call<{ removals: PendingRemoval[] }>("sessionWorkspace.pendingRemoval.list", { hostKey });
  const discardPending = (hostKey: string, sessionId: string) => call("sessionWorkspace.pendingRemoval.remove", { hostKey, sessionId });
  const load = async (sessionId: string) => {
    const binding = await workspaces.binding(sessionId);
    if (!binding) throw remoteError(ErrorCodes.REMOTE_SESSION_NOT_REPOSITORY, "This is not a repository session");
    return binding;
  };
  const requireReady = async (sessionId: string) => {
    const binding = await load(sessionId);
    if (binding.state !== "ready" || !binding.workBranch) throw remoteError(ErrorCodes.REMOTE_WORKSPACE_NOT_READY, "Repository worktree is not ready");
    return { ...binding, workBranch: binding.workBranch };
  };
  async function readStatus(binding: WorkspaceBinding & { workBranch: string }): Promise<RemoteSessionGitStatus> {
    const { sessionId, hostKey, workBranch, baseBranch } = binding;
    try {
      const result = await workspaces.git().status(hostKey, sessionId);
      if (result.worktree.reclaimedAt || result.worktree.checkoutPresent === false) {
        await workspaces.recoverMissingCheckout(binding, result.worktree);
        throw remoteError(ErrorCodes.REMOTE_WORKSPACE_NOT_READY, "The repository checkout is being restored");
      }
      return { reachable: true, workBranch, baseBranch, ahead: result.ahead, behind: result.behind, aheadOfBase: result.aheadOfBase,
        uncommittedFiles: result.uncommittedFiles, unpushedCommits: result.unpushedCommits, pushedOnce: result.pushedOnce };
    } catch (error) {
      if (!offlineError(error)) throw error;
      return { reachable: false, workBranch, baseBranch };
    }
  }
  async function push(sessionId: string, assertCanPublish?: () => void, options: PushOptions = {}) {
    const binding = await requireReady(sessionId);
    const before = await readStatus(binding);
    if (!before.reachable) throw remoteError(ErrorCodes.REMOTE_TARGET_HOST_OFFLINE, "The host is offline");
    if ((!before.unpushedCommits && !before.ahead && before.pushedOnce) || before.aheadOfBase === 0 && !before.pushedOnce) {
      throw remoteError(ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH, "The work branch is already pushed");
    }
    let jobId: string;
    try {
      assertCanPublish?.();
      ({ jobId } = await workspaces.git().push(binding.hostKey, sessionId,
        options.forceWithLease === true ? { forceWithLease: true } : undefined));
    } catch (error) {
      const active = busyJob(error);
      if (!active) throw error;
      jobId = active;
    }
    pushJobs.set(sessionId, { hostKey: binding.hostKey, jobId });
    const started = Date.now();
    try {
      while (true) {
        const job = await workspaces.git().job(binding.hostKey, jobId);
        if (job.kind !== "push") throw remoteError(ErrorCodes.WORKSPACE_GIT_BUSY, "Another Git operation is running");
        if (job.state === "succeeded") return readStatus(binding);
        if (job.state !== "running") throw remoteError(job.error?.code ?? ErrorCodes.WORKSPACE_GIT_FAILED, job.error?.message ?? "Could not push the work branch");
        emit(IPC.event.remoteSessionPushProgress, { sessionId, active: true, phase: job.phase, progress: job.progress });
        await sleep(Date.now() - started < 30_000 ? 1_000 : 2_000, null, { ref: false });
      }
    } finally {
      pushJobs.delete(sessionId);
      emit(IPC.event.remoteSessionPushProgress, { sessionId, active: false, phase: "done" });
    }
  }
  /**
   * Record what GitHub says about the work branch's latest pull request. A
   * merged or closed request stays linked with its state; nothing found keeps
   * the recorded link, because GitHub never deletes a pull request and an
   * empty answer cannot prove the old one is gone.
   */
  async function record(sessionId: string, current: WorkspaceBinding, pullRequest: PullRequest) {
    const link = pullRequestLink(pullRequest);
    const previous = current.pullRequest;
    if (previous?.number === link.number && previous.url === link.url
      && previous.state === link.state && previous.draft === link.draft) return;
    workspaces.announce(await workspaces.update(sessionId, { pullRequest: link }));
  }
  async function lookupPullRequest(sessionId: string) {
    const binding = await requireReady(sessionId);
    // Every state: the newest open request wins, then the most recent one.
    const found = await connector.findPullRequest(binding.repository, binding.workBranch);
    checkedAt.set(sessionId, Date.now());
    if (found) await record(sessionId, binding, found);
    return found;
  }
  function find(sessionId: string) {
    const existing = lookups.get(sessionId);
    if (existing) return existing;
    const task = lookupPullRequest(sessionId).finally(() => lookups.delete(sessionId));
    lookups.set(sessionId, task);
    return task;
  }
  /**
   * Bring a recorded pull request's state up to date when the session is
   * used, at most once per interval. A merged request is final.
   */
  async function refreshPullRequest(sessionId: string) {
    const last = checkedAt.get(sessionId);
    if (last !== undefined && Date.now() - last < PULL_REQUEST_REFRESH_MS) return;
    try {
      const binding = await workspaces.binding(sessionId);
      if (binding?.state !== "ready" || !binding.workBranch || binding.pullRequest?.state === "merged") return;
      await (requests.get(sessionId) ?? find(sessionId));
    } catch (error) {
      deps.log?.("Could not refresh the session's pull request", error);
    }
  }
  async function create(sessionId: string, input: Pick<GitHubPullRequestInput, "title" | "body" | "draft">, assertCanPublish?: () => void) {
    const binding = await requireReady(sessionId);
    const previous = await find(sessionId);
    // A merged or closed request does not answer the call: new commits get a
    // new pull request, and GitHub refuses one when there are none.
    if (previous?.state === "open") return previous;
    try {
      await api.push(sessionId, assertCanPublish);
    } catch (error) {
      if (remoteCode(error) !== ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH) throw error;
    }
    const status = await readStatus(binding);
    if (status.aheadOfBase === 0 || !status.pushedOnce && !status.unpushedCommits) {
      const code = status.uncommittedFiles ? ErrorCodes.REMOTE_SESSION_UNCOMMITTED_CHANGES : ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH;
      throw remoteError(code, status.uncommittedFiles ? "Commit your changes before opening a pull request" : "There are no commits ahead of the base branch");
    }
    const request = { ...input, head: binding.workBranch, base: binding.baseBranch };
    assertCanPublish?.();
    let created: PullRequest;
    try {
      created = await connector.createPullRequest(binding.repository, request);
    } catch (error) {
      // Only a request opened meanwhile answers this call; the merged one
      // found above must not be returned as if it were new.
      const raced = await find(sessionId).catch(() => null);
      if (raced?.state !== "open") throw error;
      return raced;
    }
    checkedAt.set(sessionId, Date.now());
    workspaces.announce(await workspaces.update(sessionId, { pullRequest: pullRequestLink(created) }));
    return created;
  }
  /**
   * One worktree's failure must not stop the others: it is logged and stays
   * for the next connection. An unreachable Host ends the pass, since every
   * later call would fail the same way.
   */
  async function isolated(message: string, task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      if (offlineError(error)) throw error;
      deps.log?.(message, error);
    }
  }
  async function reconcileRemoval(hostKey: string, removal: PendingRemoval, worktrees: WorkspaceGitWorktree[]) {
    if (await workspaces.binding(removal.sessionId)) return;
    const tree = worktrees.find((candidate) => candidate.sessionId === removal.sessionId);
    const foreign = tree && ((removal.workBranch && tree.workBranch !== removal.workBranch)
      || tree.repository.owner !== removal.repository.owner || tree.repository.name !== removal.repository.name);
    if (!foreign) {
      try {
        // Offline deletion cannot prove a worktree is clean. Keep any
        // discovered local work for the leftover management view. Even
        // with no worktree listed, a prepare the deleted session left
        // running is stopped here before it can create one.
        if (!(await removeWorktree(hostKey, removal.sessionId, false)).removed) return;
      } catch (error) {
        // Still busy: try again on the next connection.
        if (remoteCode(error) === ErrorCodes.WORKSPACE_GIT_BUSY) return;
        if (!missing(error)) throw error;
      }
    }
    await discardPending(hostKey, removal.sessionId);
  }
  async function reconcile(hostKey: string) {
    const { removals } = await pending(hostKey);
    const worktrees = await workspaces.git().list(hostKey);
    for (const removal of removals) {
      await isolated("Could not remove a deleted session's worktree", () => reconcileRemoval(hostKey, removal, worktrees));
    }
    const bound = new Set((await workspaces.listBindings()).map((item) => item.sessionId));
    const pendingIds = new Set(removals.map((item) => item.sessionId));
    for (const tree of worktrees) {
      const age = Date.now() - Date.parse(tree.createdAt);
      if (bound.has(tree.sessionId) || pendingIds.has(tree.sessionId) || !(age >= ORPHAN_MIN_AGE)) continue;
      await isolated("Could not remove an orphaned worktree", async () => {
        await workspaces.git().remove(hostKey, tree.sessionId, false).catch((error) => {
          if (!missing(error) && remoteCode(error) !== ErrorCodes.WORKSPACE_GIT_BUSY) throw error;
        });
      });
    }
  }
  /**
   * A job the desktop does not track, such as a prepare whose reply was lost,
   * still holds the worktree. The session is being deleted, so stop it.
   */
  async function removeWorktree(hostKey: string, sessionId: string, force: boolean) {
    try {
      return await workspaces.git().remove(hostKey, sessionId, force);
    } catch (error) {
      const jobId = busyJob(error);
      if (!jobId) throw error;
      await workspaces.stopJob(hostKey, jobId);
      return workspaces.git().remove(hostKey, sessionId, force);
    }
  }
  async function removeForDelete(current: WorkspaceBinding, force: boolean) {
    const { sessionId } = current;
    try {
      // Waits until the cancelled prepare job has stopped.
      if (current.state === "preparing") await workspaces.cancel(sessionId);
      const push = pushJobs.get(sessionId);
      if (push) await workspaces.stopJob(push.hostKey, push.jobId);
      const result = await removeWorktree(current.hostKey, sessionId, force);
      if (!result.removed) throw lostRemoval();
    } catch (error) {
      if (missing(error)) return;
      const legacyHost = !force && [ErrorCodes.HOST_VERSION_MISMATCH, "METHOD_NOT_FOUND"].includes(remoteCode(error) ?? "");
      // An unreachable Host is skipped only after the user confirmed the
      // "cannot check unpushed work" warning (`force`).
      if (!(legacyHost || offlineError(error) && force)) throw error;
      await call("sessionWorkspace.pendingRemoval.add", {
        sessionId, hostKey: current.hostKey, repository: current.repository, workBranch: current.workBranch,
      });
    }
  }
  const touched = (sessionId: string) => workspaces.touch?.(sessionId).catch((error) => deps.log?.("Could not record repository workspace activity", error));
  const api = {
    isOperating: (sessionId: string) => pushes.has(sessionId) || requests.has(sessionId),
    async status(sessionId: string) { return readStatus(await requireReady(sessionId)); },
    push(sessionId: string, assertCanPublish?: () => void, options: PushOptions = {}) {
      const current = pushes.get(sessionId);
      if (current) return current;
      const task = push(sessionId, assertCanPublish, options).finally(async () => {
        try { await touched(sessionId); }
        finally { pushes.delete(sessionId); }
      });
      pushes.set(sessionId, task);
      return task;
    },
    find(sessionId: string) {
      return requests.get(sessionId) ?? find(sessionId);
    },
    refreshPullRequest,
    create(sessionId: string, input: Pick<GitHubPullRequestInput, "title" | "body" | "draft">, assertCanPublish?: () => void) {
      const current = requests.get(sessionId);
      if (current) return current;
      const task = create(sessionId, input, assertCanPublish).finally(async () => {
        try { await touched(sessionId); }
        finally { requests.delete(sessionId); }
      });
      requests.set(sessionId, task);
      return task;
    },
    async preflight(sessionId: string): Promise<RemoteSessionDeletePreflight> {
      const binding = await workspaces.binding(sessionId);
      if (!binding) return { kind: "none" };
      try {
        const status = await workspaces.git().status(binding.hostKey, sessionId);
        const { uncommittedFiles, unpushedCommits } = status;
        if (uncommittedFiles || unpushedCommits) return { kind: "atRisk", uncommittedFiles, unpushedCommits };
        return { kind: "clean" };
      } catch (error) {
        if (missing(error)) return { kind: binding.state === "preparing" || !binding.path ? "none" : "unknown" };
        if (offlineError(error)) return { kind: "unknown" };
        throw error;
      }
    },
    async beforeDelete(sessionId: string, force: boolean) {
      const current = await workspaces.binding(sessionId);
      if (!current) return;
      try {
        await removeForDelete(current, force);
        checkedAt.delete(sessionId);
      } catch (error) {
        // The session stays. Cancelling stopped its preparation monitor;
        // without one the binding would show "preparing" forever and could
        // be neither retried nor deleted.
        if (current.state === "preparing") workspaces.watch(sessionId);
        throw error;
      }
    },
    reconcile(hostKey: string) {
      const current = reconciling.get(hostKey);
      if (current) return current;
      if (!workspaces.git().supportsSafeRemoval(hostKey)) return Promise.resolve();
      const task = reconcile(hostKey).finally(() => {
        reconciling.delete(hostKey);
        emit(IPC.event.sessionsChanged, { reason: "remote.leftovers.changed" });
      });
      reconciling.set(hostKey, task);
      return task;
    },
    async leftovers(hostKey: string): Promise<LeftoverWorktree[]> {
      const bound = new Set((await workspaces.listBindings()).map((item) => item.sessionId));
      const result: LeftoverWorktree[] = [];
      for (const tree of await workspaces.git().list(hostKey)) {
        if (bound.has(tree.sessionId)) continue;
        try {
          const status = await workspaces.git().status(hostKey, tree.sessionId);
          result.push({ hostKey, sessionId: tree.sessionId, repository: tree.repository, workBranch: tree.workBranch,
            path: tree.path, createdAt: tree.createdAt, uncommittedFiles: status.uncommittedFiles, unpushedCommits: status.unpushedCommits });
        } catch (error) {
          if (missing(error)) continue;
          // An unreachable Host cannot give a trustworthy list at all. Any
          // other failure hides only that worktree; it stays on the Host.
          if (offlineError(error)) throw error;
          deps.log?.("Could not read a leftover worktree's status", error);
        }
      }
      return result;
    },
    async removeLeftover(hostKey: string, sessionId: string) {
      if (await workspaces.binding(sessionId)) throw remoteError(ErrorCodes.CONFLICT, "This worktree still belongs to a session");
      const { removed } = await workspaces.git().remove(hostKey, sessionId, true);
      if (removed) await discardPending(hostKey, sessionId);
      return removed;
    },
  };
  return api;
}

export type SessionWorkspaceGit = ReturnType<typeof createSessionWorkspaceGit>;
