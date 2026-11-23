import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRemoteHostPatchUpdater, isRemoteHostVersionBehind } = await import("../electron/main/remote/remote-host-patch-update.ts");

test("a host is behind only when its release is older than the desktop's", () => {
  assert.equal(isRemoteHostVersionBehind("0.23.0", "0.23.2"), true, "an older patch");
  assert.equal(isRemoteHostVersionBehind("0.22.9", "0.23.0"), true, "an older minor");
  assert.equal(isRemoteHostVersionBehind("v0.23.1", "0.23.2"), true);
  assert.equal(isRemoteHostVersionBehind("0.23.2-pr.4", "0.23.2"), true, "a prerelease precedes its release");
  assert.equal(isRemoteHostVersionBehind("0.23.2-pr.4", "0.23.2-pr.10"), true);
  assert.equal(isRemoteHostVersionBehind("0.23.2", "0.23.2"), false);
  assert.equal(isRemoteHostVersionBehind("0.23.3", "0.23.2"), false, "a newer host is left alone");
  assert.equal(isRemoteHostVersionBehind("0.23.2", "0.23.2-pr.4"), false);
  assert.equal(isRemoteHostVersionBehind("0.23.2+build.7", "0.23.2"), false, "build metadata does not count");
  // What cannot be compared is never called behind.
  assert.equal(isRemoteHostVersionBehind("fixture", "0.23.2"), false);
  assert.equal(isRemoteHostVersionBehind(undefined, "0.23.2"), false);
  assert.equal(isRemoteHostVersionBehind("0.23.0", "dev"), false);
});

function updater({ version = "0.23.0", busy = false, retryMs = 5 } = {}) {
  const state = { version, busy, realigns: [], logs: [] };
  const patch = createRemoteHostPatchUpdater({
    expectedVersion: "0.23.2",
    hostVersion: () => state.version,
    isBusy: async () => {
      if (state.busy instanceof Error) throw state.busy;
      return state.busy;
    },
    realign: async (hostKey) => {
      state.realigns.push(hostKey);
      state.version = "0.23.2";
      return true;
    },
    log: (level, message) => state.logs.push(`${level}: ${message}`),
    retryMs,
  });
  return { patch, state };
}

test("an idle host on an older patch is realigned once per desktop run", async (t) => {
  const { patch, state } = updater();
  t.after(() => patch.dispose());
  assert.equal(patch.updateAvailable("h"), true);
  await patch.check("h");
  assert.deepEqual(state.realigns, ["h"]);
  assert.equal(patch.updateAvailable("h"), false);
  // Even if it still reported the old release, it is not tried again this run.
  state.version = "0.23.0";
  await patch.check("h");
  await Promise.all([patch.check("h"), patch.check("h")]);
  assert.deepEqual(state.realigns, ["h"]);
});

test("a busy host is never interrupted; its update waits until it is idle", async (t) => {
  const { patch, state } = updater({ busy: true });
  t.after(() => patch.dispose());
  await patch.check("h");
  assert.deepEqual(state.realigns, []);
  assert.match(state.logs.join("\n"), /waits until nothing runs on it/);
  state.busy = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(state.realigns, ["h"], "the retry ran once the host was idle");
});

test("a host whose activity cannot be read counts as busy", async (t) => {
  const { patch, state } = updater({ busy: new Error("session list failed"), retryMs: 60_000 });
  t.after(() => patch.dispose());
  await patch.check("h");
  assert.deepEqual(state.realigns, []);
  assert.match(state.logs.join("\n"), /could not tell whether the remote host is busy/);
});

test("an up-to-date host is left alone and a disposed updater stops retrying", async () => {
  const current = updater({ version: "0.23.2" });
  await current.patch.check("h");
  assert.deepEqual(current.state.realigns, []);
  current.patch.dispose();

  const waiting = updater({ busy: true });
  await waiting.patch.check("h");
  waiting.patch.dispose();
  waiting.state.busy = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(waiting.state.realigns, []);
});
