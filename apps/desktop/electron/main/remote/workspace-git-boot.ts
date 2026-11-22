/**
 * Main-process API for git workspaces on a paired remote Host (D687, decision
 * record `remote-git-workspaces`).
 *
 * It is a thin, typed front for the ten owner-only `workspace/git*` RACP
 * operations plus the one thing that needs care here: handing the Host the
 * GitHub token. The token is read from a provider only at the moment it is
 * sent, is sent only over a transport an observer on the network cannot read,
 * and is never logged or placed in an error.
 *
 * Nothing here waits on git. `prepare` and `push` return a job id; callers
 * poll `job`.
 */
import {
  ErrorCodes,
  type WorkspaceGitEnvironment,
  type WorkspaceGitJob,
  type WorkspaceGitRemoveResult,
  type WorkspaceGitReclaimResult,
  type WorkspaceGitRepository,
  type WorkspaceGitStatus,
  type WorkspaceGitWorktree,
} from "@pi-desktop/shared";
import type { RemoteHostRecord } from "./remote-host-registry.js";

/** Every call is short: long work is a job on the Host. */
const REQUEST_TIMEOUT_MS = 30_000;

export type WorkspaceGitCredentialProvider = () => Promise<string | null>;

export type WorkspaceGitBoot = {
  setCredentialProvider(provider: WorkspaceGitCredentialProvider | null): void;
  /** Push or clear the credential on every connected capable host. */
  refreshCredential(): Promise<void>;
  /** Whether the host offers git workspaces; realigns it once when it does not. */
  supported(hostKey: string): Promise<boolean>;
  supportsSafeRemoval(hostKey: string): boolean;
  supportsReclaim(hostKey: string): boolean;
  reclaim(hostKey: string, sessionId: string, regenerableDirs: string[]): Promise<WorkspaceGitReclaimResult>;
  repository(hostKey: string, repository: WorkspaceGitRepository): Promise<{ path: string; cloned: boolean }>;
  prepare(hostKey: string, input: {
    sessionId: string; repository: WorkspaceGitRepository; baseBranch: string;
    fromSessionId?: string; environment?: WorkspaceGitEnvironment; restoreOnly?: boolean; rerunSetup?: boolean;
    rebuild?: boolean;
  }): Promise<{ jobId: string }>;
  push(hostKey: string, sessionId: string): Promise<{ jobId: string }>;
  job(hostKey: string, jobId: string): Promise<WorkspaceGitJob>;
  cancelJob(hostKey: string, jobId: string): Promise<void>;
  status(hostKey: string, sessionId: string): Promise<WorkspaceGitStatus>;
  remove(hostKey: string, sessionId: string, force: boolean): Promise<WorkspaceGitRemoveResult>;
  list(hostKey: string): Promise<WorkspaceGitWorktree[]>;
};

/** What the boot needs from one connected host. */
export type WorkspaceGitHost = {
  adapter: {
    client: { request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> };
    workspaceCapabilities?(): { workspaceGit?: boolean; workspaceGitSafeRemoval?: boolean; workspaceGitReclaim?: boolean } | undefined;
  };
};

export type WorkspaceGitBootDeps = {
  connectedHost(hostKey: string): WorkspaceGitHost | undefined;
  /** Connect the host when it is not; rejects when it cannot be reached. */
  ensureReady(hostKey: string): Promise<unknown>;
  /** Bring the host up to this desktop's release and reconnect; true when it ran. */
  realign(hostKey: string): Promise<boolean>;
  record(hostKey: string): RemoteHostRecord | undefined;
  getInstallationId(): Promise<string>;
  log: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

/** What one credential push achieved; `anonymous` means there was no token to send. */
type Outcome = "delivered" | "anonymous" | "refused" | "failed" | "stale" | "skipped";
/** What a host connection was given: the token (or none) for one credential generation. */
type Delivery = { host: WorkspaceGitHost; connection: number; generation: number; token: boolean };

function fail(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode, retriable: false });
}

/**
 * The credential may travel only where the path to the Host is encrypted or
 * never leaves this machine: the desktop's own SSH forward, a `wss://` URL, or
 * a loopback `ws://` URL (a forward the user opened themselves).
 */
