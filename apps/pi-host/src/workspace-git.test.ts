import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { HostRpc } from "@pi-desktop/host-runtime";

import { createGitCredentialProxy, type GitCredentialProxy, type GitProxyScope } from "./git-credential-proxy.js";
import { createWorkspaceGit, detectWorkspaceGitReclaim, workspaceGitShortId, workspaceGitWorkBranch } from "./workspace-git.js";

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const OTHER_INSTALLATION = "11111111-1111-4111-8111-111111111111";
const TOKEN = "fixture-token-not-a-real-credential";
const ROOT = "/home/pi/pi-workspaces";
const repository = { owner: "octo", name: "repo" };
const owner = { deviceId: "device-a", connectionId: "connection-a" };
const ownerB = { deviceId: "device-b", connectionId: "connection-b" };

type Call = { method: string; params: Record<string, unknown> };
type Event = { type: "host"; method: string } | { type: "setToken"; installationId: string; token: string | null } | { type: "register"; scope: GitProxyScope } | { type: "unregister"; installationId: string; sessionId: string };

function worktree(sessionId: string, installationId = INSTALLATION) {
  return {
    sessionId, repository, baseBranch: "main", workBranch: workspaceGitWorkBranch(installationId, sessionId),
    path: `${ROOT}/worktrees/github.com/octo/repo/${workspaceGitShortId(installationId, sessionId)}`,
    mainPath: `${ROOT}/repos/github.com/octo/repo`, baseCommit: "a".repeat(40), createdAt: "2026-11-20T00:00:00.000Z", setup: { status: "none" },
  };
}

function fixture(respond: (method: string, params: Record<string, unknown>) => unknown = () => ({}), reclaimSupported = true) {
  const events: Event[] = [];
  const calls: Call[] = [];
  const host: HostRpc = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      events.push({ type: "host", method });
      calls.push({ method, params });
      return respond(method, params) as T;
    },
  };
  const proxy: GitCredentialProxy = {
    verifiesPeerUser: true,
    async start() {},
    async close() {},
    setToken(installationId, token) { events.push({ type: "setToken", installationId, token }); },
    register(scope) { events.push({ type: "register", scope }); return `http://127.0.0.1:4321/${workspaceGitShortId(scope.installationId, scope.sessionId).padEnd(64, "0")}/`; },
    unregister(installationId, sessionId) { events.push({ type: "unregister", installationId, sessionId }); },
  };
  const state: { host: HostRpc | null } = { host };
  const git = createWorkspaceGit({
    getHost: () => state.host, workspacesRoot: ROOT, proxy,
    reclaimSupported: (candidate) => reclaimSupported && candidate === host,
  });
  const urlFor = (sessionId: string, installationId = INSTALLATION) => `http://127.0.0.1:4321/${workspaceGitShortId(installationId, sessionId).padEnd(64, "0")}/`;
  return { git, events, calls, state, host, urlFor };
}

describe("work branch derivation", () => {
  it("matches the cross-language test vector", () => {
    expect(workspaceGitShortId(INSTALLATION, "session-1")).toBe("8b54618f6bc1");
    expect(workspaceGitWorkBranch(INSTALLATION, "session-1")).toBe("pi-desktop/8b54618f6bc1");
    expect(workspaceGitShortId(INSTALLATION, "session-2")).not.toBe("8b54618f6bc1");
    expect(workspaceGitShortId(OTHER_INSTALLATION, "session-1")).not.toBe("8b54618f6bc1");
  });
});

