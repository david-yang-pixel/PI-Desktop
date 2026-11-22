import type { RacpHostModelSelection, RemoteSessionTarget } from "@pi-desktop/shared";
import type { RemoteProjectTarget } from "../../../lib/remote-project-session";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type Repository = RemoteSessionTarget["repository"] & { defaultBranch: string };
export type DraftSessionTarget = {
  environmentId: string;
  repository?: Repository;
  baseBranch?: string;
  defaultEnvironmentId?: string;
  remoteProject?: RemoteProjectTarget;
  folderProject?: { path: string; hostKey: string };
};
export function isHostSessionTarget(target: DraftSessionTarget): boolean {
  return target.environmentId !== "local" && !target.repository && !target.folderProject;
}

type TargetStore = DraftSessionTarget & {
  hostModel?: { hostKey: string; selection: RacpHostModelSelection };
  setHostModel(environmentId: string, hostKey: string, selection?: RacpHostModelSelection): void;
  setEnvironment(id: string, hostKey?: string): void;
  setRepository(repository?: Repository): void;
  setBaseBranch(branch: string): void;
  /**
   * Start a new draft. With a target (a project's defaults), the draft uses
   * it. Without one (the primary New task), the draft keeps the remembered
   * environment, repository, and branch and drops only what belonged to the
   * previous draft: a Host project or folder and a Host model choice.
   */
  beginDraft(target?: DraftSessionTarget): void;
};

export const useSessionTargetStore = create<TargetStore>()(persist((set) => ({
  environmentId: "local",
  setEnvironment: (environmentId, hostKey) => set((current) => ({
    environmentId,
    ...(environmentId === current.environmentId ? {} : { hostModel: undefined }),
    ...(hostKey ? {
      defaultEnvironmentId: `default:${hostKey}`,
      folderProject: current.folderProject?.hostKey === hostKey ? current.folderProject : undefined,
      remoteProject: current.remoteProject?.hostKey === hostKey ? current.remoteProject : undefined,
    } : {}),
  })),
  setRepository: (repository) => set({ repository, baseBranch: repository?.defaultBranch, hostModel: undefined }),
  setHostModel: (environmentId, hostKey, selection) => set((current) => (
    current.environmentId === environmentId && isHostSessionTarget(current)
      ? { hostModel: selection ? { hostKey, selection } : undefined }
      : current
  )),
  setBaseBranch: (baseBranch) => set({ baseBranch }),
  beginDraft: (target) => set(target ? {
    environmentId: target.environmentId,
    repository: target.repository,
    baseBranch: target.baseBranch ?? target.repository?.defaultBranch,
    defaultEnvironmentId: target.defaultEnvironmentId,
    remoteProject: target.remoteProject,
    folderProject: target.folderProject,
    hostModel: undefined,
  } : {
    remoteProject: undefined,
    folderProject: undefined,
    hostModel: undefined,
  }),
}), { name: "pi-desktop.sessionTarget.v1", partialize: ({ environmentId, repository, baseBranch }) => ({ environmentId, repository, baseBranch }) }));
