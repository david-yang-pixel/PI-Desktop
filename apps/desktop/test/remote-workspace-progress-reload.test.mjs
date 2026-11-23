import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMainModuleSync } from "./helpers/source-contracts.mjs";

// A renderer that reloads while a repository workspace prepares re-reads the
// session from host-core, which stores no job progress. Main keeps the last
// phase and progress it relayed and adds them back, so the composer keeps
// saying "Cloning octo/repo… 42%" instead of the generic preparing text.

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { IPC } = await import("@pi-desktop/shared");
const { createSessionWorkspaces } = await import("../electron/main/remote/session-workspaces.ts");

const repository = { owner: "octo", name: "repo" };
const worktree = {
  sessionId: "s-1", repository, baseBranch: "main", workBranch: "pi-desktop/s1", path: "/w/worktrees/s1",
  mainPath: "/w/repos/octo/repo", baseCommit: "a".repeat(40), createdAt: "2026-11-20T00:00:00.000Z",
  setup: { status: "ok" },
};

function fixture() {
  const bindings = new Map([["s-1", {
    sessionId: "s-1", environmentId: "env-1", hostKey: "h1", repository, baseBranch: "main", state: "preparing",
  }]]);
  const events = [];
  const host = { job: { kind: "prepare", state: "running", phase: "cloning", progress: { percent: 42, detail: "Receiving objects" } } };
  const workspaces = createSessionWorkspaces({
    async call(method, params = {}) {
      switch (method) {
        case "sessionWorkspace.get": return { binding: bindings.get(params.sessionId) ?? null };
        case "sessionWorkspace.update": {
          const next = { ...bindings.get(params.sessionId), ...params.patch };
          bindings.set(params.sessionId, next);
          return { binding: next };
        }
        case "sessionWorkspace.list": return { bindings: [...bindings.values()] };
        case "environments.list":
          return { environments: [{ id: "env-1", name: "Dev", hostKey: "h1", setupScript: "", variables: [] }] };
        default: throw new Error(`unexpected host call ${method}`);
      }
    },
    hosts: () => ({
      async list() { return [{ hostKey: "h1", label: "Build host", connected: true }]; },
      workspaceGit: {
        async prepare() { return { jobId: "job-1" }; },
        async job(_hostKey, jobId) { return { jobId, ...host.job }; },
        async cancelJob() {},
        async list() { return []; },
      },
    }),
    connector: { async status() { return { connected: true }; } },
    emit(channel, payload) { events.push({ channel, payload }); },
    log(message, error) { throw new Error(`${message}: ${error}`); },
  });
  async function untilAnnounced(predicate) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = events.some(({ channel, payload }) =>
        channel === IPC.event.remoteSessionWorkspaceChanged && predicate(payload.remoteRepository));
      if (found) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("expected a workspace event");
  }
  return { workspaces, bindings, host, untilAnnounced };
}

/** What host-core returns for the session after a renderer reload. */
const hostCoreSummary = (state) => ({
  id: "s-1", title: "Fix the upload test",
  remoteRepository: { environmentId: "env-1", hostKey: "h1", repository, baseBranch: "main", state },
});

test("a reloaded renderer reads back the phase and progress of a preparing workspace", { timeout: 15_000 }, async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.workspaces.withLiveProgress(hostCoreSummary("preparing")), hostCoreSummary("preparing"),
      "nothing is added before the Host reports a phase");
    await f.workspaces.resume();
    await f.untilAnnounced((item) => item.phase === "cloning");

    const reread = f.workspaces.withLiveProgress(hostCoreSummary("preparing"));
    assert.equal(reread.remoteRepository.phase, "cloning");
    assert.deepEqual(reread.remoteRepository.progress, { percent: 42, detail: "Receiving objects" });
    assert.equal(reread.title, "Fix the upload test");
    assert.equal((await f.workspaces.get("s-1")).phase, "cloning");
    // Another session and a summary that is no longer preparing are left alone.
    assert.deepEqual(f.workspaces.withLiveProgress({ ...hostCoreSummary("preparing"), id: "s-2" }),
      { ...hostCoreSummary("preparing"), id: "s-2" });
    assert.deepEqual(f.workspaces.withLiveProgress(hostCoreSummary("failed")), hostCoreSummary("failed"));

    f.host.job = { kind: "prepare", state: "running", phase: "runningSetup", setupLogTail: "npm ci\n" };
    await f.untilAnnounced((item) => item.phase === "runningSetup");
    const setup = f.workspaces.withLiveProgress(hostCoreSummary("preparing")).remoteRepository;
    assert.equal(setup.phase, "runningSetup");
    assert.deepEqual(setup.setup, { status: "running", logTail: "npm ci\n" });

    f.host.job = { kind: "prepare", state: "succeeded", phase: "done", worktree };
    await f.untilAnnounced((item) => item.state === "ready");
    assert.equal((await f.workspaces.get("s-1")).phase, undefined);
    assert.deepEqual(f.workspaces.withLiveProgress(hostCoreSummary("preparing")), hostCoreSummary("preparing"),
      "a finished job leaves no stale progress behind");
  } finally {
    f.workspaces.dispose();
  }
});

test("a cancelled preparation forgets its progress", { timeout: 15_000 }, async () => {
  const f = fixture();
  try {
    await f.workspaces.resume();
    await f.untilAnnounced((item) => item.phase === "cloning");
    f.host.job = { kind: "prepare", state: "cancelled", phase: "cloning" };
    await f.workspaces.cancelPreparation("s-1");
    assert.deepEqual(f.workspaces.withLiveProgress(hostCoreSummary("preparing")), hostCoreSummary("preparing"));
  } finally {
    f.workspaces.dispose();
  }
});

test("the session list and session reads add the live progress", () => {
  const source = readMainModuleSync("ipc/session-ipc.ts");
  const list = source.slice(source.indexOf("handle(IPC.invoke.sessionList"), source.indexOf("handle(IPC.invoke.sessionCreate"));
  assert.match(list, /workspaces\?\.withLiveProgress\(session\)/);
  const read = source.slice(source.indexOf("IPC.invoke.sessionGet,"), source.indexOf("handle(IPC.invoke.sessionCollaboration"));
  assert.match(read, /\.withLiveProgress\(result\.session\)/);
});
