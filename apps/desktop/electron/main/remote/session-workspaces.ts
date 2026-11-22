import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_IDLE_RECLAIM_HOURS, ErrorCodes, IPC, type ProjectGroupRecord, type RemoteEnvironment,
  type RemoteEnvironmentInput, type RemoteSessionTarget, type RemoteSessionWorkspaceStart,
  type SessionRemoteRepository, type SessionSummary, type WorkspaceGitJob,
  type WorkspaceGitReclaimResult, type WorkspaceGitWorktree,
} from "@pi-desktop/shared";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";
import type { GitHubConnector } from "../github/connector";

export type HostCall = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
export type WorkspaceBinding = SessionRemoteRepository & {
  sessionId: string;
  fromSessionId?: string | null;
  path?: string | null;
  jobId?: string | null;
  requireSetupOnRetry?: boolean;
  updatedAt?: string;
};
export type WorkspaceStart = RemoteSessionWorkspaceStart & { fromSessionId?: string };

/**
 * How long a delete waits for a cancelled Host job to stop. The Host's own
 * cancel waits ten seconds; a job still cleaning up after that keeps the
 * worktree busy.
 */
const JOB_STOP_TIMEOUT_MS = 30_000;
const JOB_STOP_POLL_MS = 500;

export const remoteError = (errorCode: string, message: string) => Object.assign(new Error(message), { errorCode });
export function remoteCode(error: unknown): string | undefined {
  const value = error as { errorCode?: string; code?: string; data?: { errorCode?: string } } | undefined;
  return value?.data?.errorCode ?? value?.errorCode ?? value?.code;
}
/**
 * The Host could not be reached. Every workspace-git call reconnects a
 * dropped Host first (`ensureReady`), so an unreachable Host usually fails
 * with the connect error itself: `HOST_BOOTSTRAP_FAILED` when the SSH
 * startup check fails for any reason (refused, timed out, or SSH
 * authentication), `REMOTE_CONNECTION_FAILED` when the WebSocket cannot
 * open. Either way the Host's state cannot be read now. RACP token and
 * version refusals (`*_AUTH_FAILED`, `HOST_VERSION_MISMATCH`) are not
 * offline.
 */
export function offlineError(error: unknown): boolean {
  return [
    "AGENT_UNAVAILABLE", "HOST_UNAVAILABLE", "TIMEOUT", "REMOTE_TARGET_HOST_OFFLINE", "REMOTE_DISCONNECTED",
    "HOST_DISCONNECTED", "NOT_CONNECTED", ErrorCodes.HOST_BOOTSTRAP_FAILED, ErrorCodes.REMOTE_CONNECTION_FAILED,
  ].includes(remoteCode(error) ?? "");
}
export function busyJob(error: unknown): string | undefined {
  if (remoteCode(error) !== ErrorCodes.WORKSPACE_GIT_BUSY) return undefined;
  const value = error as { data?: { jobId?: string }; details?: { jobId?: string; details?: { jobId?: string } } };
  return value.data?.jobId ?? value.details?.jobId ?? value.details?.details?.jobId;
}

