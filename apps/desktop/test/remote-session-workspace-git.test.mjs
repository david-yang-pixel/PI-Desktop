import assert from "node:assert/strict";
import test from "node:test";
import { register, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { ErrorCodes } = await import("@pi-desktop/shared");
const { createWorkspaceGitBoot } = await import("../electron/main/remote/workspace-git-boot.ts");
const { createSessionWorkspaces } = await import("../electron/main/remote/session-workspaces.ts");
const { createSessionWorkspaceGit } = await import("../electron/main/remote/session-workspace-git.ts");

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const repository = { owner: "octo", name: "repo" };
const workBranch = "pi-desktop/abc123";
const worktreePath = "/w/worktrees/github.com/octo/repo/abc123";

// The errors a failed reconnect really produces. `ensureReady` reconnects a
// dropped host before every workspace-git call, so these are what an
// unreachable host looks like to the delete flow.
const connectFailures = {
  // ssh-transport `fail()`: the exit code is spread onto the error as `code`.
  ssh: () => Object.assign(new Error("ssh command failed with exit code 255: ssh: connect to host build.example port 22: Connection refused"), {
    errorCode: ErrorCodes.HOST_BOOTSTRAP_FAILED, command: "sh -s", code: 255,
    data: { command: "sh -s", code: 255 },
  }),
  // RACP client `connect()`: a RacpError carries the code as `code`.
  wss: () => Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), {
    name: "RacpError", code: ErrorCodes.REMOTE_CONNECTION_FAILED, retriable: true,
  }),
};

function readyWorktree(sessionId, extra = {}) {
  return {
    sessionId, repository, baseBranch: "main", workBranch, path: worktreePath,
    mainPath: "/w/repos/github.com/octo/repo", baseCommit: "a".repeat(40),
    createdAt: "2026-11-20T00:00:00.000Z", setup: { status: "none" }, checkoutPresent: true, ...extra,
  };
}

/** A host's RACP error as the desktop receives it (`errorFromObject`). */
function hostError(code, message, details) {
  return Object.assign(new Error(message), { name: "RacpError", code, ...(details ? { details: { details } } : {}) });
}

/**
 * Real session-workspaces + session-workspace-git + workspace-git-boot. Only
 * the two real external edges are faked: host-core's local RPC and the paired
 * Host's `workspace/git*` RACP surface (including its reconnect).
 */
