import { useTranslation } from "react-i18next";
import type { SessionRemoteRepository, SessionSummary } from "@pi-desktop/shared";
import { Badge } from "../../../components/ui";
import { remoteTargetErrorTextForCode } from "./remote-target-error-message";
import { useSessionDeletions } from "./session-deletions";
import "./session-target.css";

export type RemoteSessionBadgeStatus = "deleting" | "preparing" | "failed";

/**
 * What a sidebar row says about its session's workspace. A deletion in flight
 * comes first. A ready or reclaimed workspace needs no mark; only one the user
 * is waiting on or has to act on does.
 */
export function remoteSessionBadgeStatus(workspace?: SessionRemoteRepository, deleting = false): RemoteSessionBadgeStatus | null {
  if (deleting) return "deleting";
  if (workspace?.state === "preparing") return "preparing";
  if (workspace?.state === "failed") return "failed";
  return null;
}

/** The workspace mark beside a session title in the sidebar. */
export function RemoteSessionBadge({ session }: { session: Pick<SessionSummary, "id" | "remoteRepository"> }) {
  const { t } = useTranslation();
  const deleting = useSessionDeletions((state) => state.ids[session.id] === true);
  const workspace = session.remoteRepository;
  const status = remoteSessionBadgeStatus(workspace, deleting);
  if (!status) return null;
  const reason = status === "failed" && workspace?.error
    ? t("sessionTarget.preparation.failed", {
      message: remoteTargetErrorTextForCode(t, workspace.error.code, workspace.error.message),
    })
    : undefined;
  return (
    <span className="remote-session-badge" data-remote-session-status={status} title={reason}>
      {status !== "failed" && <span className="remote-session-badge-spinner" aria-hidden="true" />}
      <Badge tone={status === "failed" ? "error" : "neutral"}>
        {status === "failed" ? t("sessionTarget.sessionBadge.failed")
          : status === "deleting" ? t("sessionTarget.deletion.deleting") : t("sessionTarget.sessionBadge.preparing")}
      </Badge>
    </span>
  );
}
