import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { recoverRepositoryHost, recoverRepositorySessions } = await import("../electron/main/remote/repository-session-recovery.ts");
const { getRemoteRepositorySessions, recoverRemoteRepositorySessions, registerRemoteRepositorySessions } =
  await import("../electron/main/ipc/repository-session-ipc.ts");

const coded = (errorCode, message = errorCode) => Object.assign(new Error(message), { errorCode });

function sessions(fail = new Map()) {
  const calls = [];
  const step = (name) => async (...args) => {
    calls.push([name, ...args]);
    if (fail.has(name)) throw fail.get(name);
  };
  return {
    calls,
    workspaces: { announceEnvironments: step("environments"), resume: step("resume") },
    git: { reconcile: step("reconcile") },
    reclaimer: { check: step("reclaim") },
  };
}

test("a connect runs every recovery phase even when an earlier one fails", async () => {
  const logs = [];
  const recovery = sessions(new Map([["resume", new Error("resume failed")], ["reconcile", new Error("reconcile failed")]]));
  await recoverRepositoryHost(recovery, "h1", (level, message, data) => logs.push({ level, message, data }));
  assert.deepEqual(recovery.calls, [["environments"], ["resume", "h1"], ["reconcile", "h1"], ["reclaim", "h1"]]);
  assert.deepEqual(logs.map(({ data }) => data.phase), ["resume", "reconcile"]);
  assert.ok(logs.every(({ level, message, data }) => level === "warn" && message === "could not recover repository sessions" && data.hostKey === "h1"));
});

test("a host that connects before host-core answers is deferred, not reported as a failure", async () => {
  const logs = [];
  const unavailable = coded("HOST_UNAVAILABLE", "Local host unavailable");
  const recovery = sessions(new Map(["environments", "resume", "reconcile", "reclaim"].map((name) => [name, unavailable])));
  await recoverRepositoryHost(recovery, "h1", (level, message, data) => logs.push({ level, message, data }));
  assert.equal(logs.length, 4);
  assert.ok(logs.every(({ level }) => level === "info"), JSON.stringify(logs));
});

test("the pass after host-core boots resumes every binding and reconciles each connected host", async () => {
  const logs = [];
  const recovery = sessions(new Map([["reconcile", new Error("one host failed")]]));
  await recoverRepositorySessions(recovery, async () => ["h1", "h2"], (level, message, data) => logs.push({ level, message, data }));
  assert.deepEqual(recovery.calls, [
    ["environments"], ["resume"],
    ["reconcile", "h1"], ["reclaim", "h1"], ["reconcile", "h2"], ["reclaim", "h2"],
  ]);
  assert.deepEqual(logs.map(({ data }) => [data.phase, data.hostKey]), [["reconcile", "h1"], ["reconcile", "h2"]]);
});

test("registering the IPC no longer resumes before host-core is up; the post-boot pass does", async (t) => {
  const hostCalls = [];
  let hostUp = false;
  const call = async (method, params) => {
    if (!hostUp) throw coded("HOST_UNAVAILABLE", "Local host unavailable");
    hostCalls.push(method);
    if (method === "sessionWorkspace.list") return { bindings: [] };
    if (method === "environments.list") return { environments: [] };
    throw new Error(`unexpected host-core call ${method}`);
  };
  const logs = [];
  registerRemoteRepositorySessions({
    registrar: { handleWithEvent() {}, assertMainWindowSender() {} },
    call,
    connector: { onChange: () => () => {}, token: async () => null, status: async () => ({ connected: false }) },
    emit() {},
    log: (message, error) => logs.push(`${message}: ${error}`),
    runWhileIdle: async (_id, operation) => operation(),
    acquireSessionOperation: async () => () => {},
    hasQueuedPrompt: () => false,
    isBusy: () => false,
  });
  t.after(() => getRemoteRepositorySessions()?.reclaimer.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logs, [], "no misleading resume warning at cold start");

  hostUp = true;
  const recovered = [];
  await recoverRemoteRepositorySessions((level, message, data) => recovered.push({ level, message, data }));
  assert.ok(hostCalls.includes("sessionWorkspace.list"), "the resume ran once host-core answered");
  assert.deepEqual(recovered, []);
});


test("a host counts as busy while repository work or any turn runs", async (t) => {
  let bindings = [];
  let activeWork = false;
  const busySessions = new Set();
  const queued = new Set();
  registerRemoteRepositorySessions({
    registrar: { handleWithEvent() {}, assertMainWindowSender() {} },
    call: async (method) => {
      if (method === "sessionWorkspace.list") return { bindings };
      throw new Error(`unexpected host-core call ${method}`);
    },
    connector: { onChange: () => () => {}, token: async () => null, status: async () => ({ connected: false }) },
    emit() {}, log() {},
    runWhileIdle: async (_id, operation) => operation(),
    acquireSessionOperation: async () => () => {},
    hasQueuedPrompt: (sessionId) => queued.has(sessionId),
    isBusy: (sessionId) => busySessions.has(sessionId),
    hasActiveWork: () => activeWork,
  });
  const sessions = getRemoteRepositorySessions();
  t.after(() => sessions.reclaimer.dispose());
  const binding = (sessionId, state, hostKey = "h1") => ({ sessionId, state, hostKey });

  bindings = [binding("s-1", "ready"), binding("s-2", "preparing", "h2")];
  assert.equal(await sessions.hostBusy("h1"), false);
  assert.equal(await sessions.hostBusy("h2"), true, "a preparation runs on h2");
  bindings = [binding("s-1", "reclaiming")];
  assert.equal(await sessions.hostBusy("h1"), true);
  bindings = [binding("s-1", "ready")];
  busySessions.add("s-1");
  assert.equal(await sessions.hostBusy("h1"), true, "the session's turn runs there");
  busySessions.clear();
  queued.add("s-1");
  assert.equal(await sessions.hostBusy("h1"), true, "a queued prompt is about to run there");
  queued.clear();
  activeWork = true;
  assert.equal(await sessions.hostBusy("h1"), true, "any running turn defers the update");
});
