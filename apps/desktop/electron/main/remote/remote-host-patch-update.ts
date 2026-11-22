/**
 * Bring a paired Host that runs an older patch of this desktop's release up
 * to date (D695).
 *
 * Readiness accepts any Host in the same `major.minor` series, and the
 * capability realignment only runs when a capability is missing, so a fix
 * shipped in a patch release never reached Hosts that were already paired.
 * When a connected Host reports an older version than this desktop, this runs
 * the existing verified realignment (ADR 0327) once per desktop run, and only
 * while nothing is running on that Host: a realignment restarts `pi-host`,
 * which would end its git jobs and agent turns. A busy Host is checked again
 * later.
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type Version = { core: [number, number, number]; prerelease: string[] };

function parse(value: string): Version | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Semver precedence of two prerelease identifier lists; an empty list is the release. */
function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length || !right.length) return (right.length ? 1 : 0) - (left.length ? 1 : 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numeric = /^\d+$/;
    if (numeric.test(a) && numeric.test(b)) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
    } else if (numeric.test(a) !== numeric.test(b)) {
      return numeric.test(a) ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether a Host running `running` is behind a desktop at `expected`. A
 * version that is not semver is never called behind: the desktop cannot tell,
 * and realigning on a guess would restart a Host for nothing.
 */
export function isRemoteHostVersionBehind(running: string | undefined, expected: string): boolean {
  if (!running) return false;
  const host = parse(running);
  const desktop = parse(expected);
  if (!host || !desktop) return false;
  for (let index = 0; index < 3; index++) {
    if (host.core[index] !== desktop.core[index]) return host.core[index]! < desktop.core[index]!;
  }
  return comparePrerelease(host.prerelease, desktop.prerelease) < 0;
}

/** How long a busy Host waits before it is checked again. */
export const PATCH_UPDATE_RETRY_MS = 5 * 60_000;

export type RemoteHostPatchUpdaterDeps = {
  /** The release this desktop expects its Hosts to run. */
  expectedVersion: string;
  /** The version a connected Host reported in its handshake, if any. */
  hostVersion(hostKey: string): string | undefined;
  /** True while a git job, an agent turn, or anything else runs on the Host. */
  isBusy(hostKey: string): Promise<boolean>;
  /** The verified realignment; true when it brought the Host up to date. */
  realign(hostKey: string): Promise<boolean>;
  log(level: "info" | "warn", message: string, data?: Record<string, unknown>): void;
  retryMs?: number;
};

export function createRemoteHostPatchUpdater(deps: RemoteHostPatchUpdaterDeps) {
  const retryMs = deps.retryMs ?? PATCH_UPDATE_RETRY_MS;
  /** Hosts realigned, or tried, in this run; a Host is never tried twice. */
  const attempted = new Set<string>();
  const checking = new Map<string, Promise<void>>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const behind = (hostKey: string) => isRemoteHostVersionBehind(deps.hostVersion(hostKey), deps.expectedVersion);

  function retryLater(hostKey: string) {
    if (disposed || retries.has(hostKey)) return;
    const timer = setTimeout(() => {
      retries.delete(hostKey);
      void check(hostKey);
    }, retryMs);
    timer.unref?.();
    retries.set(hostKey, timer);
  }

  async function run(hostKey: string) {
    if (disposed || attempted.has(hostKey) || !behind(hostKey)) return;
    let busy = true;
    try {
      busy = await deps.isBusy(hostKey);
    } catch (error) {
      deps.log("warn", "could not tell whether the remote host is busy; its update waits", { hostKey, error: String(error) });
    }
    // State may have changed while the busy check ran.
    if (disposed || attempted.has(hostKey) || !behind(hostKey)) return;
    if (busy) {
      deps.log("info", "remote host update waits until nothing runs on it", { hostKey, version: deps.hostVersion(hostKey) });
      retryLater(hostKey);
      return;
    }
    attempted.add(hostKey);
    const from = deps.hostVersion(hostKey);
    deps.log("info", "updating the remote host to this desktop's release", { hostKey, from, to: deps.expectedVersion });
    try {
      const updated = await deps.realign(hostKey);
      deps.log("info", updated ? "remote host updated" : "remote host update not applied", { hostKey, from, to: deps.expectedVersion });
    } catch (error) {
      deps.log("warn", "remote host update failed", { hostKey, error: String(error) });
    }
  }

  function check(hostKey: string): Promise<void> {
    const pending = checking.get(hostKey);
    if (pending) return pending;
    const task = run(hostKey).finally(() => checking.delete(hostKey));
    checking.set(hostKey, task);
    return task;
  }

  return {
    /** A connected Host runs an older release than this desktop. */
    updateAvailable: behind,
    /** A Host connected: update it when it is behind, idle, and not yet tried. */
    check,
    forget(hostKey: string) {
      const timer = retries.get(hostKey);
      if (timer) clearTimeout(timer);
      retries.delete(hostKey);
      attempted.delete(hostKey);
    },
    dispose() {
      disposed = true;
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
    },
  };
}

export type RemoteHostPatchUpdater = ReturnType<typeof createRemoteHostPatchUpdater>;
