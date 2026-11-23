import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionRemoteRepository } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { remoteTargetErrorText, remoteTargetErrorTextForCode } from "./remote-target-error-message";
import { useSessionDeletions } from "./session-deletions";

type StatusProps = { sessionId: string; workspace: SessionRemoteRepository };

export function WorkspacePreparationStatus(props: StatusProps) {
  const { t } = useTranslation();
  // Stopping the Host job and removing the worktree can take a while.
  const deleting = useSessionDeletions((state) => state.ids[props.sessionId] === true);
  if (deleting) {
    return <div className="composer-status" role="status" aria-busy="true">{t("sessionTarget.deletion.deletingSession")}</div>;
  }
  return <>
    <PushStatus key={props.sessionId} sessionId={props.sessionId} />
    <PreparationStatus {...props} />
  </>;
}

function PushStatus({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<{ percent?: number } | null>(null);
  useEffect(() => api.onRemoteSessionPushProgress((event) => {
    if (event.sessionId === sessionId) setProgress(event.active ? event.progress ?? {} : null);
  }), [sessionId]);
  if (!progress) return null;
  return <div className="composer-status" role="status">
    {t("sessionTarget.pushing")}{progress.percent !== undefined && ` ${progress.percent}%`}
  </div>;
}

function PreparationStatus({ sessionId, workspace }: StatusProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = useAppStore((state) => state.deleteSession);
  const toast = useAppStore((state) => state.showToast);
  useEffect(() => {
    setDismissed(false);
  }, [sessionId, workspace.state, workspace.setup?.status]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); }
    catch (cause) { toast(remoteTargetErrorText(t, cause), { variant: "error" }); }
    finally { setBusy(false); }
  }
  if (workspace.state === "preparing") {
    const phase = workspace.phase ?? "queued";
    const detail = workspace.progress?.detail;
    const percent = workspace.progress?.percent !== undefined ? `${workspace.progress.percent}%` : undefined;
    const progressSuffix = detail && percent
      ? ` — ${detail} ${percent}`
      : detail
        ? ` — ${detail}`
        : percent
          ? ` ${percent}`
          : "";
    return <div className="composer-status" role="status">
      {t(`sessionTarget.preparation.${phase}`, { repository: `${workspace.repository.owner}/${workspace.repository.name}`, branch: workspace.workBranch ?? workspace.baseBranch })}
      {progressSuffix}{" "}
      <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.cancelRemoteSessionWorkspace(sessionId))}>
        {t("sessionTarget.preparationControl.cancel")}
      </Button>
      {phase === "runningSetup" && workspace.setup?.logTail && (
        <details open><summary>{t("sessionTarget.preparation.showLog")}</summary><pre>{workspace.setup.logTail}</pre></details>
      )}
    </div>;
  }
  if (workspace.state === "reclaiming") return <div className="composer-status" role="status">
    {t("sessionTarget.preparation.reclaiming")}
  </div>;
  if (workspace.state === "reclaimed") return <div className="composer-status" role="status">
    <strong>{t("sessionTarget.preparation.reclaimed")}</strong>{" "}
    {t("sessionTarget.preparation.restoreHint")}
  </div>;
  const setupLog = workspace.setup?.logTail && <details>
    <summary>{t("sessionTarget.preparation.showLog")}</summary>
    <pre className="worktree-setup-log">{workspace.setup.logTail}</pre>
  </details>;
  if (workspace.state === "failed") return <div className="composer-status" role="alert">
    {t("sessionTarget.preparation.failed", {
      message: workspace.error && remoteTargetErrorTextForCode(t, workspace.error.code, workspace.error.message),
    })}
    {setupLog}
    <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.retryRemoteSessionWorkspace(sessionId))}>{t("sessionTarget.preparation.retry")}</Button>
    <Button variant="secondary" disabled={busy} onClick={() => void run(() => remove(sessionId))}>{t("sessionTarget.preparation.deleteSession")}</Button>
  </div>;
  if (workspace.state !== "ready" || workspace.setup?.status !== "failed" || dismissed) return null;
  return <div className="composer-status">
    {t("sessionTarget.preparation.setupFailed")}
    {setupLog}
    <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.retryRemoteSessionWorkspace(sessionId))}>{t("sessionTarget.preparation.retry")}</Button>
    <Button variant="secondary" disabled={busy} onClick={() => setDismissed(true)}>{t("sessionTarget.dismiss")}</Button>
  </div>;
}
