import {
  ErrorCodes, IPC, isGitBranchName, isGitHubOwner, isGitHubRepositoryName, isRegenerableDirPath,
  MAX_IDLE_RECLAIM_HOURS, WORKSPACE_GIT_MAX_REGENERABLE_DIRS, type RemoteEnvironmentInput, type WorkspaceGitReclaimResult,
} from "@pi-desktop/shared";
import type { GitHubConnector } from "../github/connector";
import { getActiveRemoteHostsBoot } from "../bootstrap/remote-hosts";
import { onConfirmedQuit } from "../bootstrap/confirmed-quit";
import { createIdleWorkspaceReclaimer, idleSince } from "../remote/idle-workspace-reclaimer";
import { createSessionWorkspaceGit } from "../remote/session-workspace-git";
import { createSessionWorkspaces, remoteError, type HostCall } from "../remote/session-workspaces";
import type { IpcRegistrar } from "./types";

let active: {
  workspaces: ReturnType<typeof createSessionWorkspaces>;
  git: ReturnType<typeof createSessionWorkspaceGit>;
  connector: GitHubConnector;
  reclaimer: ReturnType<typeof createIdleWorkspaceReclaimer>;
} | null = null;

export function getRemoteRepositorySessions() { return active; }

const invalid = () => remoteError(ErrorCodes.INVALID_ARGUMENT, "Invalid repository session request");
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
function string(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) throw invalid();
  return value;
}
function target(input: Record<string, unknown>, branchKey: "baseBranch" | "defaultBranch") {
  const { owner, name } = object(input.repository);
  const branch = string(input[branchKey], 4096);
  if (typeof owner !== "string" || typeof name !== "string" || !isGitHubOwner(owner)
    || !isGitHubRepositoryName(name) || !isGitBranchName(branch)) throw invalid();
  return { environmentId: string(input.environmentId), repository: { owner, name }, branch };
}
function environment(input: unknown): RemoteEnvironmentInput {
  const data = object(input);
  if ((data.setupScript !== undefined && (typeof data.setupScript !== "string" || Array.from(data.setupScript).length > 65_536))
    || (data.variables !== undefined && (!Array.isArray(data.variables) || data.variables.length > 64))) throw invalid();
  const { idleReclaimHours, regenerableDirs } = data;
  if (idleReclaimHours !== undefined && (typeof idleReclaimHours !== "number" || !Number.isInteger(idleReclaimHours)
    || idleReclaimHours < 0 || idleReclaimHours > MAX_IDLE_RECLAIM_HOURS)) throw invalid();
  if (regenerableDirs !== undefined && (!Array.isArray(regenerableDirs) || regenerableDirs.length > WORKSPACE_GIT_MAX_REGENERABLE_DIRS
    || !regenerableDirs.every((path): path is string => typeof path === "string" && isRegenerableDirPath(path)))) throw invalid();
  return {
    ...(data.id !== undefined ? { id: string(data.id) } : {}),
    name: string(data.name, 320), hostKey: string(data.hostKey),
    ...(idleReclaimHours !== undefined ? { idleReclaimHours } : {}),
    ...(regenerableDirs !== undefined ? { regenerableDirs } : {}),
    ...(typeof data.setupScript === "string" ? { setupScript: data.setupScript } : {}),
    ...(Array.isArray(data.variables) ? { variables: data.variables.map((raw) => {
      const row = object(raw);
      if (typeof row.value !== "string" || Array.from(row.value).length > 8192) throw invalid();
      return { name: string(row.name, 128), value: row.value };
    }) } : {}),
  };
}

