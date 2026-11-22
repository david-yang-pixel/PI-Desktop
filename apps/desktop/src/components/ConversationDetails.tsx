import { lazy, Suspense, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCompactTokenCount, type SessionSummary, type UiMessage } from "@pi-desktop/shared";
import { useEnvironments } from "../features/chat/session-target/use-environments";
import { composerContextUsage } from "../lib/context-usage";
import { latestTurnContextInspector } from "../lib/latest-turn-context";
import { ModalLayer } from "../lib/portal-visibility";
import { isRemoteSession } from "../lib/remote-session-safety";
import { requestReviewFocus } from "../lib/review-focus-request";
import { normalizeProjectPath } from "../lib/sidebar-session-groups";
import { useModalDialog } from "../lib/use-modal-dialog";
import { toolWorkPanelTab } from "../lib/work-panel-tabs";
import { reviewChangesFromMessages } from "../lib/workspace-review";
import { useAppStore } from "../stores/app-store";
import { IconClose, IconListChecks } from "./icons";
import { Button, OverlayBackdrop, portalOverlay, TooltipButton } from "./ui";

const ReviewChangeCard = lazy(async () => ({
  default: (await import("./ReviewChangeCard")).ReviewChangeCard,
}));

function conversationToolCounts(messages: UiMessage[]) {
  const tools = new Map<string, number>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "tool" || message.parentToolCallId) continue;
    const name = message.toolName ?? "";
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return [...tools];
}

