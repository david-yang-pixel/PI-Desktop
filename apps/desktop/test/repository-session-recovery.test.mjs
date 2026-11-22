import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { recoverRepositoryHost } = await import("../electron/main/remote/repository-session-recovery.ts");

function sessions(fail = new Set()) {
  const calls = [];
  const step = (name) => async (...args) => {
    calls.push([name, ...args]);
    if (fail.has(name)) throw new Error(`${name} failed`);
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
  const recovery = sessions(new Set(["resume", "reconcile"]));
  await recoverRepositoryHost(recovery, "h1", (message, data) => logs.push({ message, data }));
  assert.deepEqual(recovery.calls, [["environments"], ["resume", "h1"], ["reconcile", "h1"], ["reclaim", "h1"]]);
  assert.deepEqual(logs.map(({ data }) => data.phase), ["resume", "reconcile"]);
  assert.ok(logs.every(({ message, data }) => message === "could not recover repository sessions" && data.hostKey === "h1"));
});
