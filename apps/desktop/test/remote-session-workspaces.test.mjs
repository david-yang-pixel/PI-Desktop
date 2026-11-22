import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { ErrorCodes, IPC } = await import("@pi-desktop/shared");
const { createSessionWorkspaces } = await import("../electron/main/remote/session-workspaces.ts");

const { createSessionWorkspaceGit } = await import("../electron/main/remote/session-workspace-git.ts");

const repository = { owner: "octo", name: "repo" };

function createFixture(options = {}) {
  const bindings = new Map(Object.entries(options.bindings ?? {}));
  let storedEnvironments = [...(options.environments ?? [
    {
      id: "env-1",
      name: "Dev",
      hostKey: "h1",
      setupScript: "npm ci",
      variables: [{ name: "NODE_ENV", value: "development" }],
    },
  ])];
  const events = [];
  const prepareCalls = [];
  const jobResponses = [...(options.jobResponses ?? [])];
  let jobCounter = 0;

  const workspaceGit = {
    async prepare(hostKey, input) {
      prepareCalls.push({ hostKey, input });
      jobCounter += 1;
      return { jobId: `job-${jobCounter}` };
    },
    async job(_hostKey, jobId) {
      const next = jobResponses.shift();
      if (!next) throw new Error(`unexpected job poll for ${jobId}`);
      return typeof next === "function" ? next(jobId) : next;
    },
    async cancelJob() {},
    async list() { return []; },
    ...options.workspaceGit,
  };

  const workspaces = createSessionWorkspaces({
    async call(method, params = {}) {
      switch (method) {
        case "sessionWorkspace.get":
          return { binding: bindings.get(params.sessionId) ?? null };
        case "sessionWorkspace.update": {
          const current = bindings.get(params.sessionId);
          if (!current) throw new Error(`missing binding ${params.sessionId}`);
          const next = { ...current, ...params.patch };
          bindings.set(params.sessionId, next);
          return { binding: next };
        }
        case "sessionWorkspace.list":
          return { bindings: [...bindings.values()] };
        case "environments.list":
          return { environments: storedEnvironments };
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
    hosts: () => ({
      async list() {
        return [{ hostKey: "h1", label: "Build host", connected: true }];
      },
      workspaceGit,
    }),
    connector: {
      async status() { return { connected: true, needsReauthentication: false }; },
    },
    emit(channel, payload) {
      events.push({ channel, payload });
    },
    log(message, error) {
      throw new Error(`${message}: ${error}`);
    },
  });

  return {
    workspaces,
    bindings,
    events,
    prepareCalls,
    setEnvironments(next) { storedEnvironments = next; },
  };
}

test("retry on failed setup reruns setup with latest environment and streams live setupLogTail", async () => {
  const worktree = {
    sessionId: "s-1",
    repository,
    baseBranch: "main",
    workBranch: "pi-desktop/abc123",
    path: "/w/worktrees/github.com/octo/repo/abc123",
    mainPath: "/w/repos/github.com/octo/repo",
    baseCommit: "a".repeat(40),
    createdAt: "2026-11-20T00:00:00.000Z",
    setup: { status: "ok", logTail: "step 1\nstep 2\ndone" },
  };
  const f = createFixture({
    bindings: {
      "s-1": {
        sessionId: "s-1",
        environmentId: "env-1",
        hostKey: "h1",
        repository,
        baseBranch: "main",
        workBranch: worktree.workBranch,
        path: worktree.path,
        state: "ready",
        setup: { status: "failed", logTail: "old error log" },
      },
    },
    jobResponses: [
      { jobId: "job-1", kind: "prepare", state: "running", phase: "runningSetup" },
      { jobId: "job-1", kind: "prepare", state: "running", phase: "runningSetup", setupLogTail: "step 1\n" },
      { jobId: "job-1", kind: "prepare", state: "running", phase: "runningSetup", setupLogTail: "step 1\nstep 2\n" },
      { jobId: "job-1", kind: "prepare", state: "succeeded", phase: "done", worktree },
    ],
  });

  try {
    const started = await f.workspaces.retry("s-1");
    assert.equal(started.state, "preparing");
    await f.workspaces.waitUntilReady("s-1");

    assert.equal(f.prepareCalls.length, 1);
    assert.deepEqual(f.prepareCalls[0], {
      hostKey: "h1",
      input: {
        sessionId: "s-1",
        repository,
        baseBranch: "main",
        rerunSetup: true,
        environment: {
          variables: [{ name: "NODE_ENV", value: "development" }],
          setupScript: "npm ci",
        },
      },
    });

    const workspaceEvents = f.events
      .filter((entry) => entry.channel === IPC.event.remoteSessionWorkspaceChanged)
      .map((entry) => entry.payload.remoteRepository);

    // During runningSetup before any output, stale failed log must not leak.
    const initialSetupEvent = workspaceEvents.find((item) => item.phase === "runningSetup" && !item.setup?.logTail);
    assert.ok(initialSetupEvent, "expected runningSetup phase event");
    assert.deepEqual(initialSetupEvent.setup, { status: "running" });

    // Live setupLogTail updates each emit a workspaceChanged event.
    const liveLogs = workspaceEvents
      .filter((item) => item.phase === "runningSetup" && item.setup?.logTail)
      .map((item) => item.setup);
    assert.deepEqual(liveLogs, [
      { status: "running", logTail: "step 1\n" },
      { status: "running", logTail: "step 1\nstep 2\n" },
    ]);

    const final = await f.workspaces.get("s-1");
    assert.equal(final?.state, "ready");
    assert.deepEqual(final?.setup, { status: "ok", logTail: "step 1\nstep 2\ndone" });
  } finally {
    f.workspaces.dispose();
  }
});

test("retry on failed setup falls back to omitting environment when deleted and rejects ok workspaces", async () => {
  const worktree = {
    sessionId: "s-2",
    repository,
    baseBranch: "main",
    workBranch: "pi-desktop/def456",
    path: "/w/worktrees/github.com/octo/repo/def456",
    mainPath: "/w/repos/github.com/octo/repo",
    baseCommit: "b".repeat(40),
    createdAt: "2026-11-20T00:00:00.000Z",
    setup: { status: "ok" },
  };
  const f = createFixture({
    environments: [],
    bindings: {
      "s-2": {
        sessionId: "s-2",
        environmentId: "deleted-env",
        hostKey: "h1",
        repository,
        baseBranch: "main",
        workBranch: worktree.workBranch,
        path: worktree.path,
        state: "ready",
        setup: { status: "failed", logTail: "boom" },
      },
    },
    jobResponses: [
      { jobId: "job-1", kind: "prepare", state: "succeeded", phase: "done", worktree },
    ],
  });

  try {
    await f.workspaces.retry("s-2");
    await f.workspaces.waitUntilReady("s-2");
    assert.deepEqual(f.prepareCalls[0], {
      hostKey: "h1",
      input: {
        sessionId: "s-2",
        repository,
        baseBranch: "main",
        rerunSetup: true,
      },
    });
    await assert.rejects(
      f.workspaces.retry("s-2"),
      (error) => error.errorCode === ErrorCodes.CONFLICT,
    );
  } finally {
    f.workspaces.dispose();
  }
});


test("the repository session reports Git percentages and clears its push progress on a lost Host connection", { timeout: 5_000 }, async () => {
  const events = [];
  const offline = new Error("Host disconnected");
  let polls = 0;
  const git = {
    status: async () => ({ worktree: {}, unpushedCommits: 1 }),
    push: async () => ({ jobId: "job-1" }),
    async job() {
      if (polls++) throw offline;
      return { kind: "push", state: "running", phase: "pushing", progress: { percent: 67 } };
    },
  };
  const service = createSessionWorkspaceGit({
    workspaces: {
      binding: async () => ({ sessionId: "s", state: "ready", hostKey: "h", workBranch: "work", baseBranch: "main" }),
      git: () => git,
    },
    emit(channel, payload) {
      assert.equal(channel, IPC.event.remoteSessionPushProgress);
      events.push(payload);
    },
  });
  // The production poll timer is unreferenced so it cannot hold Electron open.
  const keepAlive = setInterval(() => {}, 5_000);
  try {
    await assert.rejects(service.push("s"), (error) => error === offline);
  } finally {
    clearInterval(keepAlive);
  }
  assert.deepEqual(events, [
    { sessionId: "s", active: true, phase: "pushing", progress: { percent: 67 } },
    { sessionId: "s", active: false, phase: "done" },
  ]);
});

test("Cancel stops a preparing workspace's Host job and leaves it failed and retryable", { timeout: 10_000 }, async () => {
  const cancelled = [];
  let stopped = false;
  const f = createFixture({
    bindings: {
      "s-3": { sessionId: "s-3", environmentId: "env-1", hostKey: "h1", repository, baseBranch: "main", state: "preparing" },
    },
    workspaceGit: {
      async job(_hostKey, jobId) {
        return stopped
          ? { jobId, kind: "prepare", state: "cancelled", phase: "cloning" }
          : { jobId, kind: "prepare", state: "running", phase: "cloning", progress: { percent: 40 } };
      },
      async cancelJob(hostKey, jobId) {
        cancelled.push({ hostKey, jobId });
        stopped = true;
      },
    },
  });
  const workspaceEvents = () => f.events
    .filter((entry) => entry.channel === IPC.event.remoteSessionWorkspaceChanged)
    .map((entry) => entry.payload.remoteRepository);
  try {
    await f.workspaces.resume();
    const deadline = Date.now() + 5_000;
    while (!workspaceEvents().some((item) => item.phase === "cloning") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.bindings.get("s-3").jobId, "job-1");

    const [first, second] = await Promise.all([
      f.workspaces.cancelPreparation("s-3"),
      f.workspaces.cancelPreparation("s-3"),
    ]);

    assert.deepEqual(cancelled, [{ hostKey: "h1", jobId: "job-1" }], "a second Cancel joins the first");
    assert.equal(first, second);
    assert.equal(first.state, "failed");
    assert.equal(first.error.code, ErrorCodes.REMOTE_WORKSPACE_CANCELLED);
    assert.equal(first.phase, undefined);
    const stored = f.bindings.get("s-3");
    assert.equal(stored.state, "failed");
    assert.equal(stored.jobId, null);
    assert.equal(workspaceEvents().at(-1).state, "failed");
    await assert.rejects(f.workspaces.cancelPreparation("s-3"), (error) => error.errorCode === ErrorCodes.CONFLICT);

    // Retry prepares again with a new Host job.
    stopped = false;
    const retried = await f.workspaces.retry("s-3");
    assert.equal(retried.state, "preparing");
    const retryDeadline = Date.now() + 5_000;
    while (f.prepareCalls.length < 2 && Date.now() < retryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.prepareCalls.length, 2);
  } finally {
    f.workspaces.dispose();
  }
});

test("Cancel keeps a workspace whose Host job finished before the cancel reached it", { timeout: 10_000 }, async () => {
  const worktree = {
    sessionId: "s-4", repository, baseBranch: "main", workBranch: "pi-desktop/s4", path: "/w/worktrees/s4",
    mainPath: "/w/repos/octo/repo", baseCommit: "c".repeat(40), createdAt: "2026-11-20T00:00:00.000Z",
    setup: { status: "ok" },
  };
  const f = createFixture({
    bindings: {
      "s-4": { sessionId: "s-4", environmentId: "env-1", hostKey: "h1", repository, baseBranch: "main", state: "preparing", jobId: "job-9" },
    },
    workspaceGit: {
      async job(_hostKey, jobId) {
        return { jobId, kind: "prepare", state: "succeeded", phase: "done", worktree };
      },
    },
  });
  try {
    const result = await f.workspaces.cancelPreparation("s-4");
    assert.equal(result.state, "ready");
    assert.equal(result.workBranch, "pi-desktop/s4");
    assert.equal(f.bindings.get("s-4").path, "/w/worktrees/s4");
  } finally {
    f.workspaces.dispose();
  }
});
