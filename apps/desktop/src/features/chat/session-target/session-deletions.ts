/**
 * Sessions whose deletion is in flight. Deleting a preparing or repository
 * session stops its Host job and removes its worktree, which can take tens
 * of seconds; the sidebar row and the composer say so until it settles.
 */
import { create } from "zustand";

type SessionDeletions = { ids: Readonly<Record<string, true>> };

export const useSessionDeletions = create<SessionDeletions>(() => ({ ids: {} }));

export function isSessionDeleting(id: string): boolean {
  return useSessionDeletions.getState().ids[id] === true;
}

/** Mark `id` as deleting while `task` runs, whatever its outcome. */
export async function trackSessionDeletion<T>(id: string, task: () => Promise<T>): Promise<T> {
  useSessionDeletions.setState((state) => ({ ids: { ...state.ids, [id]: true } }));
  try {
    return await task();
  } finally {
    useSessionDeletions.setState((state) => {
      const ids = { ...state.ids };
      delete ids[id];
      return { ids };
    });
  }
}
