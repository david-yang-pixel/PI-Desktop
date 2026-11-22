import i18n from "i18next";
import { isGlobalPermissionMode, normalizeGlobalPermissionMode } from "@pi-desktop/shared";
import { safeSessionSummary } from "../../lib/remote-session-safety";
import { api } from "../../lib/api";
import { useSessionTargetStore } from "../../features/chat/session-target/session-target-store";
import { remoteTargetErrorText } from "../../features/chat/session-target/remote-target-error-message";
import type { PersistSessionOptions } from "./session-coordination";
import type { SessionRuntime } from "./session-runtime";
import type { StoreAccess } from "../slices/types";

/**
 * Start the draft's remote session for its first send, and tell the user why
 * when it cannot start. A failure resolves to `null`, like a superseded start,
 * so `sendPrompt` keeps its `false` result and the composer restores the draft.
 */
export async function startRemoteTargetSession(
  access: StoreAccess,
  runtime: SessionRuntime,
  persist: (options?: PersistSessionOptions) => Promise<string | null>,
): Promise<string | null> {
  try {
    return await materializeRemoteTargetSession(access, runtime, persist);
  } catch (error) {
    const reason = remoteTargetErrorText((key, options) => i18n.t(key, options), error);
    access.get().showToast(i18n.t("sessionTarget.startFailed", { message: reason }), { variant: "error" });
    return null;
  }
}

export async function materializeRemoteTargetSession(
  { get, set }: StoreAccess,
  runtime: SessionRuntime,
  persist: (options?: PersistSessionOptions) => Promise<string | null>,
) {
  const { environmentId, repository, baseBranch, remoteProject, folderProject, hostModel } = useSessionTargetStore.getState();
  const initial = get();
  const intent = runtime.beginNavigationIntent();

  if (!repository) {
    const { environments } = await api.listEnvironments();
    if (!runtime.navigationIntentIsCurrent(intent)) return null;
    const environment = environments.find((entry) => entry.id === environmentId);
    if (!environment) throw new Error(i18n.t("sessionTarget.environmentUnavailable"));
    if (folderProject?.hostKey === environment.hostKey) {
      const workspace = await get().activateProject(folderProject.path, { navigationIntent: intent });
      if (!runtime.navigationIntentIsCurrent(intent)) return null;
      if (!workspace) throw new Error(i18n.t("errors.workspaceActivationFailed"));
      return persist({ intent, projectPath: folderProject.path, remoteEnvironmentId: environment.id });
    }
    const projectId = remoteProject?.hostKey === environment.hostKey
      ? remoteProject.projectId
      : undefined;
    const requestedMode = initial.draftConfiguration?.mode ?? initial.settings?.defaultMode;
    const mode = requestedMode === "plan" ? "plan" : requestedMode === "goal" ? "goal" : "agent";
    const draftPermissionMode = initial.draftConfiguration?.permissionMode;
    const permissionMode = isGlobalPermissionMode(draftPermissionMode)
      ? draftPermissionMode
      : normalizeGlobalPermissionMode(initial.settings?.defaultPermissionMode, "ask");
    const { session: created, setup } = await api.createRemoteSession({
      hostKey: environment.hostKey,
      environmentId: environment.id,
      projectId,
      mode,
      permissionMode,
      ...(hostModel?.hostKey === environment.hostKey ? { model: hostModel.selection } : {}),
    });
    if (setup?.status === "failed") {
      get().showToast([i18n.t("sessionTarget.preparation.setupFailed"), setup.logTail].filter(Boolean).join("\n"), { variant: "error" });
    }
    const session = safeSessionSummary(created);
    set((state) => ({
      sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
    }));
    if (!runtime.navigationIntentIsCurrent(intent)) return null;
    await get().selectSession(session.id, { navigationIntent: intent });
    return runtime.navigationIntentIsCurrent(intent) && get().activeSessionId === session.id
      ? session.id
      : null;
  }

  if (!baseBranch) throw new Error(i18n.t("sessionTarget.branchRequired"));
  const { projectPath } = await api.resolveRemoteSessionTarget({
    environmentId, repository: { owner: repository.owner, name: repository.name }, defaultBranch: repository.defaultBranch,
  });
  if (!runtime.navigationIntentIsCurrent(intent)) return null;
  if (!await get().activateProject(projectPath, { navigationIntent: intent })) return null;
  if (!runtime.navigationIntentIsCurrent(intent)) return null;
  const existing = initial.sessions.find((item) => item.id === initial.activeSessionId);
  const reuse = existing?.projectPath === projectPath && !existing.remoteRepository
    && !initial.messages.length && !initial.runningSessions[existing.id];
  const sessionId = reuse ? existing.id : await persist({ intent, projectPath, deferRemoteWorkspace: true });
  if (!sessionId || !runtime.navigationIntentIsCurrent(intent)) return null;
  const { remoteRepository } = await api.startRemoteSessionWorkspace({ sessionId, environmentId, repository, baseBranch });
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId && !session.remoteRepository ? { ...session, remoteRepository } : session),
  }));
  return sessionId;
}