export function credentialTransportAllowed(record: Pick<RemoteHostRecord, "url" | "metadata"> | undefined): boolean {
  if (!record) return false;
  if (record.metadata?.transport === "ssh") return true;
  let url: URL;
  try { url = new URL(record.url); } catch { return false; }
  if (url.protocol === "wss:") return true;
  return url.protocol === "ws:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

function errorCodeOf(error: unknown): string {
  const fields = (error ?? {}) as { errorCode?: unknown; code?: unknown };
  const code = fields.errorCode ?? fields.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

export function createWorkspaceGitBoot(deps: WorkspaceGitBootDeps): WorkspaceGitBoot & {
  /** A host connected or reconnected: give its new connection the credential. */
  hostConnected(hostKey: string): Promise<void>;
  hostRemoved(hostKey: string): void;
} {
  let provider: WorkspaceGitCredentialProvider | null = null;
  /** Bumped by every provider or credential change: what was sent before is out of date. */
  let generation = 0;
  /** Hosts that have connected at least once; `refreshCredential` walks them. */
  const known = new Set<string>();
  /** Bumped by every new connection to a host, which starts without a credential. */
  const connections = new Map<string, number>();
  /** What each host's current connection was last given, and for which generation. */
  const delivered = new Map<string, Delivery>();
  /** Hosts whose token could not be sent because their transport is not safe. */
  const refused = new Set<string>();
  /** The credential push in flight per host; git calls wait for it. */
  const pushes = new Map<string, Promise<Outcome>>();
  /** One realignment per host for this desktop release, shared by concurrent callers. */
  const realignments = new Map<string, Promise<void>>();

  const advertises = (host: WorkspaceGitHost | undefined) => host?.adapter.workspaceCapabilities?.()?.workspaceGit === true;
  const supportsReclaim = (hostKey: string) => deps.connectedHost(hostKey)?.adapter.workspaceCapabilities?.()?.workspaceGitReclaim === true;
  const unavailable = () => Object.assign(new Error("remote host is unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
  const connectionOf = (hostKey: string) => connections.get(hostKey) ?? 0;
  /** The delivery the host's live connection holds; one made to an earlier connection is gone. */
  function holding(hostKey: string, host: WorkspaceGitHost | undefined): Delivery | undefined {
    const entry = delivered.get(hostKey);
    return host && entry?.host === host && entry.connection === connectionOf(hostKey) ? entry : undefined;
  }
  const upToDate = (hostKey: string, host: WorkspaceGitHost) => holding(hostKey, host)?.generation === generation;

  /** Send or clear the credential on one host. Never throws, never logs a value. */
  async function pushCredential(hostKey: string): Promise<Outcome> {
    const current = provider;
    const sent = generation;
    const host = deps.connectedHost(hostKey);
    if (!host || !advertises(host)) return "skipped";
    const connection = connectionOf(hostKey);
    const held = holding(hostKey, host)?.token === true;
    const stale = () => provider !== current || deps.connectedHost(hostKey) !== host || connectionOf(hostKey) !== connection;
    const settle = (token: boolean) => {
      if (!stale()) delivered.set(hostKey, { host, connection, generation: sent, token });
    };
    let token: string | null = null;
    try {
      token = await current?.() ?? null;
    } catch {
      // The provider's error may quote what it failed to read; keep only the fact.
      deps.log("warn", "git credential provider failed; clearing the remote credential", { hostKey });
    }
    if (stale()) return "stale";
    try {
      if (token === null) {
        refused.delete(hostKey);
        // A connection that was never given a token has nothing to clear.
        if (held) await host.adapter.client.request("workspace/gitCredentialClear", {}, REQUEST_TIMEOUT_MS);
        settle(false);
        return "anonymous";
      }
      if (!credentialTransportAllowed(deps.record(hostKey))) {
        refused.add(hostKey);
        if (held) await host.adapter.client.request("workspace/gitCredentialClear", {}, REQUEST_TIMEOUT_MS);
        deps.log("warn", "git credential not sent: the remote host is not reached over SSH, wss, or loopback", { hostKey, code: ErrorCodes.WORKSPACE_GIT_TRANSPORT_REFUSED });
        settle(false);
        return "refused";
      }
      refused.delete(hostKey);
      const installationId = await deps.getInstallationId();
      if (stale()) return "stale";
      await host.adapter.client.request("workspace/gitCredentialSet", { installationId, token }, REQUEST_TIMEOUT_MS);
      settle(true);
      return "delivered";
    } catch (error) {
      // Only the code: a message could echo the request.
      deps.log("warn", "git credential could not be delivered to the remote host", { hostKey, code: errorCodeOf(error) });
      // Without a token there is nothing the call depends on.
      return token === null ? "anonymous" : "failed";
    }
  }

  /** Serialize pushes per host so an older token can never land after a newer one. */
  function schedulePush(hostKey: string): Promise<Outcome> {
    const task = (pushes.get(hostKey) ?? Promise.resolve()).then(() => pushCredential(hostKey));
    pushes.set(hostKey, task);
    void task.finally(() => { if (pushes.get(hostKey) === task) pushes.delete(hostKey); });
    return task;
  }

  /**
   * Make sure the host's live connection holds the current credential before
   * a call that depends on it. A delivery that failed, or one made to an
   * earlier connection, is sent again now; a credential that still cannot be
   * delivered fails the call with a typed error rather than letting git run
   * without it. With no token to send the call proceeds, as it always has.
   */
  async function ensureCredential(hostKey: string, host: WorkspaceGitHost): Promise<void> {
    // A connect may still be delivering the credential this call depends on.
    await pushes.get(hostKey);
    let outcome: Outcome | undefined;
    // A push overtaken by a new connection or provider is tried once more.
    for (let attempt = 0; attempt < 2 && !upToDate(hostKey, host); attempt++) {
      outcome = await schedulePush(hostKey);
      if (outcome !== "stale") break;
    }
    if (deps.connectedHost(hostKey) !== host) throw unavailable();
    if (refused.has(hostKey)) {
      throw fail(ErrorCodes.WORKSPACE_GIT_TRANSPORT_REFUSED, "the GitHub credential is only sent to a host reached over SSH, wss://, or a loopback ws:// address");
    }
    if (outcome === "anonymous" || upToDate(hostKey, host)) return;
    throw fail(ErrorCodes.WORKSPACE_GIT_CREDENTIAL_UNAVAILABLE, "the GitHub credential could not be delivered to the remote host; try again");
  }

  /** A connected host that advertises the capability, or the typed refusal. */
  async function capableHost(hostKey: string): Promise<WorkspaceGitHost> {
    await deps.ensureReady(hostKey);
    const host = deps.connectedHost(hostKey);
    if (!host) throw unavailable();
    if (!advertises(host)) {
      throw fail(ErrorCodes.HOST_VERSION_MISMATCH, "Upgrade pi-host to a matching Desktop release with git workspace support");
    }
    return host;
  }

  async function call<T>(hostKey: string, method: string, params: (installationId: string) => Record<string, unknown>, options: { needsCredential?: boolean; needsSafeRemoval?: boolean; rebuild?: boolean } = {}): Promise<T> {
    const host = await capableHost(hostKey);
    let installationId: string;
    try {
      installationId = await deps.getInstallationId();
    } catch {
      throw fail(ErrorCodes.WORKSPACE_GIT_UNAVAILABLE, "this desktop's installation identity is unavailable");
    }
    if (options.rebuild) {
      if (!supportsReclaim(hostKey)) throw fail(ErrorCodes.HOST_VERSION_MISMATCH, "Upgrade pi-host to restore a reclaimed workspace");
      await pushes.get(hostKey);
    }
    if (options.needsCredential) await ensureCredential(hostKey, host);
    if (deps.connectedHost(hostKey) !== host) throw unavailable();
    if (options.needsSafeRemoval && host.adapter.workspaceCapabilities?.()?.workspaceGitSafeRemoval !== true) {
      throw fail(ErrorCodes.HOST_VERSION_MISMATCH, "Upgrade pi-host to enable safe worktree removal");
    }
    const result = await host.adapter.client.request<T>(method, params(installationId), REQUEST_TIMEOUT_MS);
    if (deps.connectedHost(hostKey) !== host) throw unavailable();
    return result;
  }

  return {
    setCredentialProvider(next) {
      provider = next;
      generation += 1;
    },
    async refreshCredential() {
      generation += 1;
      await Promise.all([...known].map((hostKey) => schedulePush(hostKey)));
    },
    async supported(hostKey) {
      await deps.ensureReady(hostKey);
      if (!deps.connectedHost(hostKey)) throw unavailable();
      if (advertises(deps.connectedHost(hostKey))) return true;
      // The host runs a bundle without the capability. Bring it up to this
      // release once; a second miss is the answer, not a reason to try again.
      let realignment = realignments.get(hostKey);
      if (!realignment) {
        realignment = deps.realign(hostKey).then(() => undefined, () => {
          deps.log("warn", "remote host realignment for git workspaces failed", { hostKey });
        });
        realignments.set(hostKey, realignment);
      }
      await realignment;
      return advertises(deps.connectedHost(hostKey));
    },
    supportsSafeRemoval(hostKey) {
      const capabilities = deps.connectedHost(hostKey)?.adapter.workspaceCapabilities?.();
      return capabilities?.workspaceGit === true && capabilities.workspaceGitSafeRemoval === true;
    },
    supportsReclaim,
    async reclaim(hostKey, sessionId, regenerableDirs) {
      const host = deps.connectedHost(hostKey);
      if (!host || !supportsReclaim(hostKey)) throw unavailable();
      const installationId = await deps.getInstallationId();
      if (deps.connectedHost(hostKey) !== host || !supportsReclaim(hostKey)) throw unavailable();
      const result = await host.adapter.client.request<WorkspaceGitReclaimResult>("workspace/gitReclaim", {
        installationId, sessionId, regenerableDirs,
      }, REQUEST_TIMEOUT_MS);
      if (deps.connectedHost(hostKey) !== host) throw unavailable();
      return result;
    },
    repository(hostKey, repository) {
      return call(hostKey, "workspace/gitRepository", () => ({ repository: { owner: repository.owner, name: repository.name } }));
    },
    prepare(hostKey, input) {
      return call(hostKey, "workspace/gitPrepare", (installationId) => ({
        installationId,
        sessionId: input.sessionId,
        repository: { owner: input.repository.owner, name: input.repository.name },
        baseBranch: input.baseBranch,
        ...(input.fromSessionId !== undefined ? { fromSessionId: input.fromSessionId } : {}),
        ...(input.restoreOnly === true || input.rebuild ? { restoreOnly: true } : {}),
        ...(input.rebuild || input.rerunSetup === true ? { rerunSetup: true } : {}),
        ...(input.rebuild ? { requireSetupSuccess: true } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      }), { needsCredential: !input.restoreOnly && !input.rerunSetup && !input.rebuild, rebuild: input.rebuild });
    },
    push(hostKey, sessionId) {
      return call(hostKey, "workspace/gitPush", (installationId) => ({ installationId, sessionId }), { needsCredential: true });
    },
    job(hostKey, jobId) {
      return call(hostKey, "workspace/gitJob", () => ({ jobId }));
    },
    async cancelJob(hostKey, jobId) {
      await call(hostKey, "workspace/gitJobCancel", () => ({ jobId }));
    },
    status(hostKey, sessionId) {
      return call(hostKey, "workspace/gitStatus", (installationId) => ({ installationId, sessionId }));
    },
    remove(hostKey, sessionId, force) {
      return call(hostKey, "workspace/gitRemove", (installationId) => ({ installationId, sessionId, force }), { needsSafeRemoval: !force });
    },
    async list(hostKey) {
      const result = await call<{ worktrees?: WorkspaceGitWorktree[] }>(hostKey, "workspace/gitList", (installationId) => ({ installationId }));
      return result.worktrees ?? [];
    },
    async hostConnected(hostKey) {
      known.add(hostKey);
      // The Host dropped the credential with the previous connection.
      connections.set(hostKey, connectionOf(hostKey) + 1);
      await schedulePush(hostKey);
    },
    hostRemoved(hostKey) {
      known.delete(hostKey);
      refused.delete(hostKey);
      delivered.delete(hostKey);
      connections.delete(hostKey);
      realignments.delete(hostKey);
    },
  };
}
