import type { RemoteEnvironment, WorkspaceGitReclaimResult } from "@pi-desktop/shared";
import type { WorkspaceBinding } from "./session-workspaces";

const SCAN_INTERVAL_MS = 15 * 60_000;
const MAX_CHECKS_PER_HOST = 10;
const HOUR_MS = 60 * 60_000;

type Candidate = Pick<WorkspaceBinding, "environmentId" | "hostKey" | "lastActivityAt" | "updatedAt">;

export function idleSince(binding: Candidate, environment: RemoteEnvironment | undefined, now: number): number | undefined {
  if (!environment || environment.hostKey !== binding.hostKey || !Number.isSafeInteger(environment.idleReclaimHours) || environment.idleReclaimHours <= 0) return;
  const lastUse = Date.parse(binding.lastActivityAt ?? binding.updatedAt ?? "");
  if (Number.isFinite(lastUse) && now - lastUse >= environment.idleReclaimHours * HOUR_MS) return lastUse;
}

type Dependencies = {
  connectedHosts(): Promise<string[]>;
  supported(hostKey: string): boolean;
  environments(): Promise<RemoteEnvironment[]>;
  bindings(): Promise<WorkspaceBinding[]>;
  reclaim(binding: WorkspaceBinding): Promise<WorkspaceGitReclaimResult | undefined>;
  log(message: string, error: unknown): void;
  now?: () => number;
};

export function createIdleWorkspaceReclaimer(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const scans = new Map<string, Promise<void>>();
  const nextCheck = new Map<string, Map<string, number>>();
  let disposed = false;

  async function scan(hostKey: string) {
    const [bindings, environments] = await Promise.all([deps.bindings(), deps.environments()]);
    const byEnvironment = new Map(environments.map((environment) => [environment.id, environment]));
    const time = now();
    const cooldown = nextCheck.get(hostKey) ?? new Map<string, number>();
    nextCheck.set(hostKey, cooldown);
    for (const [id, until] of cooldown) if (until <= time) cooldown.delete(id);
    const candidates = bindings.flatMap((binding) => {
      if (binding.hostKey !== hostKey || binding.state !== "ready" || cooldown.has(binding.sessionId)) return [];
      const lastUse = idleSince(binding, byEnvironment.get(binding.environmentId), time);
      return lastUse === undefined ? [] : [{ binding, lastUse }];
    }).sort((left, right) => left.lastUse - right.lastUse);
    let checked = 0;
    for (const { binding } of candidates) {
      if (disposed || !deps.supported(hostKey) || checked >= MAX_CHECKS_PER_HOST) break;
      try {
        const result = await deps.reclaim(binding);
        if (!result) continue;
        checked++;
        if (!result.reclaimed) cooldown.set(binding.sessionId, now() + HOUR_MS);
      } catch (error) {
        checked++;
        cooldown.set(binding.sessionId, now() + HOUR_MS);
        if (deps.supported(hostKey)) deps.log("Could not reclaim idle repository workspace", error);
      }
    }
  }

  function check(hostKey: string): Promise<void> {
    if (disposed || !deps.supported(hostKey)) return Promise.resolve();
    const pending = scans.get(hostKey);
    if (pending) return pending;
    const task = scan(hostKey)
      .catch((error) => deps.log("Could not check idle repository workspaces", error))
      .finally(() => scans.delete(hostKey));
    scans.set(hostKey, task);
    return task;
  }

  const timer = setInterval(() => {
    void deps.connectedHosts().then((hosts) => Promise.all(hosts.map(check)))
      .catch((error) => deps.log("Could not list hosts for workspace reclamation", error));
  }, SCAN_INTERVAL_MS).unref();
  return {
    check,
    dispose() {
      disposed = true;
      clearInterval(timer);
      nextCheck.clear();
    },
  };
}
