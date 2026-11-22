/**
 * Text for a failure while starting or preparing a session in a remote
 * environment, in the user's language.
 *
 * Electron main and the paired Host write their messages in English, for logs.
 * Each failure they report also carries an `ErrorCodes` code, and the catalogs
 * hold a sentence for every code a user can act on, so the renderer shows that
 * sentence. GitHub connector codes keep the connector's own sentences. Any
 * other failure keeps its message: the renderer's own target checks throw text
 * that is already localized, and an unmapped code stays diagnosable.
 */
import { ErrorCodes } from "@pi-desktop/shared";
import { githubErrorTextForCode, type Translate } from "../../settings/connectors/github-error-message";

const HOST_OFFLINE = "sessionTarget.errors.hostOffline";
const HOST_OUTDATED = "sessionTarget.errors.hostOutdated";
const GIT_FAILED = "sessionTarget.errors.gitFailed";

/** A Map, not an object literal: codes cross the IPC boundary from main. */
const REMOTE_TARGET_ERROR_KEYS: ReadonlyMap<string, string> = new Map([
  // Main reports a Host without a live connection as AGENT_UNAVAILABLE when it
  // creates a session without a repository.
  [ErrorCodes.AGENT_UNAVAILABLE, HOST_OFFLINE],
  [ErrorCodes.HOST_DISCONNECTED, HOST_OFFLINE],
  [ErrorCodes.REMOTE_CONNECTION_FAILED, HOST_OFFLINE],
  [ErrorCodes.REMOTE_TARGET_HOST_OFFLINE, HOST_OFFLINE],
  [ErrorCodes.HOST_VERSION_MISMATCH, HOST_OUTDATED],
  [ErrorCodes.REMOTE_TARGET_UNSUPPORTED, HOST_OUTDATED],
  [ErrorCodes.REMOTE_ENVIRONMENT_NOT_FOUND, "sessionTarget.environmentUnavailable"],
  [ErrorCodes.REMOTE_WORKSPACE_NOT_READY, "sessionTarget.errors.workspaceNotReady"],
  [ErrorCodes.WORKSPACE_GIT_UNAVAILABLE, "sessionTarget.errors.gitUnavailable"],
  [ErrorCodes.WORKSPACE_GIT_AUTH_REQUIRED, "sessionTarget.errors.gitAuthRequired"],
  [ErrorCodes.WORKSPACE_GIT_REPOSITORY_NOT_FOUND, "errors.GITHUB_NOT_FOUND"],
  [ErrorCodes.WORKSPACE_GIT_BRANCH_NOT_FOUND, "sessionTarget.errors.branchNotFound"],
  [ErrorCodes.WORKSPACE_GIT_NOT_FOUND, "sessionTarget.errors.worktreeMissing"],
  [ErrorCodes.WORKSPACE_GIT_BUSY, "sessionTarget.errors.gitBusy"],
  [ErrorCodes.WORKSPACE_GIT_JOB_NOT_FOUND, GIT_FAILED],
  [ErrorCodes.WORKSPACE_GIT_FAILED, GIT_FAILED],
  [ErrorCodes.WORKSPACE_GIT_SETUP_FAILED, "sessionTarget.errors.setupRequired"],
  [ErrorCodes.WORKSPACE_GIT_TRANSPORT_REFUSED, "sessionTarget.errors.transportRefused"],
]);

/** The catalog's sentence for a remote target code, or `fallback` for any other. */
export function remoteTargetErrorTextForCode(
  t: Translate,
  code: unknown,
  fallback: string,
): string {
  if (typeof code !== "string") return fallback;
  const key = REMOTE_TARGET_ERROR_KEYS.get(code);
  return key ? t(key, { defaultValue: fallback }) : githubErrorTextForCode(t, code, fallback);
}

/** The same, for a thrown value: `api` rejections carry the code as `code`. */
export function remoteTargetErrorText(t: Translate, error: unknown): string {
  const fallback = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return remoteTargetErrorTextForCode(t, code, fallback);
}
