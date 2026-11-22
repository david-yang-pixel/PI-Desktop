/**
 * What a paired Host's connection does for repository sessions: announce the
 * environments, resume workspaces, reconcile deleted sessions' worktrees, and
 * check for idle workspaces to reclaim.
 *
 * Each phase runs on its own. A failure in one is logged and never skips the
 * next, so a single bad worktree cannot keep idle workspaces from being
 * reclaimed, or a resume failure keep deleted sessions' worktrees on the Host.
 */
import type { SessionWorkspaceGit } from "./session-workspace-git";
import type { SessionWorkspaces } from "./session-workspaces";

export type RepositorySessionRecovery = {
  workspaces: Pick<SessionWorkspaces, "announceEnvironments" | "resume">;
  git: Pick<SessionWorkspaceGit, "reconcile">;
  reclaimer: { check(hostKey: string): Promise<void> };
};

export type RecoveryLog = (message: string, data: Record<string, unknown>) => void;

async function phase(log: RecoveryLog, name: string, hostKey: string | undefined, task: () => Promise<unknown>) {
  try {
    await task();
  } catch (error) {
    log("could not recover repository sessions", { phase: name, ...(hostKey ? { hostKey } : {}), error: String(error) });
  }
}

/** Recover the repository sessions of one Host that just connected. */
export async function recoverRepositoryHost(sessions: RepositorySessionRecovery, hostKey: string, log: RecoveryLog) {
  await phase(log, "environments", hostKey, () => sessions.workspaces.announceEnvironments());
  await phase(log, "resume", hostKey, () => sessions.workspaces.resume(hostKey));
  await phase(log, "reconcile", hostKey, () => sessions.git.reconcile(hostKey));
  await phase(log, "reclaim", hostKey, () => sessions.reclaimer.check(hostKey));
}