function createFixture({ bindings = {}, worktrees = [], jobs = [], connector } = {}) {
  const store = new Map(Object.entries(bindings));
  const pendingRemovals = [];
  const events = [];
  const logs = [];
  const remote = {
    online: true,
    connectFailure: connectFailures.ssh,
    worktrees: new Map(worktrees.map((tree) => [tree.sessionId, tree])),
    jobs: new Map(jobs.map((job) => [job.jobId, { pollsAfterCancel: 0, ...job }])),
    requests: [],
    nextJob: 1,
    /** Sessions whose worktree the Host fails to remove or to read. */
    failRemove: new Set(),
    failStatus: new Set(),
  };
  const runningJob = (sessionId) => [...remote.jobs.values()].find((job) => job.sessionId === sessionId && job.state === "running");
  const wire = (job) => {
    const { sessionId: _sessionId, pollsAfterCancel: _polls, cancelRequested: _cancel, onCancelled: _discard, ...rest } = job;
    return rest;
  };
  const host = {
    adapter: {
      workspaceCapabilities: () => ({ workspaceGit: true, workspaceGitSafeRemoval: true }),
      client: {
        async request(method, params) {
          remote.requests.push({ method, params });
          switch (method) {
            case "workspace/gitPrepare": {
              const busy = runningJob(params.sessionId);
              if (busy) throw hostError(ErrorCodes.WORKSPACE_GIT_BUSY, "the worktree is in use", { jobId: busy.jobId });
              const jobId = `job-${remote.nextJob++}`;
              remote.jobs.set(jobId, { jobId, sessionId: params.sessionId, kind: "prepare", state: "running", phase: "cloning", pollsAfterCancel: 0 });
              return { jobId };
            }
            case "workspace/gitJob": {
              const job = remote.jobs.get(params.jobId);
              if (!job) throw hostError(ErrorCodes.WORKSPACE_GIT_JOB_NOT_FOUND, "no such job");
              if (job.cancelRequested && job.state === "running") {
                if (job.pollsAfterCancel > 0) job.pollsAfterCancel -= 1;
                else {
                  job.state = "cancelled";
                  job.onCancelled?.();
                }
              }
              return wire(job);
            }
            case "workspace/gitJobCancel": {
              const job = remote.jobs.get(params.jobId);
              if (!job) throw hostError(ErrorCodes.WORKSPACE_GIT_JOB_NOT_FOUND, "no such job");
              // The Host's own bounded wait has expired: the job is signalled
              // but still running until it finishes cleaning up.
              if (job.state === "running") job.cancelRequested = true;
              return { ok: true };
            }
            case "workspace/gitRemove": {
              if (remote.failRemove.has(params.sessionId)) throw hostError(ErrorCodes.WORKSPACE_GIT_FAILED, "git worktree remove failed");
              // The connection drops before the reply arrives.
              if (remote.dropOnRemove) { remote.online = false; remote.connectFailure = null; return { removed: false }; }
              const busy = runningJob(params.sessionId);
              if (busy) throw hostError(ErrorCodes.WORKSPACE_GIT_BUSY, "the worktree is in use", { jobId: busy.jobId });
              const tree = remote.worktrees.get(params.sessionId);
              if (!tree) throw hostError(ErrorCodes.WORKSPACE_GIT_NOT_FOUND, "no such worktree");
              const dirty = tree.uncommittedFiles || tree.unpushedCommits;
              if (dirty && !params.force) return { removed: false, uncommittedFiles: tree.uncommittedFiles ?? 0, unpushedCommits: tree.unpushedCommits ?? 0 };
              remote.worktrees.delete(params.sessionId);
              return { removed: true, uncommittedFiles: 0, unpushedCommits: 0 };
            }
            case "workspace/gitStatus": {
              if (remote.failStatus.has(params.sessionId)) throw hostError(ErrorCodes.WORKSPACE_GIT_FAILED, "git status failed");
              const tree = remote.worktrees.get(params.sessionId);
              if (!tree) throw hostError(ErrorCodes.WORKSPACE_GIT_NOT_FOUND, "no such worktree");
              return { worktree: tree, ahead: tree.ahead ?? 0, behind: 0, aheadOfBase: tree.aheadOfBase ?? 0, pushedOnce: tree.pushedOnce ?? false,
                uncommittedFiles: tree.uncommittedFiles ?? 0, unpushedCommits: tree.unpushedCommits ?? 0 };
            }
            case "workspace/gitList":
              return { worktrees: [...remote.worktrees.values()] };
            case "workspace/gitCredentialSet":
            case "workspace/gitCredentialClear":
              return { ok: true };
            case "workspace/gitPush": {
              const jobId = `job-${remote.nextJob++}`;
              const tree = remote.worktrees.get(params.sessionId);
              const job = { jobId, sessionId: params.sessionId, kind: "push", state: "succeeded", phase: "done" };
              if (tree) tree.unpushedCommits = 0;
              remote.jobs.set(jobId, job);
              return { jobId };
            }
            default:
              throw new Error(`unexpected host request ${method}`);
          }
        },
      },
    },
  };
  const workspaceGit = createWorkspaceGitBoot({
    connectedHost: (hostKey) => (remote.online && hostKey === "h1" ? host : undefined),
    async ensureReady() {
      // `null`: the connection dropped and no reconnect has been attempted yet.
      if (!remote.online && remote.connectFailure) throw remote.connectFailure();
    },
    realign: async () => false,
    record: () => ({ url: "wss://build.example", metadata: {} }),
    getInstallationId: async () => INSTALLATION,
    log: () => {},
  });
  const call = async (method, params = {}) => {
    switch (method) {
      case "sessionWorkspace.get":
        return { binding: store.get(params.sessionId) ?? null };
      case "sessionWorkspace.update": {
        const current = store.get(params.sessionId);
        if (!current) throw Object.assign(new Error("binding not found"), { errorCode: "NOT_FOUND" });
        if (params.expectedState && current.state !== params.expectedState) {
          throw Object.assign(new Error("binding state changed"), { errorCode: ErrorCodes.CONFLICT });
        }
        const next = { ...current, ...params.patch };
        store.set(params.sessionId, next);
        return { binding: next };
      }
      case "sessionWorkspace.list":
        return { bindings: [...store.values()].filter((item) => !params.states || params.states.includes(item.state)) };
      case "sessionWorkspace.pendingRemoval.add":
        pendingRemovals.push(params);
        return { ok: true };
      case "sessionWorkspace.pendingRemoval.list":
        return { removals: pendingRemovals.filter((item) => item.hostKey === params.hostKey) };
      case "sessionWorkspace.pendingRemoval.remove": {
        const index = pendingRemovals.findIndex((item) => item.hostKey === params.hostKey && item.sessionId === params.sessionId);
        if (index >= 0) pendingRemovals.splice(index, 1);
        return { ok: true };
      }
      case "environments.list":
        return { environments: [{ id: "env-1", name: "Dev", hostKey: "h1", setupScript: "", variables: [] }] };
      default:
        throw new Error(`unexpected host-core call ${method}`);
    }
  };
  const workspaces = createSessionWorkspaces({
    call,
    hosts: () => ({
      async list() { return [{ hostKey: "h1", label: "Build host", connected: remote.online }]; },
      workspaceGit,
    }),
    connector: { async status() { return { connected: true }; } },
    emit: (channel, payload) => events.push({ channel, payload }),
    log: (message, error) => logs.push(`${message}: ${error}`),
  });
  const git = createSessionWorkspaceGit({
    call, workspaces, emit: (channel, payload) => events.push({ channel, payload }),
    connector: connector ?? { findPullRequest: async () => null, createPullRequest: async () => { throw new Error("unused"); } },
    log: (message, error) => logs.push(`${message}: ${error}`),
  });
  return {
    workspaces, git, store, remote, pendingRemovals, events, logs,
    /** What session-ipc does once `beforeDelete` resolves. */
    deleteSession: (sessionId) => store.delete(sessionId),
    removeRequests: () => remote.requests.filter((entry) => entry.method === "workspace/gitRemove"),
  };
}