export function ConversationDetails({ session, cloud }: { session: SessionSummary; cloud: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <TooltipButton
        type="button"
        className="ct-icon-btn"
        data-nav="conversation-details"
        tooltip={t("conversationDetails.title")}
        ariaLabel={t("conversationDetails.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <IconListChecks size={15} aria-hidden />
      </TooltipButton>
      {open && <ConversationDetailsSheet session={session} cloud={cloud} onClose={() => setOpen(false)} />}
    </>
  );
}

function ConversationDetailsSheet({ session, cloud, onClose }: {
  session: SessionSummary;
  cloud: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, { onClose });
  const messages = useAppStore((state) => state.messages);
  const providers = useAppStore((state) => state.providers);
  const models = useAppStore((state) => state.providerModels);
  const compactions = useAppStore((state) => state.sessionCompactions[session.id]);
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTabForSession);
  const projectPath = session.projectPath && normalizeProjectPath(session.projectPath);
  const workspace = useAppStore((state) => {
    if (!projectPath || cloud) return undefined;
    if (normalizeProjectPath(state.workspace?.path ?? "") === projectPath) return state.workspace;
    return state.openProjects.find((project) => normalizeProjectPath(project.path) === projectPath);
  });
  const projectName = useAppStore((state) => projectPath ? state.projectMeta[projectPath]?.name : undefined);
  const tools = useMemo(() => conversationToolCounts(messages), [messages]);
  const changes = useMemo(() => reviewChangesFromMessages(messages).reverse(), [messages]);
  const latestUsage = useMemo(
    () => latestTurnContextInspector(messages, models, providers, compactions, session),
    [messages, models, providers, compactions, session],
  );
  const usage = latestUsage && composerContextUsage(latestUsage);
  const repository = session.remoteRepository;
  const pullRequest = repository?.pullRequest;
  const githubPullRequest = pullRequest?.url.startsWith("https://github.com/") ? pullRequest : undefined;
  const host = repository?.hostLabel ?? session.remoteHostLabel ?? repository?.hostKey ??
    session.remoteHostKey ?? session.remoteWorkspace?.hostKey;
  const branch = repository?.workBranch ?? repository?.baseBranch ?? session.worktree?.branch ?? workspace?.branch;
  const workspaceLabel = session.remoteWorkspaceLabel ?? session.remoteWorkspace?.path ??
    projectName ?? workspace?.name ?? (cloud ? undefined : session.projectPath);
  const location = cloud ? host ?? t("sessionTarget.environmentHost") : t("sessionTarget.thisComputer");
  const canOpenReview = changes.length > 0 && !isRemoteSession(session);

  const openReview = () => {
    requestReviewFocus(changes.map(({ change }) => change.snapshotId), { expand: false, sessionId: session.id });
    openWorkPanelTab(session.id, toolWorkPanelTab("review"));
    onClose();
  };

  return portalOverlay(
    <ModalLayer>
      <OverlayBackdrop className="overlay conversation-details-overlay" onClick={onClose}>
        <div
          ref={dialogRef}
          className="dialog conversation-details"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header className="conversation-details-header">
            <h2 id={titleId}>{t("conversationDetails.title")}</h2>
            <TooltipButton
              type="button"
              className="icon-btn"
              tooltip={t("settings.close")}
              ariaLabel={t("settings.close")}
              onClick={onClose}
            >
              <IconClose size={15} aria-hidden />
            </TooltipButton>
          </header>
          <div className="conversation-details-body">
            <section>
              <h3>{t("conversationDetails.environment")}</h3>
              <dl>
                <div><dt>{t("conversationDetails.location")}</dt><dd>{location}</dd></div>
                {repository?.environmentId && (
                  <ConversationEnvironment environmentId={repository.environmentId} hostKey={repository.hostKey} />
                )}
                {workspaceLabel && (
                  <div><dt>{t("conversationDetails.workspace")}</dt><dd>{workspaceLabel}</dd></div>
                )}
                {repository && (
                  <div>
                    <dt>{t("conversationDetails.repository")}</dt>
                    <dd>{repository.repository.owner}/{repository.repository.name}</dd>
                  </div>
                )}
                {branch && <div><dt>{t("conversationDetails.branch")}</dt><dd>{branch}</dd></div>}
              </dl>
            </section>
            <section>
              <h3>{t("chat.usageContextLabel")}</h3>
              {usage && latestUsage ? (
                <>
                  <meter min={0} max={100} value={usage.usedPercent} aria-label={t("chat.usageContextLabel")} />
                  <p>{t("chat.usageContextTokens", {
                    used: formatCompactTokenCount(usage.usedTokens),
                    window: `${latestUsage.contextWindowEstimated ? "≈" : ""}${formatCompactTokenCount(latestUsage.contextWindow)}`,
                  })}</p>
                </>
              ) : <p>{t("conversationDetails.noUsage")}</p>}
            </section>
            <section>
              <h3>{t("conversationDetails.tools")}</h3>
              {tools.length ? (
                <dl>
                  {tools.map(([name, count]) => (
                    <div key={name}><dt>{name || t("conversationDetails.unknownTool")}</dt><dd>{count.toLocaleString()}</dd></div>
                  ))}
                </dl>
              ) : <p>{t("conversationDetails.noTools")}</p>}
            </section>
            <section className="conversation-details-changes">
              <div className="conversation-details-section-header">
                <h3>{t("conversationDetails.changes")}</h3>
                {canOpenReview && (
                  <Button type="button" variant="ghost" size="sm" onClick={openReview}>
                    {t("conversationDetails.openInReview")}
                  </Button>
                )}
              </div>
              {githubPullRequest && (
                <a className="conversation-details-pr" href={githubPullRequest.url} target="_blank" rel="noopener noreferrer">
                  {t("sessionTarget.openPullRequest", { number: githubPullRequest.number })}
                </a>
              )}
              <Suspense fallback={<p role="status">{t("panel.review.loadingHistory")}</p>}>
                {changes.map(({ change, message }) => (
                  <ReviewChangeCard key={change.snapshotId} message={message} compact readOnly />
                ))}
              </Suspense>
              {!githubPullRequest && changes.length === 0 && <p>{t("panel.review.noChanges")}</p>}
            </section>
          </div>
        </div>
      </OverlayBackdrop>
    </ModalLayer>,
  );
}

function ConversationEnvironment({ environmentId, hostKey }: { environmentId: string; hostKey: string }) {
  const { t } = useTranslation();
  const { environments } = useEnvironments();
  const environment = environments.find((item) => item.id === environmentId && item.hostKey === hostKey);
  return (
    <div>
      <dt>{t(environment ? "sessionTarget.environments" : "conversationDetails.environmentId")}</dt>
      <dd>{environment?.name ?? environmentId}</dd>
    </div>
  );
}
