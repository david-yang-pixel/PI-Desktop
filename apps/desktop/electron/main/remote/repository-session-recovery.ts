/**
 * What a paired Host's connection does for repository sessions: announce the
 * environments, resume workspaces, reconcile deleted sessions' worktrees, and
 * check for idle workspaces to reclaim.
 *
 * Each phase runs on its own. A failure in one is logged and never skips the
 * next, so a single bad worktree cannot keep idle workspaces from being
 * reclaimed, or a resume failure keep deleted sessions' worktrees on the Host.
 */
import { ErrorCodes } from "@pi-desktop/shared";
import type { SessionWorkspaceGit } from "./session-workspace-git";
import { remoteCode, type SessionWorkspaces } from "./session-workspaces";

export type RepositorySessionRecovery = {
  workspaces: Pick<SessionWorkspaces, "announceEnvironments" | "resume">;
  git: Pick<SessionWorkspaceGit, "reconcile">;
  reclaimer: { check(hostKey: string): Promise<void> };
};

export type RecoveryLog = (level: "info" | "warn", message: string, data: Record<string, unknown>) => void;

async function phase(log: RecoveryLog, name: string, hostKey: string | undefined, task: () => Promise<unknown>) {
  try {
    await task();
  } catch (error) {
    const data = { phase: name, ...(hostKey ? { hostKey } : {}), error: String(error) };
    // Host-core, or the remote host service, is not up yet. At cold start a
    // Host can connect before host-core answers; the pass that runs once it
    // does recovers that Host, so this is not a failure to warn about.
    if (remoteCode(error) === ErrorCodes.HOST_UNAVAILABLE) log("info", "repository session recovery deferred until the host is ready", data);
    else log("warn", "could not recover repository sessions", data);
  }
}

/** Recover the repository sessions of one Host that just connected. */
export async function recoverRepositoryHost(sessions: RepositorySessionRecovery, hostKey: string, log: RecoveryLog) {
  await phase(log, "environments", hostKey, () => sessions.workspaces.announceEnvironments());
  await phase(log, "resume", hostKey, () => sessions.workspaces.resume(hostKey));
  await phase(log, "reconcile", hostKey, () => sessions.git.reconcile(hostKey));
  await phase(log, "reclaim", hostKey, () => sessions.reclaimer.check(hostKey));
}

/**
 * Recover every repository session once host-core can answer. Resume covers
 * every binding, including preparations on Hosts that are away; reconcile and
 * reclamation run on each Host connected by then. A Host that connects later
 * recovers through its own connection.
 */
export async function recoverRepositorySessions(
  sessions: RepositorySessionRecovery,
  connectedHosts: () => Promise<string[]>,
  log: RecoveryLog,
) {
  await phase(log, "environments", undefined, () => sessions.workspaces.announceEnvironments());
  await phase(log, "resume", undefined, () => sessions.workspaces.resume());
  let hosts: string[] = [];
  await phase(log, "hosts", undefined, async () => { hosts = await connectedHosts(); });
  for (const hostKey of hosts) {
    await phase(log, "reconcile", hostKey, () => sessions.git.reconcile(hostKey));
    await phase(log, "reclaim", hostKey, () => sessions.reclaimer.check(hostKey));
  }
}
