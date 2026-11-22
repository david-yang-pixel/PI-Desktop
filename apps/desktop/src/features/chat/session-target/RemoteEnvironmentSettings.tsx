import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LeftoverWorktree, RemoteEnvironment, RemoteHostSummary } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../settings/primitives";
import { WorktreeDialogFrame } from "../../worktree/WorktreeDialogFrame";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { remoteTargetErrorText } from "./remote-target-error-message";
import { useEnvironments } from "./use-environments";

function LeftoverWorktrees({ host, hostRevision }: { host: RemoteHostSummary; hostRevision: number }) {
  const { t } = useTranslation();
  const { connected, hostKey } = host;
  const [worktrees, setWorktrees] = useState<LeftoverWorktree[]>();
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const [selectedSession, setSelectedSession] = useState<string>();
  const removalInFlight = useRef(false);
  const close = useCallback(() => setSelectedSession(undefined), []);
  const toast = useAppStore((state) => state.showToast);

  useEffect(() => {
    if (!connected) {
      setWorktrees(undefined);
      setLoading(false);
      close();
      return;
    }
    if (removing) return;

    let current = true;
    close();
    setLoading(true);
    void api.listRemoteLeftoverWorktrees(hostKey).then(({ worktrees }) => {
      if (current) setWorktrees(worktrees);
    }).catch((error: unknown) => {
      if (current) {
        setWorktrees(undefined);
        toast(error instanceof Error ? error.message : String(error), { variant: "error" });
      }
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [close, connected, hostKey, hostRevision, refreshCount, removing, toast]);

  const busy = loading || removing;
  const selected = worktrees?.find((tree) => tree.sessionId === selectedSession);
  const title = (tree: LeftoverWorktree) => `${tree.repository.owner}/${tree.repository.name} · ${tree.workBranch}`;
  const risk = (tree: LeftoverWorktree) => t("sessionTarget.deleteAtRisk", {
    files: tree.uncommittedFiles, commits: tree.unpushedCommits,
  });

  async function remove(sessionId: string) {
    if (!connected || busy || removalInFlight.current) return;
    removalInFlight.current = true;
    setRemoving(true);
    try {
      const { ok } = await api.removeRemoteLeftoverWorktree(hostKey, sessionId);
      if (ok) setWorktrees((current) => current?.filter((tree) => tree.sessionId !== sessionId));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      close();
      removalInFlight.current = false;
      setRemoving(false);
    }
  }

  return <div className="session-target-fields" aria-busy={busy}>
    <SettingsRow title={host.label} detail={connected ? undefined : t("sessionTarget.offline")}>
      <Button variant="secondary" disabled={busy || !connected} onClick={() => setRefreshCount((count) => count + 1)}>
        {t("sessionTarget.refresh")}
      </Button>
    </SettingsRow>
    {connected && worktrees?.length === 0 && <p>{t("sessionTarget.noLeftovers")}</p>}
    {connected && worktrees?.map((tree) => <SettingsRow key={tree.sessionId} title={title(tree)} detail={risk(tree)}>
      <Button variant="secondary" aria-haspopup="dialog" disabled={busy} onClick={() => setSelectedSession(tree.sessionId)}>
        {t("sessionTarget.remove")}
      </Button>
    </SettingsRow>)}
    {connected && selected && <WorktreeDialogFrame id="remote-leftover-worktree" title={t("sessionTarget.remove")}
      subtitle={title(selected)} busy={removing} onClose={close} actions={<>
        <Button variant="secondary" disabled={removing} onClick={close}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void remove(selected.sessionId)}>{t("sessionTarget.remove")}</Button>
      </>}>
      <p>{risk(selected)}</p>
    </WorktreeDialogFrame>}
  </div>;
}

export function RemoteEnvironmentSettings() {
  const { t } = useTranslation();
  const { hosts, hostRevision, environments, error } = useEnvironments();
  const [editor, setEditor] = useState<RemoteEnvironment | "new" | null>(null);
  const [removal, setRemoval] = useState<RemoteEnvironment | null>(null);
  const [removing, setRemoving] = useState(false);
  const close = useCallback(() => setEditor(null), []);
  const closeRemoval = useCallback(() => setRemoval(null), []);
  const toast = useAppStore((state) => state.showToast);
  if (!hosts.length && !error) return null;

  async function remove(environment: RemoteEnvironment) {
    setRemoving(true);
    try {
      await api.removeEnvironment(environment.id);
      setRemoval(null);
    } catch (cause) {
      toast(t("sessionTarget.environmentRemoval.failed", { message: remoteTargetErrorText(t, cause) }), { variant: "error" });
    } finally {
      setRemoving(false);
    }
  }

  return <>
    <SettingsCard title={t("sessionTarget.environments")}>
      {error && <p role="alert">{t("sessionTarget.loadFailed", { message: error })}</p>}
      {environments.map((environment) => <SettingsRow key={environment.id} title={environment.name}
        detail={hosts.find((host) => host.hostKey === environment.hostKey)?.label}>
        <div className="session-target-row">
          <Button variant="secondary" onClick={() => setEditor(environment)}>{t("sessionTarget.editEnvironment")}</Button>
          {!environment.isDefault && <Button variant="secondary" aria-haspopup="dialog"
            onClick={() => setRemoval(environment)}>{t("sessionTarget.remove")}</Button>}
        </div>
      </SettingsRow>)}
      <Button variant="secondary" disabled={!hosts.length} onClick={() => setEditor("new")}>{t("sessionTarget.newEnvironment")}</Button>
    </SettingsCard>
    {hosts.length > 0 && <SettingsCard title={t("sessionTarget.leftoverWorktrees")}>
      {hosts.map((host) => <LeftoverWorktrees key={host.hostKey} host={host} hostRevision={hostRevision} />)}
    </SettingsCard>}
    {editor && <EnvironmentEditor hosts={hosts} environment={editor === "new" ? undefined : editor} onSaved={close} onClose={close} />}
    {removal && <WorktreeDialogFrame id="remote-environment-remove" title={t("sessionTarget.environmentRemoval.title")}
      subtitle={removal.name} busy={removing} onClose={closeRemoval} actions={<>
        <Button variant="secondary" disabled={removing} onClick={closeRemoval}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={removing} onClick={() => void remove(removal)}>{t("sessionTarget.remove")}</Button>
      </>}>
      <p>{t("sessionTarget.environmentRemoval.detail")}</p>
    </WorktreeDialogFrame>}
  </>;
}