export function registerRemoteRepositorySessions(deps: {
  registrar: IpcRegistrar;
  call: HostCall;
  connector: GitHubConnector;
  emit(channel: string, payload: unknown): void;
  log(message: string, error: unknown): void;
  runWhileIdle(sessionId: string, operation: () => Promise<void>): Promise<void>;
  acquireSessionOperation(sessionId: string): Promise<() => void>;
  hasQueuedPrompt(sessionId: string): boolean;
  isBusy(sessionId: string): boolean;
}) {
  const { registrar, call, connector, emit, log } = deps;
  const workspaces = createSessionWorkspaces({ call, hosts: getActiveRemoteHostsBoot, connector, emit, log, hasQueuedPrompt: deps.hasQueuedPrompt });
  const git = createSessionWorkspaceGit({ call, workspaces, connector, emit, log });
  const supported = (hostKey: string) => getActiveRemoteHostsBoot()?.workspaceGit.supportsReclaim(hostKey) === true;
  const reclaimer = createIdleWorkspaceReclaimer({
    connectedHosts: async () => (await getActiveRemoteHostsBoot()?.list() ?? []).filter((host) => host.connected).map((host) => host.hostKey),
    supported, environments: workspaces.list, bindings: () => workspaces.listBindings(["ready"]), log,
    async reclaim(candidate) {
      let result: WorkspaceGitReclaimResult | undefined;
      await deps.runWhileIdle(candidate.sessionId, async () => {
        const release = await deps.acquireSessionOperation(candidate.sessionId);
        try {
          const [current, environments] = await Promise.all([workspaces.binding(candidate.sessionId), workspaces.list()]);
          if (!current || current.hostKey !== candidate.hostKey || current.state !== "ready" || !supported(current.hostKey)
            || deps.isBusy(candidate.sessionId) || git.isOperating(candidate.sessionId)) return;
          const environment = environments.find((entry) => entry.id === current.environmentId);
          if (!environment || idleSince(current, environment, Date.now()) === undefined) return;
          result = await workspaces.reclaim(current, environment.regenerableDirs);
        } finally { release(); }
      });
      return result;
    },
  });
  active = { workspaces, git, connector, reclaimer };
  const boot = getActiveRemoteHostsBoot();
  boot?.workspaceGit.setCredentialProvider(() => connector.token());
  void boot?.workspaceGit.refreshCredential();
  const unsubscribe = connector.onChange(() => { void getActiveRemoteHostsBoot()?.workspaceGit.refreshCredential(); });
  onConfirmedQuit(() => { unsubscribe(); reclaimer.dispose(); workspaces.dispose(); active = null; });
  const handle = (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
    registrar.handleWithEvent(channel, (event, ...args) => {
      registrar.assertMainWindowSender(event);
      return handler(...args);
    });
  handle(IPC.invoke.environmentsList, async () => ({ environments: await workspaces.list() }));
  handle(IPC.invoke.environmentsUpsert, async (input) => ({ environment: await workspaces.upsert(environment(input)) }));
  handle(IPC.invoke.environmentsRemove, async (id) => ({ ok: await workspaces.removeEnvironment(string(id)) }));
  handle(IPC.invoke.remoteSessionTargetResolve, async (input) => {
    const { branch, ...selection } = target(object(input), "defaultBranch");
    return workspaces.resolve({ ...selection, defaultBranch: branch });
  });
  handle(IPC.invoke.remoteSessionWorkspaceStart, async (input) => {
    const data = object(input);
    const { branch, ...selection } = target(data, "baseBranch");
    return { remoteRepository: await workspaces.start({ ...selection, baseBranch: branch, sessionId: string(data.sessionId) }) };
  });
  handle(IPC.invoke.remoteSessionWorkspaceRetry, async (id) => ({ remoteRepository: await workspaces.retry(string(id)) }));
  handle(IPC.invoke.remoteSessionGitStatus, async (id) => ({ status: await git.status(string(id)) }));
  handle(IPC.invoke.remoteSessionPush, async (id) => ({ status: await git.push(string(id)) }));
  handle(IPC.invoke.remoteSessionPullRequestFind, async (id) => ({ pullRequest: await git.find(string(id)) }));
  handle(IPC.invoke.remoteSessionPullRequestCreate, async (input) => {
    const { sessionId, title, body, draft } = object(input);
    if (typeof body !== "string" || body.length > 65_536 || typeof draft !== "boolean") throw invalid();
    return { pullRequest: await git.create(string(sessionId), { title: string(title, 256).trim(), body, draft }) };
  });
  handle(IPC.invoke.remoteSessionDeletePreflight, async (id) => git.preflight(string(id)));
  handle(IPC.invoke.remoteLeftoverWorktreesList, async (hostKey) => ({ worktrees: await git.leftovers(string(hostKey)) }));
  handle(IPC.invoke.remoteLeftoverWorktreesRemove, async (hostKey, id) => ({ ok: await git.removeLeftover(string(hostKey), string(id)) }));
  void workspaces.resume().catch((error) => log("Could not resume repository workspaces", error));
}
