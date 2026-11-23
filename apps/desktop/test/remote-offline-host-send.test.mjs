import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The composer does not block Send for an offline Host: the first send
// reconnects it. Only a Host that still cannot be reached is reported offline.

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { ErrorCodes } = await import("@pi-desktop/shared");
const { createSessionWorkspaces } = await import("../electron/main/remote/session-workspaces.ts");
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");

const repository = { owner: "octo", name: "repo" };

function resolver(supported) {
  return createSessionWorkspaces({
    async call(method) {
      if (method === "environments.list") return { environments: [] };
      if (method === "project.group.ensureRepository") {
        return { group: { primaryPath: "remote-project:octo-repo" }, created: false };
      }
      throw new Error(`unexpected host call ${method}`);
    },
    hosts: () => ({
      async list() { return [{ hostKey: "h1", label: "Build host", connected: false }]; },
      workspaceGit: { supported, async repository() { return { path: "/w/repos/octo/repo" }; } },
    }),
    connector: { async status() { return { connected: true }; } },
    emit() {},
    log() {},
  });
}
const target = { environmentId: "default:h1", repository, defaultBranch: "main" };

test("a repository target on an offline Host reconnects instead of failing", async () => {
  let reconnects = 0;
  const workspaces = resolver(async () => { reconnects += 1; return true; });
  try {
    assert.deepEqual(await workspaces.resolve(target), { projectPath: "remote-project:octo-repo" });
    assert.equal(reconnects, 1);
  } finally {
    workspaces.dispose();
  }
});

test("a Host that still cannot be reached is reported offline, other failures as they are", async () => {
  const unreachable = resolver(async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { errorCode: ErrorCodes.REMOTE_CONNECTION_FAILED });
  });
  const revoked = resolver(async () => { throw Object.assign(new Error("revoked"), { errorCode: "HOST_AUTH_FAILED" }); });
  try {
    await assert.rejects(unreachable.resolve(target), { errorCode: ErrorCodes.REMOTE_TARGET_HOST_OFFLINE });
    await assert.rejects(revoked.resolve(target), { errorCode: "HOST_AUTH_FAILED" });
  } finally {
    unreachable.dispose();
    revoked.dispose();
  }
});

test("creating a session on an offline Host reconnects it first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "offline-host-send-"));
  const sessions = [];
  const requests = [];
  let builds = 0;
  const adapter = {
    state: () => "connected",
    async connect() {},
    async close() {},
    client: {
      async request(method, params) {
        requests.push(method);
        if (method === "session/list") return { sessions };
        if (method === "session/create") {
          const session = {
            id: "created", title: "New", mode: "agent", status: "idle", planningState: "inactive",
            permissionMode: "ask", queuedTurnIds: [], revision: 1,
            createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z",
          };
          sessions.push(session);
          return { session };
        }
        if (method === "events/subscribe") {
          return { subscriptionId: `sub-${params?.sessionId ?? "host"}`, starting: { epoch: "e1", sequence: 1 }, replayComplete: true };
        }
        if (method === "session/attach") {
          const session = sessions.find((row) => row.id === params.sessionId);
          return { session, snapshot: { session, items: [], activeItems: [], pendingApprovals: [], pendingInputs: [], queuedTurns: [],
            hasMoreHistory: false, cursor: { epoch: "e1", sequence: 0 }, revision: 1, generatedAt: session.updatedAt } };
        }
        return { ok: true };
      },
      subscribe() { return () => {}; },
    },
  };
  const boot = createRemoteHostsBoot({
    dataDir: dir,
    encryption: {
      isAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`),
      decryptString: (buffer) => buffer.toString("utf8").slice(4),
    },
    router: createBackendRouter(), emit: () => {}, clientInfo: { name: "test", version: "1" },
    buildAdapter: () => { builds += 1; return adapter; },
  });
  try {
    await boot.registry.upsert({ hostKey: "offline", label: "Offline", url: "wss://offline", deviceToken: "t" });
    assert.equal((await boot.list())[0].connected, false);
    const created = await boot.createSession({ hostKey: "offline" });
    assert.equal(created.id.endsWith("created"), true, created.id);
    assert.equal(builds, 1);
    assert.ok(requests.includes("session/create"));
    assert.equal((await boot.list())[0].connected, true);
  } finally {
    await boot.closeAll();
    await rm(dir, { recursive: true, force: true });
  }
});