export function createSessionWorkspaces(deps: {
  call: HostCall;
  hosts: () => RemoteHostsBoot | null;
  connector: Pick<GitHubConnector, "status">;
  emit: (channel: string, payload: unknown) => void;
  log: (message: string, error: unknown) => void;
  hasQueuedPrompt?: (sessionId: string) => boolean;
}) {
  const { call, hosts, connector, emit, log } = deps;
  const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const starting = new Set<string>();
  const recovering = new Set<string>();
  const reclaiming = new Map<string, Promise<WorkspaceGitReclaimResult>>();
  const rerunSetups = new Set<string>();
  let disposed = false;
  /** Ends waits that nothing else owns, such as a delete's job stop. */
  const disposal = new AbortController();
  const git = () => {
    const boot = hosts();
    if (!boot) throw remoteError(ErrorCodes.HOST_UNAVAILABLE, "Remote hosts are unavailable");
    return boot.workspaceGit;
  };
  const binding = async (sessionId: string) => (await call<{ binding: WorkspaceBinding | null }>("sessionWorkspace.get", { sessionId })).binding;
  const update = async (sessionId: string, patch: Record<string, unknown>, expectedState?: WorkspaceBinding["state"]) =>
    (await call<{ binding: WorkspaceBinding }>("sessionWorkspace.update", { sessionId, patch, ...(expectedState ? { expectedState } : {}) })).binding;
  const touch = (sessionId: string) => call("sessionWorkspace.touchActivity", { sessionId });
  const listBindings = async (states?: string[]) =>
    (await call<{ bindings: WorkspaceBinding[] }>("sessionWorkspace.list", { states })).bindings;
  const list = async (): Promise<RemoteEnvironment[]> => {
    const [paired, stored] = await Promise.all([
      hosts()?.list() ?? [],
      call<{ environments: Omit<RemoteEnvironment, "isDefault">[] }>("environments.list"),
    ]);
    return paired.flatMap((host) => {
      const id = `default:${host.hostKey}`;
      const entries = stored.environments.filter((env) => env.hostKey === host.hostKey);
      const custom = entries.filter((env) => env.id !== id).map((env) => ({ ...env, isDefault: false }));
      const base = entries.find((env) => env.id === id) ?? {
        id, name: host.label, hostKey: host.hostKey, setupScript: "", variables: [],
        idleReclaimHours: DEFAULT_IDLE_RECLAIM_HOURS, regenerableDirs: [],
      };
      return [{ ...base, isDefault: true }, ...custom];
    });
  };
  async function getEnvironment(id: string) {
    const environment = (await list()).find((entry) => entry.id === id);
    if (!environment) throw remoteError(ErrorCodes.REMOTE_ENVIRONMENT_NOT_FOUND, "Remote environment no longer exists");
    return environment;
  }
  async function announceEnvironments() {
    emit(IPC.event.environmentsChanged, { environments: await list() });
  }
  function publicBinding(b: WorkspaceBinding, job?: WorkspaceGitJob): SessionRemoteRepository {
    const { environmentId, hostKey, repository, baseBranch, state, workBranch, setup, pullRequest, error, reclaimedAt, reclaimedCommit } = b;
    const liveSetup = job?.phase === "runningSetup"
      ? { status: "running" as const, ...(job.setupLogTail ? { logTail: job.setupLogTail } : {}) }
      : setup;
    return { environmentId, hostKey, repository, baseBranch, state,
      ...(workBranch ? { workBranch } : {}), ...(liveSetup ? { setup: liveSetup } : {}),
      ...(pullRequest ? { pullRequest } : {}), ...(error ? { error } : {}),
      ...(reclaimedAt ? { reclaimedAt } : {}), ...(reclaimedCommit ? { reclaimedCommit } : {}),
      ...(job ? { phase: job.phase, progress: job.progress } : {}),
    };
  }
  function announce(b: WorkspaceBinding, job?: WorkspaceGitJob) {
    const remoteRepository = publicBinding(b, job);
    emit(IPC.event.remoteSessionWorkspaceChanged, { sessionId: b.sessionId, remoteRepository });
    return remoteRepository;
  }
  async function prepare(b: WorkspaceBinding, rerunSetup = false): Promise<string> {
    // A removed environment leaves the Host's registered snapshot available.
    const rebuild = b.requireSetupOnRetry === true;
    const environment = rebuild || rerunSetup
      ? (await list()).find((entry) => entry.id === b.environmentId && entry.hostKey === b.hostKey)
      : b.path ? undefined : await getEnvironment(b.environmentId);
    try {
      const result = await git().prepare(b.hostKey, {
        sessionId: b.sessionId, repository: b.repository, baseBranch: b.baseBranch,
        ...(rebuild ? { rebuild: true } : rerunSetup ? { rerunSetup: true } : !environment ? { restoreOnly: true } : {}),
        ...(!rebuild && !rerunSetup && environment && b.fromSessionId ? { fromSessionId: b.fromSessionId } : {}),
        ...(environment ? { environment: { variables: environment.variables, setupScript: environment.setupScript } } : {}),
      });
      return result.jobId;
    } catch (error) {
      const jobId = busyJob(error);
      if (jobId) return jobId;
      throw error;
    }
  }
  function readyPatch(worktree: WorkspaceGitWorktree) {
    return { state: "ready", path: worktree.path, workBranch: worktree.workBranch, setup: worktree.setup, jobId: null, error: null,
      reclaimedAt: null, reclaimedCommit: null, requireSetupOnRetry: false };
  }
  async function monitor(sessionId: string, signal: AbortSignal) {
    const active = async () => {
      if (signal.aborted) return null;
      const current = await binding(sessionId);
      return !signal.aborted && current?.state === "preparing" ? current : null;
    };
    const save = async (patch: Record<string, unknown>) => {
      if (!await active()) return;
      const current = await update(sessionId, patch, "preparing");
      if (!signal.aborted) announce(current);
    };
    const initial = await active();
    if (!initial) return;
    const started = Date.now();
    let previous = "";
    const isRerunSetup = rerunSetups.has(sessionId);
    try {
      let restoredMissingCheckout = false;
      let jobId = initial.jobId ?? await prepare(initial, isRerunSetup);
      if ((await binding(sessionId))?.state === "preparing") {
        await update(sessionId, { jobId });
      }
      while (true) {
        const current = await active();
        if (!current) return;
        let job: WorkspaceGitJob;
        try {
          job = await git().job(current.hostKey, jobId);
        } catch (error) {
          if (remoteCode(error) !== ErrorCodes.WORKSPACE_GIT_JOB_NOT_FOUND) throw error;
          const worktree = (await git().list(current.hostKey)).find((item) => item.sessionId === sessionId);
          if (!worktree || worktree.setup.status === "running") throw error;
          if (current.requireSetupOnRetry) {
            if (worktree.checkoutPresent === true && !worktree.reclaimedAt
              && (worktree.setup.status === "ok" || worktree.setup.status === "none")) {
              await save(readyPatch(worktree));
            } else {
              await save({ state: "failed", jobId: null, setup: worktree.setup, error: {
                code: ErrorCodes.WORKSPACE_GIT_FAILED, message: "Workspace restoration was interrupted. Retry to continue.",
              } });
            }
            return;
          }
          if (worktree.checkoutPresent === false) {
            if (restoredMissingCheckout || !await active()) throw error;
            restoredMissingCheckout = true;
            const recovery = await update(sessionId, { path: worktree.path, workBranch: worktree.workBranch, jobId: null });
            jobId = await prepare(recovery, isRerunSetup);
            if ((await binding(sessionId))?.state === "preparing") await update(sessionId, { jobId });
            continue;
          }
          await save(readyPatch(worktree));
          return;
        }
        if (!await active()) return;
        if (job.kind === "prepare" && job.state === "succeeded" && job.worktree) {
          if (current.requireSetupOnRetry && (job.worktree.reclaimedAt || job.worktree.checkoutPresent !== true
            || !["none", "ok"].includes(job.worktree.setup.status))) {
            throw remoteError(ErrorCodes.WORKSPACE_GIT_FAILED, "The host did not finish restoring the workspace");
          }
          await save(readyPatch(job.worktree));
          return;
        }
        if (job.state !== "running") {
          const failure = job.error ?? { code: ErrorCodes.WORKSPACE_GIT_FAILED, message: "Workspace preparation did not complete" };
          await save({ state: "failed", error: failure, jobId: null, ...(job.worktree ? { setup: job.worktree.setup } : {}) });
          return;
        }
        const progress = JSON.stringify([job.phase, job.progress, job.setupLogTail]);
        if (progress !== previous) {
          previous = progress;
          announce(current, job);
        }
        await sleep(Date.now() - started < 30_000 ? 1_000 : 2_000, null, { signal });
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      if (offlineError(error) && !initial.requireSetupOnRetry) {
        // Nothing can be polled until the Host is back. Say so instead of
        // showing "preparing" forever, and keep the job id: the Host may
        // still be running it, and `resume` picks it up on reconnect.
        await save({ state: "failed", error: {
          code: ErrorCodes.REMOTE_TARGET_HOST_OFFLINE,
          message: `The remote host could not be reached (${message}). Retry, or preparation resumes when the host reconnects.`,
        } });
        return;
      }
      await save({ state: "failed", jobId: null, error: { code: remoteCode(error) ?? "WORKSPACE_GIT_FAILED", message } });
    } finally {
      rerunSetups.delete(sessionId);
    }
  }
  function watch(sessionId: string) {
    if (disposed || jobs.has(sessionId)) return;
    const controller = new AbortController();
    const done = monitor(sessionId, controller.signal).catch((error) => log("Could not monitor repository workspace", error))
      .finally(() => jobs.delete(sessionId));
    jobs.set(sessionId, { controller, done });
  }

  async function beginPreparation(current: WorkspaceBinding, rebuild = current.requireSetupOnRetry === true) {
    const { sessionId } = current;
    const result = announce(await update(sessionId, { state: "preparing", jobId: null, error: null, requireSetupOnRetry: rebuild }, current.state));
    watch(sessionId);
    return result;
  }

  /** A preparation the monitor stopped watching because its Host went offline. */
  const waitingForHost = (current: WorkspaceBinding) => current.state === "failed"
    && current.error?.code === ErrorCodes.REMOTE_TARGET_HOST_OFFLINE && current.requireSetupOnRetry !== true;

  /** Continue polling the same job: the Host may have finished it meanwhile. */
  async function resumeAfterOffline(current: WorkspaceBinding) {
    if (disposed) return;
    let next: WorkspaceBinding;
    try {
      next = await update(current.sessionId, { state: "preparing", error: null }, "failed");
    } catch (error) {
      // Retried or deleted by the user in the meantime.
      if (remoteCode(error) === ErrorCodes.CONFLICT) return;
      throw error;
    }
    announce(next);
    watch(current.sessionId);
  }

  /** Cancel a Host job and wait until it no longer holds the worktree. */
  async function stopJob(hostKey: string, jobId: string) {
    const gone = (error: unknown) => remoteCode(error) === ErrorCodes.WORKSPACE_GIT_JOB_NOT_FOUND;
    try {
      await git().cancelJob(hostKey, jobId);
    } catch (error) {
      if (gone(error)) return;
      throw error;
    }
    const deadline = Date.now() + JOB_STOP_TIMEOUT_MS;
    while (true) {
      let job: WorkspaceGitJob;
      try {
        job = await git().job(hostKey, jobId);
      } catch (error) {
        if (gone(error)) return;
        throw error;
      }
      if (job.state !== "running") return;
      if (Date.now() >= deadline) {
        throw Object.assign(remoteError(ErrorCodes.WORKSPACE_GIT_BUSY,
          "The repository workspace is still stopping a Git operation. Try again in a moment."), { details: { jobId } });
      }
      await sleep(JOB_STOP_POLL_MS, null, { signal: disposal.signal });
    }
  }

  async function recoverMissingCheckout(expected: WorkspaceBinding, worktree: WorkspaceGitWorktree) {
    const { sessionId } = expected;
    if (worktree.reclaimedAt) {
      await adoptReclaim(expected, worktree);
      return;
    }
    if (worktree.checkoutPresent !== false || worktree.sessionId !== sessionId
      || worktree.path !== expected.path || worktree.workBranch !== expected.workBranch
      || worktree.repository.owner !== expected.repository.owner || worktree.repository.name !== expected.repository.name
      || disposed || recovering.has(sessionId)) return;
    recovering.add(sessionId);
    try {
      await jobs.get(sessionId)?.done;
      const current = await binding(sessionId);
      if (current?.state === "ready" && current.hostKey === expected.hostKey
        && current.path === expected.path && current.workBranch === expected.workBranch && !disposed) {
        await beginPreparation(current);
      }
    } finally {
      recovering.delete(sessionId);
    }
  }

  async function start(input: WorkspaceStart) {
    if (starting.has(input.sessionId)) throw remoteError(ErrorCodes.CONFLICT, "The session already has a workspace starting");
    starting.add(input.sessionId);
    try {
      const environment = await getEnvironment(input.environmentId);
      const { binding: created } = await call<{ binding: WorkspaceBinding }>("sessionWorkspace.bind", { ...input, hostKey: environment.hostKey });
      const result = announce(created);
      watch(created.sessionId);
      return result;
    } finally {
      starting.delete(input.sessionId);
    }
  }
  async function ensureSession(sessionId: string, parentSessionId?: string) {
    if (await binding(sessionId)) return;
    const { session } = await call<{ session?: SessionSummary }>("session.get", { id: sessionId, messageLimit: 1 });
    if (!session?.projectPath?.startsWith("remote-project:")) return;
    const { groups } = await call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
    const project = groups.find((group) => group.primaryPath === session.projectPath)?.repository;
    if (!project) return;
    const parent = parentSessionId ? await binding(parentSessionId) : null;
    await start({ sessionId, environmentId: parent?.environmentId ?? `default:${project.hostKey}`,
      repository: { owner: project.owner, name: project.name }, baseBranch: parent?.baseBranch ?? project.defaultBranch,
      ...(parent ? { fromSessionId: parent.sessionId } : {}),
    });
  }

  function matchesWorktree(current: WorkspaceBinding, worktree: WorkspaceGitWorktree): boolean {
    return worktree.sessionId === current.sessionId && worktree.path === current.path
      && worktree.workBranch === current.workBranch && worktree.repository.owner === current.repository.owner
      && worktree.repository.name === current.repository.name;
  }

  async function markReclaimed(current: WorkspaceBinding, commit: string, reclaimedAt: string) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) || !Number.isFinite(Date.parse(reclaimedAt))) {
      throw remoteError(ErrorCodes.WORKSPACE_GIT_FAILED, "The host returned invalid workspace recovery information");
    }
    const next = await update(current.sessionId, { state: "reclaimed", reclaimedAt, reclaimedCommit: commit,
      jobId: null, setup: null, error: null }, current.state);
    announce(next);
    return next;
  }

  async function adoptReclaim(current: WorkspaceBinding, worktree: WorkspaceGitWorktree) {
    if (matchesWorktree(current, worktree) && worktree.reclaimedAt && worktree.reclaimedCommit) {
      return markReclaimed(current, worktree.reclaimedCommit, worktree.reclaimedAt);
    }
    return current;
  }

  async function settleReclaim(sessionId: string) {
    await reclaiming.get(sessionId)?.catch(() => undefined);
    const current = await binding(sessionId);
    if (current?.state !== "reclaiming") return current;
    const { worktree } = await git().status(current.hostKey, sessionId);
    if (!matchesWorktree(current, worktree)) return current;
    if (worktree.reclaimedAt) return adoptReclaim(current, worktree);
    if (worktree.checkoutPresent !== true) return current;
    const next = await update(sessionId, { state: "ready" }, "reclaiming");
    announce(next);
    return next;
  }

  async function reclaim(current: WorkspaceBinding, regenerableDirs: string[]) {
    const id = current.sessionId;
    const next = await update(id, { state: "reclaiming" }, "ready");
    announce(next);
    const task = (async () => {
      const result = await git().reclaim(next.hostKey, id, regenerableDirs);
      if (result.reclaimed === true) await markReclaimed(next, result.commit, result.reclaimedAt);
      else if (result.reclaimed === false) announce(await update(id, { state: "ready", lastActivityAt: current.lastActivityAt ?? current.updatedAt }, "reclaiming"));
      return result;
    })();
    reclaiming.set(id, task);
    try { return await task; }
    finally { reclaiming.delete(id); }
  }

  async function wake(sessionId: string) {
    const current = await binding(sessionId);
    const settled = current?.state === "reclaiming" ? await settleReclaim(sessionId) : current;
    if (settled?.state === "reclaimed" && !disposed) {
      await beginPreparation(settled, true);
    } else if (settled?.state === "ready" && deps.hasQueuedPrompt?.(sessionId)) {
      announce(settled);
    }
  }

  return {
    git, binding, update, listBindings, announce, ensureSession, list, getEnvironment, start, recoverMissingCheckout, touch, reclaim, wake,
    watch, stopJob,
    async get(sessionId: string) {
      const current = await binding(sessionId);
      return current ? publicBinding(current) : null;
    },
    async resolve(input: RemoteSessionTarget) {
      const environment = await getEnvironment(input.environmentId);
      if (!(await hosts()?.list())?.some((host) => host.hostKey === environment.hostKey && host.connected)) {
        throw remoteError(ErrorCodes.REMOTE_TARGET_HOST_OFFLINE, "The selected remote host is offline");
      }
      if (!await git().supported(environment.hostKey)) {
        throw remoteError(ErrorCodes.REMOTE_TARGET_UNSUPPORTED, "The selected host needs an update for repository sessions");
      }
      const status = await connector.status();
      if (!status.connected || status.needsReauthentication) throw remoteError(ErrorCodes.GITHUB_NOT_CONNECTED, "Connect GitHub to start a repository session");
      const { path } = await git().repository(environment.hostKey, input.repository);
      const { group, created } = await call<{ group: ProjectGroupRecord; created: boolean }>("project.group.ensureRepository", {
        hostKey: environment.hostKey, path, repository: input.repository, defaultBranch: input.defaultBranch,
      });
      if (created) emit(IPC.event.sessionsChanged, { reason: "remote.repository.project" });
      return { projectPath: group.primaryPath };
    },
    async retry(sessionId: string) {
      await jobs.get(sessionId)?.done;
      const current = await binding(sessionId);
      const isSetupFailure = current?.state === "ready" && current.setup?.status === "failed";
      if (current?.state !== "failed" && !isSetupFailure) {
        throw remoteError(ErrorCodes.CONFLICT, "Only a failed workspace can be retried");
      }
      if (!current.path && !current.requireSetupOnRetry) await getEnvironment(current.environmentId);
      const shouldRerunSetup = !current.requireSetupOnRetry && (isSetupFailure || Boolean(current.path && current.setup?.status === "failed"));
      if (shouldRerunSetup) rerunSetups.add(sessionId);
      try { return await beginPreparation(current); }
      catch (error) {
        if (shouldRerunSetup) rerunSetups.delete(sessionId);
        throw error;
      }
    },
    async cancel(sessionId: string) {
      rerunSetups.delete(sessionId);
      const monitorTask = jobs.get(sessionId);
      monitorTask?.controller.abort();
      await monitorTask?.done;
      const current = await binding(sessionId);
      if (current?.jobId) await stopJob(current.hostKey, current.jobId);
    },
    async resume(hostKey?: string) {
      const bindings = (await listBindings(["preparing", "ready", "reclaiming", "reclaimed", "failed"]))
        .filter((current) => !hostKey || current.hostKey === hostKey);
      for (const current of bindings) {
        if (current.state === "preparing") watch(current.sessionId);
      }
      const ready = bindings.filter((current) => current.state === "ready" || current.state === "reclaiming" || current.state === "reclaimed");
      const waiting = bindings.filter(waitingForHost);
      if (!ready.length && !waiting.length) return;
      const connected = hostKey ? [hostKey] : (await hosts()?.list() ?? []).filter((host) => host.connected).map((host) => host.hostKey);
      // Every Host refuses the same way while it is away or outdated; there
      // is nothing to report per workspace then.
      const hostWide = (error: unknown) => offlineError(error) || remoteCode(error) === ErrorCodes.HOST_VERSION_MISMATCH;
      /** One workspace's failure is logged and never skips the others. */
      const each = async (task: () => Promise<unknown>) => {
        try {
          await task();
        } catch (error) {
          if (hostWide(error)) throw error;
          log("Could not check a repository workspace on reconnect", error);
        }
      };
      await Promise.all(connected.map(async (key) => {
        const selected = ready.filter((current) => current.hostKey === key);
        const resumable = waiting.filter((current) => current.hostKey === key);
        try {
          for (const current of resumable) await each(() => resumeAfterOffline(current));
          if (!selected.length) return;
          const worktrees = new Map((await git().list(key)).map((worktree) => [worktree.sessionId, worktree]));
          for (const current of selected) {
            await each(async () => {
              const worktree = worktrees.get(current.sessionId);
              if (current.state === "reclaiming") await settleReclaim(current.sessionId);
              else if (current.state === "ready" && worktree) await recoverMissingCheckout(current, worktree);
              if (deps.hasQueuedPrompt?.(current.sessionId)) await wake(current.sessionId);
            });
          }
        } catch (error) {
          if (!hostWide(error)) log("Could not check repository workspaces on reconnect", error);
        }
      }));
    },
    async waitUntilReady(sessionId: string) {
      await wake(sessionId);
      let current = await binding(sessionId);
      while (current?.state === "preparing" && !disposed) {
        const task = jobs.get(sessionId);
        if (!task) break;
        await task.done;
        current = await binding(sessionId);
      }
      if (current && current.state !== "ready") throw remoteError(ErrorCodes.REMOTE_WORKSPACE_NOT_READY, "Repository workspace is not ready");
    },
    async upsert(input: RemoteEnvironmentInput) {
      if (!(await hosts()?.list())?.some((host) => host.hostKey === input.hostKey)) {
        throw remoteError(ErrorCodes.REMOTE_ENVIRONMENT_NOT_FOUND, "The paired host no longer exists");
      }
      const { environment } = await call<{ environment: Omit<RemoteEnvironment, "isDefault"> }>("environments.upsert", { ...input });
      await announceEnvironments();
      return { ...environment, isDefault: environment.id === `default:${environment.hostKey}` };
    },
    async removeEnvironment(id: string) {
      const result = await call<{ ok: boolean }>("environments.remove", { id });
      await announceEnvironments();
      return result;
    },
    async removeForHost(hostKey: string) {
      await call("environments.removeForHost", { hostKey });
      await announceEnvironments();
    },
    announceEnvironments,
    dispose() {
      disposed = true;
      disposal.abort();
      rerunSetups.clear();
      for (const task of jobs.values()) task.controller.abort();
    },
  };
}

export type SessionWorkspaces = ReturnType<typeof createSessionWorkspaces>;