describe("pi-host workspace git", () => {
  it("forwards every operation to host-core with the workspaces root", async () => {
    const job = { jobId: "job-1", kind: "prepare", state: "running", phase: "queued" };
    const status = { worktree: worktree("session-1"), ahead: 0, behind: 0, uncommittedFiles: 0, unpushedCommits: 0, pushedOnce: false };
    const f = fixture((method) => {
      switch (method) {
        case "workspaceGit.repository": return { path: `${ROOT}/repos/github.com/octo/repo`, cloned: true };
        case "workspaceGit.prepare": return { jobId: "job-1" };
        case "workspaceGit.push": return { jobId: "job-2" };
        case "workspaceGit.job": return job;
        case "workspaceGit.jobCancel": return { ok: true };
        case "workspaceGit.status": return status;
        case "workspaceGit.removeSafely": return { removed: false, uncommittedFiles: 2, unpushedCommits: 1 };
        case "workspaceGit.list": return { worktrees: [worktree("session-1")] };
        default: throw new Error(`unexpected ${method}`);
      }
    });
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    expect(await f.git.repository({ repository })).toEqual({ path: `${ROOT}/repos/github.com/octo/repo`, cloned: true });
    expect(await f.git.prepare({ ...session, repository, baseBranch: "main" }, owner)).toEqual({ jobId: "job-1" });
    expect(await f.git.push(session, owner)).toEqual({ jobId: "job-2" });
    expect(await f.git.job({ jobId: "job-1" })).toEqual(job);
    await f.git.cancelJob({ jobId: "job-1" });
    expect(await f.git.status(session)).toEqual(status);
    expect(await f.git.remove({ ...session, force: false })).toEqual({ removed: false, uncommittedFiles: 2, unpushedCommits: 1 });
    expect(await f.git.list({ installationId: INSTALLATION })).toEqual([worktree("session-1")]);
    expect(f.calls.map((call) => call.method)).toEqual([
      "workspaceGit.repository", "workspaceGit.prepare", "workspaceGit.push", "workspaceGit.job", "workspaceGit.jobCancel",
      "workspaceGit.status", "workspaceGit.removeSafely", "workspaceGit.list",
    ]);
    for (const call of f.calls) expect(call.params.workspacesRoot, call.method).toBe(ROOT);
    expect(f.calls[0]?.params).toEqual({ workspacesRoot: ROOT, repository });
    expect(f.calls[3]?.params).toEqual({ workspacesRoot: ROOT, jobId: "job-1" });
    expect(f.calls[5]?.params).toEqual({ workspacesRoot: ROOT, ...session });
    expect(f.calls[6]?.params).toEqual({ workspacesRoot: ROOT, ...session });
    expect(f.calls[7]?.params).toEqual({ workspacesRoot: ROOT, installationId: INSTALLATION });
  });

  it("registers the proxy scope before host-core prepares, and passes its address", async () => {
    const f = fixture(() => ({ jobId: "job-1" }));
    const input = {
      installationId: INSTALLATION, sessionId: "session-1", repository, baseBranch: "release/1.2", fromSessionId: "parent",
      environment: { variables: [{ name: "MY_VAR", value: "1" }], setupScript: "true" },
    };
    await f.git.prepare(input, owner);
    expect(f.events).toEqual([
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-1", repository, workBranch: "pi-desktop/8b54618f6bc1" } },
      { type: "host", method: "workspaceGit.prepare" },
    ]);
    expect(f.calls[0]?.params).toEqual({ workspacesRoot: ROOT, gitProxy: { url: f.urlFor("session-1") }, ...input });
    // The connection that prepared the session gets the address for its tools.
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBe(f.urlFor("session-1"));
    expect(f.git.proxyUrlFor(owner.connectionId, "session-2")).toBeUndefined();
    expect(f.git.proxyUrlFor("connection-unknown", "session-1")).toBeUndefined();
  });

  it("forwards rerunSetup to host-core when requested", async () => {
    const f = fixture(() => ({ jobId: "job-rerun" }));
    const input = {
      installationId: INSTALLATION, sessionId: "session-1", repository, baseBranch: "main",
      rerunSetup: true,
      environment: { variables: [{ name: "MY_VAR", value: "2" }], setupScript: "echo ok" },
    };
    await f.git.prepare(input, owner);
    expect(f.calls[0]?.method).toBe("workspaceGit.prepare");
    expect(f.calls[0]?.params).toEqual({
      workspacesRoot: ROOT,
      gitProxy: { url: f.urlFor("session-1") },
      ...input,
    });
  });

  it("push registers the session's scope again, finding its repository in the registry once", async () => {
    const f = fixture((method) => (method === "workspaceGit.list" ? { worktrees: [worktree("session-9")] } : { jobId: "job-2" }));
    await f.git.push({ installationId: INSTALLATION, sessionId: "session-9" }, owner);
    expect(f.events).toEqual([
      { type: "host", method: "workspaceGit.list" },
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-9", repository, workBranch: workspaceGitWorkBranch(INSTALLATION, "session-9") } },
      { type: "host", method: "workspaceGit.push" },
    ]);
    expect(f.calls[1]?.params).toEqual({ workspacesRoot: ROOT, gitProxy: { url: f.urlFor("session-9") }, installationId: INSTALLATION, sessionId: "session-9" });
    // Known now: no second lookup, but the scope is registered again so the
    // address is the proxy's live one.
    await f.git.push({ installationId: INSTALLATION, sessionId: "session-9" }, owner);
    expect(f.calls.map((call) => call.method)).toEqual(["workspaceGit.list", "workspaceGit.push", "workspaceGit.push"]);
    expect(f.events.slice(3).map((event) => event.type)).toEqual(["register", "host"]);
    // A session without a worktree has nothing to push, and host-core is not asked to.
    await expect(f.git.push({ installationId: INSTALLATION, sessionId: "no-such" }, owner)).rejects.toMatchObject({ code: "WORKSPACE_GIT_NOT_FOUND" });
    expect(f.calls.at(-1)?.method).toBe("workspaceGit.list");
  });

  it("setCredential hands the token to the proxy and scopes every existing worktree", async () => {
    const f = fixture((method, params) => (method === "workspaceGit.list" ? { worktrees: params.installationId === INSTALLATION ? [worktree("session-1"), worktree("session-2")] : [] } : {}));
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    expect(f.events).toEqual([
      { type: "setToken", installationId: INSTALLATION, token: TOKEN },
      { type: "host", method: "workspaceGit.list" },
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-1", repository, workBranch: workspaceGitWorkBranch(INSTALLATION, "session-1") } },
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-2", repository, workBranch: workspaceGitWorkBranch(INSTALLATION, "session-2") } },
    ]);
    expect(f.calls[0]?.params).toEqual({ workspacesRoot: ROOT, installationId: INSTALLATION });
    expect(f.git.proxyUrlFor(owner.connectionId, "session-2")).toBe(f.urlFor("session-2"));
    // Another desktop's connection does not get this installation's address.
    await f.git.setCredential({ installationId: OTHER_INSTALLATION, token: "other-fixture" }, ownerB);
    expect(f.git.proxyUrlFor(ownerB.connectionId, "session-2")).toBeUndefined();
    // The token goes to the proxy and nowhere else.
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
  });

  it("drops the token when the last connection that set it clears it or disconnects", async () => {
    const f = fixture((method) => (method === "workspaceGit.list" ? { worktrees: [worktree("session-1")] } : {}));
    const tokens = () => f.events.filter((event) => event.type === "setToken");
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, ownerB);
    expect(tokens()).toHaveLength(2);
    await f.git.disconnect(owner.connectionId);
    // One of two: the installation still has a live connection.
    expect(tokens()).toHaveLength(2);
    await f.git.clearCredential(ownerB);
    expect(tokens().at(-1)).toEqual({ type: "setToken", installationId: INSTALLATION, token: null });
    // The cleared connection keeps its address, so its git fails closed at the
    // proxy instead of going to GitHub without one.
    expect(f.git.proxyUrlFor(ownerB.connectionId, "session-1")).toBe(f.urlFor("session-1"));
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBeUndefined();

    // The only connection: disconnect clears.
    const g = fixture(() => ({ worktrees: [] }));
    await g.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await g.git.disconnect(owner.connectionId);
    expect(g.events.filter((event) => event.type === "setToken")).toEqual([
      { type: "setToken", installationId: INSTALLATION, token: TOKEN },
      { type: "setToken", installationId: INSTALLATION, token: null },
    ]);
    // A request that arrives for a connection that is already gone sets nothing.
    await expect(g.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(g.events.filter((event) => event.type === "setToken")).toHaveLength(2);
    // Clearing or disconnecting twice is harmless.
    await g.git.clearCredential(owner);
    await g.git.disconnect(owner.connectionId);
    await g.git.disconnect("never-seen");
    expect(g.events.filter((event) => event.type === "setToken")).toHaveLength(2);
  });

  it("moves a connection that changes installation and replaces its token", async () => {
    const f = fixture(() => ({ worktrees: [] }));
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await f.git.setCredential({ installationId: OTHER_INSTALLATION, token: "other-fixture" }, owner);
    expect(f.events.filter((event) => event.type === "setToken")).toEqual([
      { type: "setToken", installationId: INSTALLATION, token: TOKEN },
      { type: "setToken", installationId: INSTALLATION, token: null },
      { type: "setToken", installationId: OTHER_INSTALLATION, token: "other-fixture" },
    ]);
  });

  it("recognizes reclaim only when host-core validates the method's required inputs", async () => {
    for (const [code, supported] of [["INVALID_ARGUMENT", true], ["METHOD_NOT_FOUND", false]] as const) {
      const f = fixture(() => { throw Object.assign(new Error(code), { data: { errorCode: code } }); });
      expect(await detectWorkspaceGitReclaim(f.host)).toBe(supported);
      expect(f.calls).toEqual([{ method: "workspaceGit.reclaim", params: {} }]);
      expect(f.events).toEqual([{ type: "host", method: "workspaceGit.reclaim" }]);
    }
  });

  it("forwards reclaim without credentials and keeps a concurrent strict wake's proxy scope", async () => {
    const response = { reclaimed: true, commit: "a".repeat(40), reclaimedAt: "2026-11-20T00:00:00.000Z" };
    const reclaimReply = Promise.withResolvers<typeof response>();
    const f = fixture((method) => (method === "workspaceGit.reclaim" ? reclaimReply.promise : { jobId: "wake-1" }));
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    const reclaim = f.git.reclaim!({ ...session, regenerableDirs: ["apps/desktop/out"] });
    expect(f.events).toEqual([{ type: "host", method: "workspaceGit.reclaim" }]);
    expect(f.calls[0]?.params).toEqual({ ...session, workspacesRoot: ROOT, regenerableDirs: ["apps/desktop/out"] });

    const wake = { ...session, repository, baseBranch: "main", restoreOnly: true, rerunSetup: true, requireSetupSuccess: true };
    expect(await f.git.prepare(wake, owner)).toEqual({ jobId: "wake-1" });
    expect(f.calls[1]).toEqual({ method: "workspaceGit.prepare", params: { ...wake, workspacesRoot: ROOT, gitProxy: { url: f.urlFor("session-1") } } });
    reclaimReply.resolve(response);
    expect(await reclaim).toEqual(response);
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBe(f.urlFor("session-1"));
    expect(f.events.map((event) => event.type)).toEqual(["host", "register", "host"]);
  });

  it("preserves a reclaim refusal and never falls back to another git RPC", async () => {
    const response = { reclaimed: false, reason: "protectedIgnoredFiles", protectedIgnoredFiles: 3, uncommittedFiles: 0, unpushedCommits: 0 };
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    const f = fixture(() => response);
    expect(await f.git.reclaim!(session)).toEqual(response);
    expect(f.calls).toEqual([{ method: "workspaceGit.reclaim", params: { ...session, workspacesRoot: ROOT } }]);
    expect(f.events).toEqual([{ type: "host", method: "workspaceGit.reclaim" }]);

    const missing = fixture(() => { throw Object.assign(new Error("method not found"), { data: { errorCode: "METHOD_NOT_FOUND" } }); });
    await expect(missing.git.reclaim!(session)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    expect(missing.calls.map(({ method }) => method)).toEqual(["workspaceGit.reclaim"]);
  });

  it("keeps strict wake flags off a legacy or unverified host-core", async () => {
    const legacy = fixture(() => ({ jobId: "job-1" }), false);
    const restore = { installationId: INSTALLATION, sessionId: "session-1", repository, baseBranch: "main", restoreOnly: true };
    const wake = { ...restore, rerunSetup: true, requireSetupSuccess: true };
    expect(legacy.git.reclaim).toBeUndefined();
    await expect(legacy.git.prepare(wake, owner)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(legacy.events).toEqual([]);
    expect(await legacy.git.prepare(restore, owner)).toEqual({ jobId: "job-1" });

    const f = fixture();
    expect(f.git.reclaim).toBeDefined();
    f.state.host = legacy.host;
    expect(f.git.reclaim).toBeUndefined();
    await expect(f.git.prepare(wake, owner)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("does not fall back to legacy removal when host-core lacks guarded removal", async () => {
    const f = fixture((method) => {
      if (method === "workspaceGit.removeSafely") {
        throw Object.assign(new Error("method not found"), { data: { errorCode: "METHOD_NOT_FOUND" } });
      }
      return { removed: true, uncommittedFiles: 0, unpushedCommits: 0 };
    });
    await expect(f.git.remove({ installationId: INSTALLATION, sessionId: "session-1", force: false }))
      .rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    expect(f.calls.map(({ method }) => method)).toEqual(["workspaceGit.removeSafely"]);
  });

  it("drops the scope once host-core has removed the worktree", async () => {
    let removed = false;
    const f = fixture((method) => (["workspaceGit.remove", "workspaceGit.removeSafely"].includes(method) ? { removed, uncommittedFiles: 1, unpushedCommits: 0 } : { jobId: "job-1" }));
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    await f.git.prepare({ ...session, repository, baseBranch: "main" }, owner);
    await f.git.remove({ ...session, force: false });
    expect(f.events.some((event) => event.type === "unregister")).toBe(false);
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBe(f.urlFor("session-1"));
    removed = true;
    await f.git.remove({ ...session, force: true });
    expect(f.events.at(-1)).toEqual({ type: "unregister", ...session });
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBeUndefined();
  });

  it("surfaces host-core's typed errors and never reports a restarted host as success", async () => {
    const busy = fixture(() => { throw Object.assign(new Error("a git job for this session is still running"), { data: { errorCode: "WORKSPACE_GIT_BUSY" } }); });
    await expect(busy.git.prepare({ installationId: INSTALLATION, sessionId: "s", repository, baseBranch: "main" }, owner)).rejects.toMatchObject({ code: "WORKSPACE_GIT_BUSY", message: "a git job for this session is still running" });
    await expect(busy.git.job({ jobId: "x" })).rejects.toMatchObject({ code: "WORKSPACE_GIT_BUSY" });
    const invalid = fixture(() => { throw Object.assign(new Error("branch name is not an allowed git branch name"), { errorCode: "INVALID_ARGUMENT" }); });
    await expect(invalid.git.status({ installationId: INSTALLATION, sessionId: "s" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const down = fixture(() => { throw Object.assign(new Error("host exited"), { errorCode: "HOST_UNAVAILABLE" }); });
    await expect(down.git.list({ installationId: INSTALLATION })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    const other = fixture(() => { throw new Error("boom"); });
    await expect(other.git.list({ installationId: INSTALLATION })).rejects.toMatchObject({ code: "INTERNAL" });

    const none = fixture();
    none.state.host = null;
    await expect(none.git.repository({ repository })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    await expect(none.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner)).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    expect(none.events).toEqual([]);

    // host-core was replaced while the call was in flight.
    const restarted = fixture();
    restarted.state.host = { async call<T>() { restarted.state.host = { async call<U>() { return {} as U; } }; return { jobId: "stale" } as T; } };
    await expect(restarted.git.prepare({ installationId: INSTALLATION, sessionId: "s", repository, baseBranch: "main" }, owner)).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });
});

describe("pi-host workspace git with the real credential proxy", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  /** The proxy in front of a stand-in GitHub that answers every request with 200. */
  async function realProxy() {
    const server = createServer((req, res) => { req.resume(); req.on("end", () => res.end("ok")); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const proxy = createGitCredentialProxy({ upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, env: {} });
    await proxy.start();
    cleanup.push(() => proxy.close());
    return proxy;
  }

  /** What git gets when it fetches through `base`: 404 for a handle the proxy no longer knows. */
  function fetchStatus(base: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(`${base}octo/repo.git/info/refs?service=git-upload-pack`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("keeps every cached scope usable across credential sets, and push re-registers its scope", async () => {
    const proxy = await realProxy();
    const calls: Call[] = [];
    // The prepare is still running: host-core does not list the worktree yet.
    const host: HostRpc = {
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        return (method === "workspaceGit.list" ? { worktrees: [] } : { jobId: `job-${calls.length}` }) as T;
      },
    };
    const git = createWorkspaceGit({ getHost: () => host, workspacesRoot: ROOT, proxy });
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    await git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await git.prepare({ ...session, repository, baseBranch: "main" }, owner);
    const first = git.proxyUrlFor(owner.connectionId, "session-1")!;
    expect(await fetchStatus(first)).toBe(200);

    // Reconnecting with the same token keeps the address the tools hold.
    await git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    expect(git.proxyUrlFor(owner.connectionId, "session-1")).toBe(first);
    expect(await fetchStatus(first)).toBe(200);

    // A new token rotates the handles; the cached scope gets a live one.
    await git.setCredential({ installationId: INSTALLATION, token: "rotated-fixture-token" }, owner);
    expect(await fetchStatus(first)).toBe(404);
    const second = git.proxyUrlFor(owner.connectionId, "session-1")!;
    expect(second).not.toBe(first);
    expect(await fetchStatus(second)).toBe(200);

    // A push always hands host-core a registered address.
    await git.push(session, owner);
    const pushed = calls.filter((call) => call.method === "workspaceGit.push").at(-1)!;
    const url = (pushed.params.gitProxy as { url: string }).url;
    expect(await fetchStatus(url)).toBe(200);
  });

  it("re-registers a push scope that a rotation dropped behind the cache", async () => {
    const proxy = await realProxy();
    const calls: Call[] = [];
    const host: HostRpc = {
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        return (method === "workspaceGit.list" ? { worktrees: [worktree("session-1")] } : { jobId: "job" }) as T;
      },
    };
    const git = createWorkspaceGit({ getHost: () => host, workspacesRoot: ROOT, proxy });
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    await git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await git.push(session, owner);
    // The proxy rotates without this module asking, e.g. another connection
    // of the same installation set a new token through a second instance.
    proxy.setToken(INSTALLATION, "rotated-fixture-token");
    await git.push(session, owner);
    const url = (calls.filter((call) => call.method === "workspaceGit.push").at(-1)!.params.gitProxy as { url: string }).url;
    expect(await fetchStatus(url)).toBe(200);
  });
});
