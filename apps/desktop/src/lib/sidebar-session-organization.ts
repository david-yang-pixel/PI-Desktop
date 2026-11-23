import type { SessionSummary } from "@pi-desktop/shared";
import type { AppState } from "../stores/app-state";
import { isRemoteSession } from "./remote-session-safety";
import { isAutomationSession } from "./session-origin";
import { isDefaultSessionTitle } from "./session-title-utils";
import { normalizeProjectPath, sessionArchived, sessionPinned } from "./sidebar-session-groups";
import type { ProjectMeta } from "./sidebar-preferences";

export type ProjectEntry = {
  path: string;
  displayPath?: string;
  cloud: boolean;
  key: string;
  name: string;
  sessions: SessionSummary[];
  open: boolean;
  active: boolean;
  meta: ProjectMeta;
  branch?: string;
};

type SidebarOrganizationState = Pick<
  AppState,
  | "sessions"
  | "sessionMeta"
  | "sessionView"
  | "openProjects"
  | "openProjectPaths"
  | "workspace"
  | "activeProjectPath"
  | "projectMeta"
  | "projectSort"
>;

export function sidebarProjectName(path: string, fallback?: string) {
  if (fallback?.trim()) return fallback.trim();
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function sidebarTaskTitle(title: string | null | undefined, untitled: string) {
  const value = (title || "").trim();
  return isDefaultSessionTitle(value) ? untitled : value;
}

function timestamp(value?: string): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function projectDate(sessions: SessionSummary[], field: "createdAt" | "updatedAt", oldest: boolean) {
  const values = sessions.map((session) => timestamp(session[field]) ?? 0).filter((value) => value > 0);
  if (!values.length) return null;
  return oldest ? Math.min(...values) : Math.max(...values);
}

function compareOptionalDate(a: number | null, b: number | null, descending: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

/** Shared sidebar ordering for display and for choosing a session after archive or delete. */
export function sidebarSessionOrganization({
  sessions,
  sessionMeta,
  sessionView,
  openProjects,
  openProjectPaths,
  workspace,
  activeProjectPath,
  projectMeta,
  projectSort,
}: SidebarOrganizationState, untitled: string) {
  const filtered = sessions.filter(
    (session) => (!isAutomationSession(session) || session.showScheduledRunInSidebar === true) &&
      (sessionView.archived || !sessionArchived(session, sessionMeta[session.id])),
  );
  const compareSessions = (a: SessionSummary, b: SessionSummary) => {
    const aMeta = sessionMeta[a.id];
    const bMeta = sessionMeta[b.id];
    const archiveOrder = Number(sessionArchived(a, aMeta)) - Number(sessionArchived(b, bMeta));
    if (archiveOrder !== 0) return archiveOrder;
    const pinOrder = Number(sessionPinned(b, bMeta)) - Number(sessionPinned(a, aMeta));
    if (pinOrder !== 0) return pinOrder;
    const sort = sessionView.sort;
    if (sort === "name") {
      const byName = sidebarTaskTitle(a.title, untitled).localeCompare(sidebarTaskTitle(b.title, untitled), undefined, {
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
    } else {
      const field = sort === "oldest" || sort === "created" ? "createdAt" : "updatedAt";
      const byDate = compareOptionalDate(timestamp(a[field]), timestamp(b[field]), sort !== "oldest");
      if (byDate !== 0) return byDate;
    }
    return a.id.localeCompare(b.id);
  };

  const activePath = normalizeProjectPath(activeProjectPath ?? workspace?.path);
  const byPath = new Map<string, ProjectEntry>();
  const add = (rawPath: string, name?: string, branch?: string) => {
    const key = normalizeProjectPath(rawPath);
    if (!key) return;
    const existing = byPath.get(key);
    if (existing) {
      if (name && existing.name === sidebarProjectName(existing.path)) existing.name = name;
      if (branch && !existing.branch) existing.branch = branch;
      return;
    }
    const meta = projectMeta[key] ?? projectMeta[rawPath] ?? {};
    const remote = openProjects.find((project) => normalizeProjectPath(project.path) === key)?.remote
      ?? (normalizeProjectPath(workspace?.path) === key ? workspace?.remote : undefined);
    byPath.set(key, {
      path: rawPath,
      displayPath: remote?.path,
      cloud: Boolean(remote) || rawPath.startsWith("remote-project:"),
      key,
      name: sidebarProjectName(rawPath, meta.name ?? name),
      sessions: [],
      open: true,
      active: key === activePath,
      meta,
      branch,
    });
  };
  for (const rawPath of openProjectPaths) {
    const path = normalizeProjectPath(rawPath);
    if (!path) continue;
    const record = openProjects.find((project) => normalizeProjectPath(project.path) === path);
    add(path, record?.name, record?.branch);
  }
  if (workspace?.path) add(workspace.path, workspace.name, workspace.branch);

  const temporarySessions: SessionSummary[] = [];
  for (const session of filtered) {
    const path = normalizeProjectPath(session.projectPath);
    if (path) {
      // Only retained projects get sidebar groups, even when a closed project has history.
      byPath.get(path)?.sessions.push(session);
    } else if (!(isRemoteSession(session) && session.remoteProjectId)) {
      temporarySessions.push(session);
    }
  }
  temporarySessions.sort(compareSessions);

  const projectEntries = [...byPath.values()].filter((entry) => sessionView.archived || !entry.meta.archived);
  for (const entry of projectEntries) entry.sessions.sort(compareSessions);
  projectEntries.sort((a, b) => {
    if (a.cloud !== b.cloud) return Number(a.cloud) - Number(b.cloud);
    const archiveOrder = Number(!!a.meta.archived) - Number(!!b.meta.archived);
    if (archiveOrder !== 0) return archiveOrder;
    const pinOrder = Number(!!b.meta.pinned) - Number(!!a.meta.pinned);
    if (pinOrder !== 0) return pinOrder;
    if (projectSort === "manual") {
      const byOrder = (a.meta.order ?? Number.MAX_SAFE_INTEGER) - (b.meta.order ?? Number.MAX_SAFE_INTEGER);
      if (byOrder !== 0) return byOrder;
    } else if (projectSort === "name") {
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (byName !== 0) return byName;
    } else {
      const oldest = projectSort === "oldest";
      const field = oldest || projectSort === "created" ? "createdAt" : "updatedAt";
      const byDate = compareOptionalDate(projectDate(a.sessions, field, oldest), projectDate(b.sessions, field, oldest), !oldest);
      if (byDate !== 0) return byDate;
    }
    return a.key.localeCompare(b.key);
  });
  return { filtered, compareSessions, projectEntries, temporarySessions };
}

export function nextSidebarSession(
  state: SidebarOrganizationState,
  session: SessionSummary,
  untitled: string,
  allowOtherProjects: boolean,
) {
  const { projectEntries, temporarySessions } = sidebarSessionOrganization(state, untitled);
  const sameScope = session.projectPath
    ? projectEntries.find((entry) => entry.key === normalizeProjectPath(session.projectPath))?.sessions
    : temporarySessions;
  const eligible = (item: SessionSummary) => item.id !== session.id && !sessionArchived(item, state.sessionMeta[item.id]);
  return sameScope?.find(eligible) ?? (allowOtherProjects ? projectEntries.flatMap((entry) => entry.sessions).find(eligible) : undefined);
}