function binding(sessionId, extra = {}) {
  return { sessionId, environmentId: "env-1", hostKey: "h1", repository, baseBranch: "main", state: "ready",
    workBranch, path: worktreePath, ...extra };
}

/**
 * Put `setTimeout` (including `node:timers/promises`) and `Date` on a virtual
 * clock. The main-process modules were imported before the mock existed, so
 * their ESM bindings are re-synced on enable and again on restore.
 */
function useVirtualClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
}

/**
 * Drive the monitor's and the delete flow's waits on a virtual clock until
 * `promise` settles. All fakes resolve as promises, so one macrotask turn
 * drains every pending reaction before the clock moves.
 */
async function settle(t, promise, { stepMs = 250, limitMs = 180_000 } = {}) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let elapsed = 0; elapsed <= limitMs; elapsed += stepMs) {
    await new Promise((resolve) => setImmediate(resolve));
    if (done) return promise;
    t.mock.timers.tick(stepMs);
  }
  throw new Error(`did not settle within ${limitMs} virtual ms`);
}

async function until(t, read, description, { stepMs = 250, limitMs = 180_000 } = {}) {
  for (let elapsed = 0; elapsed <= limitMs; elapsed += stepMs) {
    await new Promise((resolve) => setImmediate(resolve));
    const value = read();
    if (value) return value;
    t.mock.timers.tick(stepMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

for (const [transport, failure] of Object.entries(connectFailures)) {
  test(`offline delete over ${transport} records a pending removal only after the confirmed warning`, async (t) => {
    useVirtualClock(t);
    const f = createFixture({
      bindings: { "s-1": binding("s-1") },
      worktrees: [readyWorktree("s-1", { unpushedCommits: 1 })],
    });
    f.remote.online = false;
    f.remote.connectFailure = failure;

    assert.deepEqual(await f.git.status("s-1"), { reachable: false, workBranch, baseBranch: "main" });
    // The renderer shows the "cannot check unpushed work" warning for this.
    assert.deepEqual(await f.git.preflight("s-1"), { kind: "unknown" });

    // Without the user's confirmation nothing is recorded and the session stays.
    const expected = failure();
    await assert.rejects(f.git.beforeDelete("s-1", false), (error) => (error.errorCode ?? error.code) === (expected.errorCode ?? expected.code));
    assert.deepEqual(f.pendingRemovals, []);

    await f.git.beforeDelete("s-1", true);
    assert.deepEqual(f.pendingRemovals, [{ sessionId: "s-1", hostKey: "h1", repository, workBranch }]);
    assert.equal(f.removeRequests().length, 0, "nothing reached the unreachable host");
    assert.ok(f.remote.worktrees.has("s-1"), "the worktree is left for the next connection");
  });
}

for (const phase of ["cloning", "runningSetup"]) {
  test(`reconnecting after an offline delete during ${phase} stops the job and finishes the removal`, async (t) => {
    useVirtualClock(t);
    const f = createFixture({
      bindings: { "s-1": binding("s-1", { state: "preparing", workBranch: undefined, path: undefined, jobId: "job-7" }) },
      // While cloning the worktree does not exist yet; during setup the Host lists it.
      worktrees: phase === "runningSetup" ? [readyWorktree("s-1", { setup: { status: "running" } })] : [],
      jobs: [{ jobId: "job-7", sessionId: "s-1", kind: "prepare", state: "running", phase, pollsAfterCancel: 1,
        // A cancelled prepare discards the worktree it created.
        onCancelled: () => f.remote.worktrees.delete("s-1") }],
    });
    f.remote.online = false;
    assert.deepEqual(await f.git.preflight("s-1"), { kind: "unknown" });
    await settle(t, f.git.beforeDelete("s-1", true));
    f.deleteSession("s-1");
    assert.equal(f.pendingRemovals.length, 1);
    assert.equal(f.remote.jobs.get("job-7").state, "running", "nothing can stop the job while the Host is away");

    f.remote.online = true;
    await settle(t, f.git.reconcile("h1"));
    assert.equal(f.remote.jobs.get("job-7").state, "cancelled", "the deleted session's job is stopped");
    assert.equal(f.remote.worktrees.has("s-1"), false);
    assert.deepEqual(f.pendingRemovals, []);
  });
}

test("a pending removal whose job will not stop stays pending without blocking reconciliation", async (t) => {
  useVirtualClock(t);
  const f = createFixture({
    worktrees: [readyWorktree("s-1", { setup: { status: "running" } }), readyWorktree("s-2", { workBranch: "pi-desktop/def456" })],
    jobs: [{ jobId: "job-7", sessionId: "s-1", kind: "prepare", state: "running", phase: "runningSetup",
      pollsAfterCancel: Number.POSITIVE_INFINITY }],
  });
  f.pendingRemovals.push({ sessionId: "s-1", hostKey: "h1", repository },
    { sessionId: "s-2", hostKey: "h1", repository, workBranch: "pi-desktop/def456" });

  await settle(t, f.git.reconcile("h1"));
  assert.deepEqual(f.pendingRemovals.map((item) => item.sessionId), ["s-1"], "retried on the next connection");
  assert.equal(f.remote.worktrees.has("s-2"), false, "later removals still run");
});

test("deleting during prepare waits for the cancelled job to stop before removing the worktree", async (t) => {
  useVirtualClock(t);
  const f = createFixture({ bindings: { "s-1": binding("s-1", { state: "preparing", workBranch: undefined, path: undefined }) } });
  f.workspaces.resume();
  const job = await until(t, () => f.store.get("s-1").jobId && f.remote.jobs.get(f.store.get("s-1").jobId), "the prepare job");
  assert.equal(job.state, "running");
  // The Host stops the job only after its own cancel wait has expired.
  job.pollsAfterCancel = 3;

  // No worktree exists yet, so the renderer deletes without a warning.
  assert.deepEqual(await f.git.preflight("s-1"), { kind: "none" });
  await settle(t, f.git.beforeDelete("s-1", false));
  f.deleteSession("s-1");

  assert.equal(job.state, "cancelled");
  const cancelIndex = f.remote.requests.findIndex((entry) => entry.method === "workspace/gitJobCancel");
  const removeIndex = f.remote.requests.findIndex((entry) => entry.method === "workspace/gitRemove");
  assert.ok(cancelIndex >= 0 && removeIndex > cancelIndex, "the worktree is removed after the job was cancelled");
  const lastPoll = f.remote.requests.findLastIndex((entry) => entry.method === "workspace/gitJob");
  assert.ok(lastPoll < removeIndex, "removal waits until the job is no longer running");
  assert.deepEqual(f.pendingRemovals, []);
});

test("deleting during prepare cancels a host job the binding never learned about", async (t) => {
  useVirtualClock(t);
  // The prepare reply was lost: the Host runs a job the desktop has no id for.
  const f = createFixture({
    bindings: { "s-1": binding("s-1", { state: "preparing", workBranch: undefined, path: undefined, jobId: null }) },
    jobs: [{ jobId: "job-lost", sessionId: "s-1", kind: "prepare", state: "running", phase: "cloning", pollsAfterCancel: 1 }],
  });

  await settle(t, f.git.beforeDelete("s-1", false));

  assert.equal(f.remote.jobs.get("job-lost").state, "cancelled");
  assert.ok(f.remote.requests.some((entry) => entry.method === "workspace/gitJobCancel" && entry.params.jobId === "job-lost"));
});

test("a delete that cannot stop the prepare job keeps the session recoverable", async (t) => {
  useVirtualClock(t);
  const f = createFixture({ bindings: { "s-1": binding("s-1", { state: "preparing", workBranch: undefined, path: undefined }) } });
  f.workspaces.resume();
  const job = await until(t, () => f.store.get("s-1").jobId && f.remote.jobs.get(f.store.get("s-1").jobId), "the prepare job");
  job.pollsAfterCancel = Number.POSITIVE_INFINITY;

  await assert.rejects(settle(t, f.git.beforeDelete("s-1", false)), (error) => (error.errorCode ?? error.code) === ErrorCodes.WORKSPACE_GIT_BUSY);
  assert.equal(f.store.get("s-1").state, "preparing");

  // The job finally stops. The binding must not stay "preparing" with
  // nothing watching it: it settles to a state the user can act on.
  job.pollsAfterCancel = 0;
  await until(t, () => f.store.get("s-1").state === "failed", "the binding to become retryable");
  await settle(t, f.git.beforeDelete("s-1", false));
  f.deleteSession("s-1");
  assert.equal(f.store.has("s-1"), false);
});

test("a monitor that lost its host marks the workspace retryable and resumes when the host reconnects", async (t) => {
  useVirtualClock(t);
  const f = createFixture({ bindings: { "s-1": binding("s-1", { state: "preparing", workBranch: undefined, path: undefined }) } });
  f.workspaces.resume();
  const job = await until(t, () => f.store.get("s-1").jobId && f.remote.jobs.get(f.store.get("s-1").jobId), "the prepare job");

  // The connection drops mid-poll: workspace-git-boot answers AGENT_UNAVAILABLE.
  f.remote.connectFailure = null;
  f.remote.online = false;
  const offline = await until(t, () => f.store.get("s-1").state === "failed" && f.store.get("s-1"), "the offline binding to be surfaced");
  assert.equal(offline.error.code, ErrorCodes.REMOTE_TARGET_HOST_OFFLINE);
  assert.equal(offline.jobId, job.jobId, "the host job id is kept for the resume");
  assert.ok(f.events.some(({ payload }) => payload.remoteRepository?.state === "failed"
    && payload.remoteRepository.error?.code === ErrorCodes.REMOTE_TARGET_HOST_OFFLINE), "the renderer is told");

  // Reconnect: remote-hosts calls resume(hostKey) from its connect handler.
  f.remote.online = true;
  job.state = "succeeded";
  job.phase = "done";
  job.worktree = readyWorktree("s-1");
  await settle(t, f.workspaces.resume("h1"));
  await until(t, () => f.store.get("s-1").state === "ready", "the resumed binding to become ready");
  assert.equal(f.store.get("s-1").path, worktreePath);
  assert.equal(f.store.get("s-1").error, null);
  assert.equal(f.remote.requests.filter((entry) => entry.method === "workspace/gitPrepare").length, 1, "the resume polls the same job");
  f.workspaces.dispose();
});

test("a monitor whose reconnect fails resumes on the next connection", async (t) => {
  useVirtualClock(t);
  const f = createFixture({ bindings: { "s-1": binding("s-1", { state: "preparing", workBranch: undefined, path: undefined, jobId: "job-9" }) },
    jobs: [{ jobId: "job-9", sessionId: "s-1", kind: "prepare", state: "running", phase: "cloning" }] });
  f.remote.online = false;
  f.remote.connectFailure = connectFailures.ssh;
  f.workspaces.resume();
  const offline = await until(t, () => f.store.get("s-1").state === "failed" && f.store.get("s-1"), "the offline binding");
  assert.equal(offline.error.code, ErrorCodes.REMOTE_TARGET_HOST_OFFLINE);

  f.remote.online = true;
  Object.assign(f.remote.jobs.get("job-9"), { state: "succeeded", phase: "done", worktree: readyWorktree("s-1") });
  await settle(t, f.workspaces.resume("h1"));
  await until(t, () => f.store.get("s-1").state === "ready", "the binding to become ready");
  f.workspaces.dispose();
});

// ---- pull requests ---------------------------------------------------------

const pullRequestUrl = (number) => `https://github.com/octo/repo/pull/${number}`;
const summary = (number, state, extra = {}) => ({ number, url: pullRequestUrl(number), title: `PR ${number}`, draft: false,
  state, head: workBranch, base: "main", ...extra });

/** A GitHub connector double that records every lookup's arguments. */
function gitHub({ found = null, create } = {}) {
  const lookups = [];
  const created = [];
  return {
    lookups, created, found,
    async findPullRequest(...args) { lookups.push(args); return typeof this.found === "function" ? this.found() : this.found; },
    async createPullRequest(repository, input) {
      created.push(input);
      if (create) return create(input);
      return summary(created.length + 1, "open", { title: input.title, draft: input.draft });
    },
  };
}

test("a merged pull request stays linked with its state instead of being forgotten", async () => {
  const connector = gitHub({ found: summary(1, "merged") });
  const f = createFixture({ bindings: { "s-1": binding("s-1", { pullRequest: { number: 1, url: pullRequestUrl(1) } }) }, connector });

  assert.equal((await f.git.find("s-1")).state, "merged");
  // Every state is asked for: an open-only lookup cannot see a merged request.
  assert.deepEqual(connector.lookups, [[repository, workBranch]]);
  assert.deepEqual(f.store.get("s-1").pullRequest, { number: 1, url: pullRequestUrl(1), state: "merged", draft: false });
  assert.deepEqual(f.events.at(-1).payload.remoteRepository.pullRequest, { number: 1, url: pullRequestUrl(1), state: "merged", draft: false });

  // An empty answer cannot prove the request is gone: the link stays.
  connector.found = null;
  assert.equal(await f.git.find("s-1"), null);
  assert.deepEqual(f.store.get("s-1").pullRequest, { number: 1, url: pullRequestUrl(1), state: "merged", draft: false });
});

test("a pull request request opens a new one after the last was merged and new commits exist", async () => {
  const connector = gitHub({ found: summary(1, "merged") });
  const f = createFixture({
    bindings: { "s-1": binding("s-1", { pullRequest: { number: 1, url: pullRequestUrl(1), state: "open", draft: false } }) },
    worktrees: [readyWorktree("s-1", { aheadOfBase: 2, pushedOnce: true })],
    connector,
  });

  const created = await f.git.create("s-1", { title: "Follow-up", body: "", draft: true });
  assert.equal(created.number, 2);
  assert.deepEqual(connector.created, [{ title: "Follow-up", body: "", draft: true, head: workBranch, base: "main" }]);
  assert.deepEqual(f.store.get("s-1").pullRequest, { number: 2, url: pullRequestUrl(2), state: "open", draft: true });
});

test("an open pull request answers the call, and a refused create never returns the merged one", async () => {
  const open = gitHub({ found: summary(4, "open") });
  const reuse = createFixture({ bindings: { "s-1": binding("s-1") }, worktrees: [readyWorktree("s-1", { aheadOfBase: 1, pushedOnce: true })], connector: open });
  assert.equal((await reuse.git.create("s-1", { title: "Again", body: "", draft: false })).number, 4);
  assert.deepEqual(open.created, []);

  const refused = gitHub({ found: summary(1, "merged"), create: () => {
    throw Object.assign(new Error("GitHub rejected the request (422). No commits between main and pi-desktop/abc123"), { errorCode: ErrorCodes.GITHUB_VALIDATION_FAILED });
  } });
  const f = createFixture({ bindings: { "s-1": binding("s-1") }, worktrees: [readyWorktree("s-1", { aheadOfBase: 1, pushedOnce: true })], connector: refused });
  await assert.rejects(f.git.create("s-1", { title: "Nothing new", body: "", draft: false }),
    (error) => error.errorCode === ErrorCodes.GITHUB_VALIDATION_FAILED);
  assert.deepEqual(f.store.get("s-1").pullRequest, { number: 1, url: pullRequestUrl(1), state: "merged", draft: false });
});

test("using a session refreshes its pull request state at most once per interval and never after a merge", async (t) => {
  useVirtualClock(t);
  const connector = gitHub({ found: summary(3, "open") });
  const f = createFixture({ bindings: { "s-1": binding("s-1", { pullRequest: { number: 3, url: pullRequestUrl(3) } }) }, connector });

  await f.git.refreshPullRequest("s-1");
  await f.git.refreshPullRequest("s-1");
  assert.equal(connector.lookups.length, 1);
  assert.equal(f.store.get("s-1").pullRequest.state, "open");

  t.mock.timers.tick(5 * 60 * 1_000);
  connector.found = summary(3, "merged");
  await f.git.refreshPullRequest("s-1");
  assert.equal(connector.lookups.length, 2);
  assert.equal(f.store.get("s-1").pullRequest.state, "merged");

  t.mock.timers.tick(60 * 60 * 1_000);
  await f.git.refreshPullRequest("s-1");
  assert.equal(connector.lookups.length, 2, "a merged pull request is final");

  // A failed lookup is logged, never thrown into the launch that asked.
  const failing = gitHub({ found: () => { throw new Error("GitHub is unavailable"); } });
  const g = createFixture({ bindings: { "s-2": binding("s-2") }, connector: failing });
  await g.git.refreshPullRequest("s-2");
  assert.match(g.logs.join("\n"), /Could not refresh the session's pull request/);
});

// ---- one bad worktree -------------------------------------------------------

const OLD = "2026-01-01T00:00:00.000Z";

test("one worktree that cannot be removed does not stop reconciling the others", async () => {
  const f = createFixture({
    worktrees: [
      readyWorktree("s-1"), readyWorktree("s-2", { workBranch: "pi-desktop/def456" }),
      readyWorktree("orphan-1", { createdAt: OLD }), readyWorktree("orphan-2", { createdAt: OLD }),
    ],
  });
  f.pendingRemovals.push({ sessionId: "s-1", hostKey: "h1", repository, workBranch },
    { sessionId: "s-2", hostKey: "h1", repository, workBranch: "pi-desktop/def456" });
  f.remote.failRemove.add("s-1");
  f.remote.failRemove.add("orphan-1");

  await f.git.reconcile("h1");
  assert.deepEqual(f.pendingRemovals.map((item) => item.sessionId), ["s-1"], "the failed removal is retried on the next connection");
  assert.equal(f.remote.worktrees.has("s-2"), false, "a later pending removal still runs");
  assert.equal(f.remote.worktrees.has("orphan-1"), true);
  assert.equal(f.remote.worktrees.has("orphan-2"), false, "a later orphan is still removed");
  assert.match(f.logs.join("\n"), /Could not remove a deleted session's worktree/);
  assert.match(f.logs.join("\n"), /Could not remove an orphaned worktree/);
});

test("a host that drops mid-reconcile ends the pass instead of failing every worktree", async () => {
  const f = createFixture({ worktrees: [readyWorktree("s-1"), readyWorktree("s-2", { workBranch: "pi-desktop/def456" })] });
  f.pendingRemovals.push({ sessionId: "s-1", hostKey: "h1", repository, workBranch },
    { sessionId: "s-2", hostKey: "h1", repository, workBranch: "pi-desktop/def456" });
  f.remote.dropOnRemove = true;
  await assert.rejects(f.git.reconcile("h1"), (error) => error.errorCode === "AGENT_UNAVAILABLE");
  assert.equal(f.removeRequests().length, 1, "nothing more is sent to a host that is gone");
  assert.equal(f.pendingRemovals.length, 2, "both removals wait for the next connection");
});

test("leftover worktrees stay listed when one of them cannot be read", async () => {
  const f = createFixture({ worktrees: [readyWorktree("gone-1"), readyWorktree("gone-2", { uncommittedFiles: 2 })] });
  f.remote.failStatus.add("gone-1");
  const leftovers = await f.git.leftovers("h1");
  assert.deepEqual(leftovers.map((item) => [item.sessionId, item.uncommittedFiles]), [["gone-2", 2]]);
  assert.match(f.logs.join("\n"), /Could not read a leftover worktree's status/);

  // An unreachable Host cannot give a trustworthy list at all.
  f.remote.online = false;
  await assert.rejects(f.git.leftovers("h1"));
});

test("a reconnect that fails for one workspace still recovers the others", async (t) => {
  useVirtualClock(t);
  const f = createFixture({
    bindings: {
      "s-1": binding("s-1", { state: "reclaiming" }),
      "s-2": binding("s-2", { state: "reclaiming" }),
    },
    worktrees: [readyWorktree("s-1"), readyWorktree("s-2")],
  });
  f.remote.failStatus.add("s-1");
  await settle(t, f.workspaces.resume("h1"));
  assert.equal(f.store.get("s-1").state, "reclaiming");
  assert.equal(f.store.get("s-2").state, "ready", "the second workspace is settled despite the first failure");
  assert.match(f.logs.join("\n"), /Could not check a repository workspace on reconnect/);
});

// ---- least privilege ---------------------------------------------------------

test("only a ready repository session's commands hand its host the credential", async () => {
  const f = createFixture({
    bindings: { "s-1": binding("s-1"), "s-2": binding("s-2", { state: "preparing", workBranch: undefined, path: undefined }) },
  });
  f.workspaces.git().setCredentialProvider(async () => "fixture-token-not-a-real-credential");
  const sets = () => f.remote.requests.filter((entry) => entry.method === "workspace/gitCredentialSet").length;

  // Reads and edits never run git; a folder session or a session still
  // preparing gets nothing either.
  await f.workspaces.prepareTool({ sessionId: "s-1", hostKey: "h1", toolName: "Read" });
  await f.workspaces.prepareTool({ sessionId: "folder-session", hostKey: "h1", toolName: "Bash" });
  await f.workspaces.prepareTool({ sessionId: "s-2", hostKey: "h1", toolName: "Bash" });
  await f.workspaces.prepareTool({ sessionId: "s-1", hostKey: "other-host", toolName: "Bash" });
  assert.equal(sets(), 0);

  await f.workspaces.prepareTool({ sessionId: "s-1", hostKey: "h1", toolName: "Bash" });
  await f.workspaces.prepareTool({ sessionId: "s-1", hostKey: "h1", toolName: "Bash" });
  assert.equal(sets(), 1, "delivered once, then held by the connection");
});

test("a push asks the Host for a force-with-lease only when the caller does", async () => {
  const f = createFixture({
    bindings: { "s-1": binding("s-1") },
    worktrees: [readyWorktree("s-1", { unpushedCommits: 1, aheadOfBase: 1 })],
  });
  await f.git.push("s-1");
  f.remote.worktrees.get("s-1").unpushedCommits = 1;
  await f.git.push("s-1", undefined, { forceWithLease: true });
  const pushes = f.remote.requests.filter((entry) => entry.method === "workspace/gitPush").map((entry) => entry.params);
  assert.deepEqual(pushes, [
    { installationId: INSTALLATION, sessionId: "s-1" },
    { installationId: INSTALLATION, sessionId: "s-1", forceWithLease: true },
  ]);
});
