import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitHubChecksState, RemoteSessionGitHubActivity, SessionRemoteRepository } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { githubErrorText, githubErrorTextForCode } from "../../settings/connectors/github-error-message";
import { githubCompareUrl } from "./github-links";
import "./session-target.css";

/** How often pending checks are read again while the details stay open. */
export const PENDING_CHECKS_REFRESH_MS = 30_000;

type Loaded = { activity: RemoteSessionGitHubActivity } | { error: unknown };

/**
 * Conversation details rows for a repository session's work branch on
 * GitHub: a compare link once the branch is pushed and, with a pull request,
 * the CI state of its head commit.
 */
export function SessionGitHubActivity({ sessionId, workspace }: { sessionId: string; workspace: SessionRemoteRepository }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>();
  const [revision, setRevision] = useState(0);
  const { workBranch } = workspace;
  const pullRequest = workspace.pullRequest?.number;
  // A finished push is the moment the branch or its checks change.
  useEffect(() => api.onRemoteSessionPushProgress((event) => {
    if (event.sessionId === sessionId && !event.active) setRevision((value) => value + 1);
  }), [sessionId]);
  useEffect(() => {
    if (!workBranch) return;
    let current = true;
    api.getRemoteSessionGithubActivity(sessionId).then(
      (activity) => { if (current) setLoaded({ activity }); },
      (error: unknown) => { if (current) setLoaded({ error }); },
    );
    return () => { current = false; };
  }, [sessionId, workBranch, pullRequest, revision]);
  const pending = loaded && "activity" in loaded && loaded.activity.checks?.state === "pending";
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setRevision((value) => value + 1), PENDING_CHECKS_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [pending, revision]);

  if (!workBranch || !loaded) return null;
  const label = <dt>{t("sessionTarget.githubActivity.label")}</dt>;
  if ("error" in loaded) {
    // Not signed in to GitHub: there is nothing to check, and nothing is wrong.
    if ((loaded.error as { code?: unknown } | null)?.code === "GITHUB_NOT_CONNECTED") return null;
    return <div>{label}<dd role="status">
      {t("sessionTarget.githubActivity.unavailable", { message: githubErrorText(t, loaded.error) })}
    </dd></div>;
  }
  const { activity } = loaded;
  const compare = githubCompareUrl(workspace.repository, workspace.baseBranch, workBranch);
  if (!activity.pushed || !compare) return null;
  return <div className="conversation-details-github">
    {label}
    <dd>
      <a href={compare} target="_blank" rel="noopener noreferrer">{t("sessionTarget.githubActivity.viewChanges")}</a>
      {activity.checks && <ChecksState state={activity.checks.state} />}
      {activity.checksError && <span data-checks-state="unavailable"
        title={githubErrorTextForCode(t, activity.checksError.code, activity.checksError.message)}>
        {t("sessionTarget.githubActivity.checksUnavailable")}
      </span>}
    </dd>
  </div>;
}

function ChecksState({ state }: { state: GitHubChecksState }) {
  const { t } = useTranslation();
  const text = state === "passing" ? t("sessionTarget.githubActivity.checksPassing")
    : state === "failing" ? t("sessionTarget.githubActivity.checksFailing")
      : state === "pending" ? t("sessionTarget.githubActivity.checksPending")
        : t("sessionTarget.githubActivity.checksNone");
  return <span data-checks-state={state}>{text}</span>;
}
