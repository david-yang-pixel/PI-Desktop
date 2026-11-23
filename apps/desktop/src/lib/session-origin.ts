import type { SessionSummary } from "@pi-desktop/shared";

/**
 * A scheduled-task run owns its transcript: `scheduled.run` creates the session
 * and records it in `task_runs`, and the host reports that ownership back as
 * `scheduledRun` on every session summary (issue #1291).
 *
 * The Scheduled page reads those transcripts in place. The sidebar can also
 * open a completed, opted-in run. Both routes resolve the same stored session.
 *
 * Ownership is derived, never stored on the session: deleting the task removes
 * the `task_runs` row, so its transcripts return to the ordinary lists instead
 * of becoming unreachable.
 */
export function isAutomationSession(
  session: Pick<SessionSummary, "scheduledRun"> | null | undefined,
): boolean {
  return session?.scheduledRun === true;
}

/** The sessions offered by global conversation search. */
export function listableSessions<T extends Pick<SessionSummary, "scheduledRun">>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => !isAutomationSession(session));
}
