import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { formatSessionLink, type SessionSummary } from "@pi-desktop/shared";
import {
  useWorktreeDeleteLossText,
  useWorktreeSessionMenuItems,
} from "../features/worktree/WorktreeSidebarParts";
import { useArmedDelete } from "../hooks/use-armed-delete";
import { api } from "../lib/api";
import { isRemoteSession, sessionAllows } from "../lib/remote-session-safety";
import { sidebarMenuAction, sidebarMenuSubmenu, type SidebarMenuPanelContent } from "../lib/sidebar-menu";
import { sessionArchived, sessionPinned } from "../lib/sidebar-session-groups";
import { nextSidebarSession, sidebarTaskTitle } from "../lib/sidebar-session-organization";
import { useAppStore } from "../stores/app-store";
import { IconArchive, IconArchiveRestore, IconBranch, IconCopy, IconFolder, IconPencil, IconPin, IconTrash, IconX } from "./icons";

export function focusSessionComposer() {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
}

export function useSessionMenuContent(session: SessionSummary | undefined, {
  onClose,
  onRename,
  onPin,
}: {
  onClose: (restoreFocus?: boolean) => void;
  onRename?: (session: SessionSummary) => void;
  onPin?: (sessionId: string) => void;
}): SidebarMenuPanelContent | null {
  const { t } = useTranslation();
  const meta = useAppStore((state) => session ? state.sessionMeta[session.id] : undefined);
  const running = useAppStore((state) => Boolean(session && state.runningSessions[session.id]));
  const developerMode = useAppStore((state) => state.settings?.developerMode === true);
  const { armed, setArmed } = useArmedDelete();
  const sessionId = session?.id;
  const deleteArmed = !!sessionId && armed === sessionId;
  const remote = isRemoteSession(session);
  const untitled = t("chat.untitledTask");

  useEffect(() => setArmed(null), [sessionId, setArmed]);
  const worktreeItems = useWorktreeSessionMenuItems({
    sessionId: sessionId ?? "",
    title: sidebarTaskTitle(session?.title, untitled),
    worktree: remote ? undefined : session?.worktree,
    running,
    onDone: () => onClose(false),
  });
  const deleteLoss = useWorktreeDeleteLossText(deleteArmed && !remote ? sessionId : "");
  if (!session) return null;

  const archived = sessionArchived(session, meta);
  const pinned = sessionPinned(session, meta);
  const native = session.source === "pi-native";

  const reportError = (error: unknown) => {
    useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  };

  const toggleArchive = async () => {
    onClose();
    const state = useAppStore.getState();
    if (archived) {
      state.restoreSession(session.id);
      return;
    }
    const active = state.activeSessionId === session.id &&
      (!state.selectingSessionId || state.selectingSessionId === session.id);
    try {
      if (active) {
        const next = nextSidebarSession(state, session, untitled, false);
        if (next) {
          await state.selectSession(next.id);
          if (useAppStore.getState().activeSessionId === session.id) return;
          if (useAppStore.getState().activeSessionId === next.id) focusSessionComposer();
          state.archiveSession(session.id);
          return;
        }
        // An archived empty draft cannot be reused as its own replacement.
        state.archiveSession(session.id);
        try {
          await state.newSession({ projectPath: session.projectPath ?? null });
        } catch (error) {
          state.restoreSession(session.id);
          throw error;
        }
        return;
      }
      state.archiveSession(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  const deleteSession = async () => {
    onClose();
    const state = useAppStore.getState();
    if (state.runningSessions[session.id]) {
      state.showToast(t("nav.deleteRunningSessionBlocked"), { variant: "warning" });
      return;
    }
    const active = state.activeSessionId === session.id;
    try {
      await state.deleteSession(session.id);
      const current = useAppStore.getState();
      // The store may return after a cancelled preflight or a running-session rejection.
      // Leave any navigation made during deletion in charge of the visible conversation.
      if (!active || current.page !== state.page || current.activeSessionId || current.selectingSessionId ||
          current.sessions.some((item) => item.id === session.id)) return;
      const next = nextSidebarSession(current, session, untitled, true);
      if (next) {
        await current.selectSession(next.id);
        if (useAppStore.getState().activeSessionId === next.id) focusSessionComposer();
      } else {
        await current.newSession({ projectPath: session.projectPath ?? null });
      }
    } catch (error) {
      reportError(error);
    }
  };

  const requestDelete = () => {
    if (!deleteArmed) {
      setArmed(session.id);
      return;
    }
    setArmed(null);
    void deleteSession();
  };

  const forkSession = async () => {
    const state = useAppStore.getState();
    if (!sessionAllows(session, "canEditMessages") || state.runningSessions[session.id]) return;
    onClose(false);
    try {
      await state.forkSession(session.id);
      focusSessionComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const copyText = async (read: () => string | Promise<string>) => {
    onClose();
    try {
      const value = read();
      await navigator.clipboard.writeText(typeof value === "string" ? value : await value);
      useAppStore.getState().showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
  };

  const openSessionPath = async () => {
    if (isRemoteSession(session) || useAppStore.getState().settings?.developerMode !== true) return;
    onClose();
    try {
      await api.openSessionScratchPath(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  const gitItems = [
    ...(native || !sessionAllows(session, "canEditMessages") ? [] : [sidebarMenuAction({
      id: "fork-session",
      label: t("nav.createBranch"),
      icon: <IconBranch size={14} />,
      title: t("nav.createBranch"),
      disabled: running,
      onSelect: () => void forkSession(),
    })]),
    ...worktreeItems,
  ];

  return {
    label: t("nav.sessionActions", { defaultValue: "Session actions" }),
    items: [
      ...(!native && onRename ? [sidebarMenuAction({
        id: "rename-session",
        label: t("nav.renameTask", { defaultValue: "Rename task" }),
        icon: <IconPencil size={14} />,
        onSelect: () => {
          onClose(false);
          onRename(session);
        },
      })] : []),
      sidebarMenuAction({
        id: "toggle-session-pin",
        label: pinned ? t("nav.unpinTask", { defaultValue: "Unpin" }) : t("nav.pinTask", { defaultValue: "Pin" }),
        icon: <IconPin size={14} />,
        onSelect: () => {
          useAppStore.getState().toggleSessionPinned(session.id);
          onClose(!onPin);
          onPin?.(session.id);
        },
      }),
      sidebarMenuAction({
        id: "toggle-session-archive",
        label: archived ? t("nav.restoreTask", { defaultValue: "Restore" }) : t("nav.archiveTask", { defaultValue: "Archive" }),
        icon: archived ? <IconArchiveRestore size={14} /> : <IconArchive size={14} />,
        onSelect: () => void toggleArchive(),
      }),
      ...(gitItems.length ? [sidebarMenuSubmenu({
        id: "session-git",
        label: t("worktree.menu.group", { defaultValue: "Git" }),
        icon: <IconBranch size={14} />,
        items: gitItems,
      })] : []),
      sidebarMenuSubmenu({
        id: "session-copy",
        label: t("chat.copy", { defaultValue: "Copy" }),
        icon: <IconCopy size={14} />,
        items: [
          sidebarMenuAction({
            id: "copy-conversation-id",
            label: t("nav.copyConversationId"),
            icon: <IconCopy size={14} />,
            onSelect: () => void copyText(() => session.id),
          }),
          ...(!remote ? [sidebarMenuAction({
            id: "copy-session-path",
            label: t("nav.copySessionPath"),
            icon: <IconFolder size={14} />,
            onSelect: () => void copyText(() => api.getSessionScratchPath(session.id).then(({ path }) => path)),
          })] : []),
          sidebarMenuAction({
            id: "copy-session-link",
            label: t("nav.copySessionLink"),
            icon: <IconCopy size={14} />,
            onSelect: () => void copyText(() => formatSessionLink(session.id)),
          }),
        ],
      }),
      ...(developerMode && !remote ? [sidebarMenuAction({
        id: "open-session-path",
        label: t("nav.openSessionPath"),
        icon: <IconFolder size={14} />,
        onSelect: () => void openSessionPath(),
      })] : []),
      ...(!native ? [sidebarMenuSubmenu({
        id: "session-danger",
        label: t("nav.dangerZone", { defaultValue: "Danger zone" }),
        icon: <IconTrash size={14} />,
        items: [sidebarMenuAction({
          id: "delete-session",
          label: deleteArmed ? t("nav.deleteTaskConfirm", { defaultValue: "Delete?" }) : t("nav.deleteTask", { defaultValue: "Delete" }),
          icon: <IconX size={14} />,
          danger: true,
          armed: deleteArmed,
          onSelect: requestDelete,
        })],
        notes: deleteLoss ? [{ id: "session-delete-loss", text: deleteLoss }] : undefined,
      })] : []),
    ],
  };
}
