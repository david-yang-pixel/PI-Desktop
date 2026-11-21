import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createIdleWorkspaceReclaimer, idleSince } = await import("../electron/main/remote/idle-workspace-reclaimer.ts");
const { createSessionWorkspaces } = await import("../electron/main/remote/session-workspaces.ts");

const now = Date.parse("2026-11-21T12:00:00Z");
const old = "2026-11-17T12:00:00Z";
const reclaimedAt = new Date(now).toISOString();
const commit = "a".repeat(40);
const env = { id: "env", name: "Build", hostKey: "host", idleReclaimHours: 72, regenerableDirs: ["dist"], setupScript: "make deps", variables: [] };
const session = { sessionId: "s1", environmentId: env.id, hostKey: env.hostKey, state: "ready", repository: { owner: "octo", name: "repo" },
  baseBranch: "main", workBranch: "pi-desktop/abc", path: "/work/s1", lastActivityAt: old, updatedAt: old };
const worktree = { sessionId: session.sessionId, repository: session.repository, workBranch: session.workBranch, path: session.path, setup: { status: "ok" } };
const retained = { ...worktree, checkoutPresent: false, reclaimedAt, reclaimedCommit: commit };
const refusal = { reclaimed: false, reason: "protectedIgnoredFiles", protectedIgnoredFiles: 1, uncommittedFiles: 0, unpushedCommits: 0 };

function fixture() {
  let bound = { ...session };
  let remote = { ...worktree, checkoutPresent: true };
  let queued = false;
  let loseReply = false;
  let failSetup = false;
  const events = [];
  const prepareCalls = [];
  const expected = new Set();
  const workspaces = createSessionWorkspaces({
    async call(method, params) {
      switch (method) {
        case "sessionWorkspace.get": return { binding: { ...bound } };
        case "sessionWorkspace.list": return { bindings: params.states?.includes(bound.state) ? [{ ...bound }] : [] };
        case "sessionWorkspace.update": {
          if (params.expectedState) assert.equal(bound.state, params.expectedState);
          bound = { ...bound, ...params.patch };
          expected.add(bound.state);
          return { binding: { ...bound } };
        }
        case "environments.list": return { environments: [env] };
        default: assert.fail(method);
      }
    },
    hosts: () => ({
      list: async () => [{ hostKey: env.hostKey, connected: true }],
      workspaceGit: {
        list: async () => [remote],
        status: async () => ({ worktree: remote }),
        async reclaim() {
          remote = retained;
          if (loseReply) throw Object.assign(new Error("lost reply"), { code: "TIMEOUT" });
          return { reclaimed: true, reclaimedAt, commit };
        },
        async prepare(_hostKey, input) {
          prepareCalls.push(input);
          return { jobId: `job-${prepareCalls.length}` };
        },
        async job() {
          if (failSetup) {
            remote = { ...retained, checkoutPresent: true, setup: { status: "failed", logTail: "Build setup failed" } };
            return { kind: "prepare", state: "failed", worktree: remote, error: { code: "WORKSPACE_GIT_SETUP_FAILED", message: "Setup failed" } };
          }
          remote = { ...worktree, checkoutPresent: true };
          return { kind: "prepare", state: "succeeded", worktree: remote };
        },
      },
    }),
    connector: { status: async () => ({ connected: true }) },
    emit(channel, payload) { if (channel === IPC.event.remoteSessionWorkspaceChanged) events.push(payload.remoteRepository); },
    hasQueuedPrompt: () => queued,
    log(message, error) { assert.fail(`${message}: ${error}`); },
  });
  return { workspaces, events, prepareCalls, expected, current: () => bound, setQueued: () => { queued = true; },
    setLoseReply: () => { loseReply = true; }, setFailSetup: (fail) => { failSetup = fail; } };
}

test("idle age comes from last use, honors the environment setting, and treats history reads as irrelevant", () => {
  assert.equal(idleSince(session, env, now), Date.parse(old));
  assert.equal(idleSince({ ...session, lastActivityAt: undefined }, env, now), Date.parse(old));
  assert.equal(idleSince({ ...session, lastActivityAt: reclaimedAt }, env, now), undefined);
  assert.equal(idleSince(session, { ...env, idleReclaimHours: 0 }, now), undefined);
  assert.equal(idleSince(session, { ...env, idleReclaimHours: 120 }, now), undefined);
});

test("coalesces checks for one host and stops selecting candidates after it disconnects", async (t) => {
  let connected = true;
  let release;
  let started;
  const reached = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const reclaimer = createIdleWorkspaceReclaimer({
    now: () => now,
    connectedHosts: async () => [env.hostKey], supported: () => connected,
    environments: async () => [env],
    bindings: async () => [{ ...session, sessionId: "recent", lastActivityAt: reclaimedAt }, session, { ...session, sessionId: "s2" }],
    async reclaim(candidate) { calls.push(candidate.sessionId); started(); await gate; return refusal; },
    log: (message) => assert.fail(message),
  });
  t.after(() => reclaimer.dispose());
  const first = reclaimer.check(env.hostKey);
  assert.equal(reclaimer.check(env.hostKey), first);
  await reached;
  connected = false;
  release();
  await first;
  assert.deepEqual(calls, ["s1"]);
  connected = true;
  await reclaimer.check(env.hostKey);
  assert.deepEqual(calls, ["s1", "s2"]);
});

test("a lost reclaim reply is reconciled on reconnect without restoring merely to open history", async (t) => {
  const f = fixture();
  t.after(() => f.workspaces.dispose());
  f.setLoseReply();
  await assert.rejects(f.workspaces.reclaim(session, env.regenerableDirs), /lost reply/);
  assert.equal(f.current().state, "reclaiming");
  await f.workspaces.resume(env.hostKey);
  assert.equal(f.current().state, "reclaimed");
  assert.equal((await f.workspaces.get(session.sessionId)).reclaimedCommit, commit);
  assert.deepEqual(f.prepareCalls, []);
});

test("a send wakes a reclaimed workspace and only publishes ready after setup succeeds", async (t) => {
  const f = fixture();
  t.after(() => f.workspaces.dispose());
  await f.workspaces.reclaim(session, env.regenerableDirs);
  f.setQueued();
  f.setFailSetup(true);
  await assert.rejects(f.workspaces.waitUntilReady(session.sessionId), (error) => error.errorCode === "REMOTE_WORKSPACE_NOT_READY");
  assert.equal(f.current().state, "failed");
  assert.equal(f.current().setup.logTail, "Build setup failed");
  assert.equal(f.events.some((event) => event.state === "ready"), false);
  assert.equal(f.prepareCalls[0].rebuild, true);
  assert.equal(f.prepareCalls[0].environment.setupScript, env.setupScript);
  f.setFailSetup(false);
  await f.workspaces.retry(session.sessionId);
  await f.workspaces.waitUntilReady(session.sessionId);
  assert.equal(f.events.filter((event) => event.state === "ready").length, 1);
  assert.equal(f.current().reclaimedCommit, null);
});
