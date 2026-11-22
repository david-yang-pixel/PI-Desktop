import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { electronProbeSkip, probeDomHelpers, runRendererProbe } from "./helpers/electron-renderer-probe.mjs";

// Conversation details link a pushed work branch's changes on GitHub and, once
// a pull request is recorded, show the CI state of its head commit. Main reads
// both with the connector token; the renderer names only the session.

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionGitHubActivity } = await import("../electron/main/remote/session-github-activity.ts");
const { githubCompareUrl } = await import("../src/features/chat/session-target/github-links.ts");

const repository = { owner: "octo", name: "app" };
const sha = "e".repeat(40);

function activityFor(binding, connector = {}) {
  const calls = [];
  const activity = createSessionGitHubActivity({
    workspaces: { binding: async () => binding },
    connector: {
      async getBranch(...args) { calls.push(["getBranch", ...args]); return connector.branch === undefined ? { name: args[1], protected: false, sha } : connector.branch; },
      async getCommitChecks(...args) {
        calls.push(["getCommitChecks", ...args]);
        if (connector.checksError) throw connector.checksError;
        return { state: "failing", total: 2, failed: 1, pending: 0 };
      },
    },
  });
  return { activity, calls };
}
const binding = (extra = {}) => ({
  sessionId: "s", environmentId: "env", hostKey: "h", repository, baseBranch: "main", state: "ready",
  workBranch: "pi-desktop/s1", ...extra,
});

test("a work branch is pushed once GitHub has it, and checks are read only with a pull request", async () => {
  await assert.rejects(activityFor(null).activity("s"), { errorCode: "REMOTE_SESSION_NOT_REPOSITORY" });
  assert.deepEqual(await activityFor(binding({ workBranch: undefined })).activity("s"), { pushed: false });
  assert.deepEqual(await activityFor(binding(), { branch: null }).activity("s"), { pushed: false });

  const unpublished = activityFor(binding());
  assert.deepEqual(await unpublished.activity("s"), { pushed: true });
  assert.deepEqual(unpublished.calls, [["getBranch", repository, "pi-desktop/s1"]]);

  const proposed = activityFor(binding({ pullRequest: { number: 4, url: "https://github.com/octo/app/pull/4" } }));
  assert.deepEqual(await proposed.activity("s"), { pushed: true, checks: { state: "failing", total: 2, failed: 1, pending: 0 } });
  assert.deepEqual(proposed.calls.at(-1), ["getCommitChecks", repository, sha]);
});

test("checks that cannot be read do not hide the pushed branch", async () => {
  const refused = Object.assign(new Error("GitHub refused the request."), { errorCode: "GITHUB_FORBIDDEN" });
  const { activity } = activityFor(binding({ pullRequest: { number: 4, url: "https://github.com/octo/app/pull/4" } }),
    { checksError: refused });
  assert.deepEqual(await activity("s"), {
    pushed: true, checksError: { code: "GITHUB_FORBIDDEN", message: "GitHub refused the request." },
  });
});

test("the compare link names the base and work branch and nothing else", () => {
  assert.equal(githubCompareUrl(repository, "main", "pi-desktop/s1"), "https://github.com/octo/app/compare/main...pi-desktop/s1");
  assert.equal(githubCompareUrl(repository, "release/#12", "pi-desktop/s1"),
    "https://github.com/octo/app/compare/release/%2312...pi-desktop/s1");
  for (const [repo, base, work] of [
    [{ owner: "octo/evil", name: "app" }, "main", "w"], [{ owner: "octo", name: ".." }, "main", "w"],
    [repository, "a..b", "w"], [repository, "main", "w x"],
  ]) {
    assert.equal(githubCompareUrl(repo, base, work), undefined);
  }
});

test("conversation details mount the GitHub rows for a repository session", () => {
  const details = readFileSync(new URL("../src/components/ConversationDetails.tsx", import.meta.url), "utf8");
  assert.match(details, /\{repository && <SessionGitHubActivity sessionId=\{session\.id\} workspace=\{repository\} \/>\}/);
});

const fixture = String.raw`
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SessionGitHubActivity } from "./src/features/chat/session-target/SessionGitHubActivity";
${probeDomHelpers}

globalThis.rendererProbe = async () => {
  await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
  const copy = catalogs.en.sessionTarget.githubActivity;
  const listeners = new Map();
  let answer = { ok: true, data: { pushed: false } };
  let reads = 0;
  window.piDesktop = {
    on(channel, listener) { listeners.set(channel, listener); return () => listeners.delete(channel); },
    async invoke(channel, input) {
      if (channel !== IPC.invoke.remoteSessionGithubActivity || input !== "session-1") throw new Error("Unexpected " + channel);
      reads += 1;
      return answer;
    },
  };
  const workspace = { environmentId: "env", hostKey: "h", repository: { owner: "octo", name: "app" }, baseBranch: "main",
    workBranch: "pi-desktop/s1", state: "ready" };
  let setWorkspace;
  function Details() {
    const [current, update] = React.useState(workspace);
    setWorkspace = update;
    return <dl><SessionGitHubActivity sessionId="session-1" workspace={current} /></dl>;
  }
  const root = document.querySelector("#root");
  createRoot(root).render(<Details />);
  await until(() => reads === 1, "activity was not read");
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (root.querySelector("a")) throw new Error("an unpushed branch offered a compare link");

  // The agent pushes: the finished push reads the activity again.
  answer = { ok: true, data: { pushed: true } };
  flushSync(() => listeners.get(IPC.event.remoteSessionPushProgress)?.({ sessionId: "session-1", active: false, phase: "done" }));
  const link = await until(() => root.querySelector("a"), "a pushed branch has no compare link");
  if (link.textContent !== copy.viewChanges || link.href !== "https://github.com/octo/app/compare/main...pi-desktop/s1"
    || link.target !== "_blank" || link.rel !== "noopener noreferrer") {
    throw new Error("wrong compare link " + link.outerHTML);
  }
  if (root.querySelector("[data-checks-state]")) throw new Error("checks shown without a pull request");

  // A recorded pull request reads the checks.
  answer = { ok: true, data: { pushed: true, checks: { state: "failing", total: 3, failed: 1, pending: 0 } } };
  flushSync(() => setWorkspace({ ...workspace, pullRequest: { number: 4, url: "https://github.com/octo/app/pull/4" } }));
  await until(() => root.querySelector('[data-checks-state="failing"]')?.textContent === copy.checksFailing, "failing checks not shown");

  answer = { ok: false, error: { code: "GITHUB_NOT_CONNECTED", message: "No GitHub account is connected." } };
  flushSync(() => listeners.get(IPC.event.remoteSessionPushProgress)?.({ sessionId: "session-1", active: false, phase: "done" }));
  await until(() => !root.querySelector("dt"), "a signed-out connector still showed GitHub rows");
  answer = { ok: false, error: { code: "GITHUB_RATE_LIMITED", message: "GitHub is rate limiting requests." } };
  flushSync(() => listeners.get(IPC.event.remoteSessionPushProgress)?.({ sessionId: "session-1", active: false, phase: "done" }));
  const expected = copy.unavailable.replace("{{message}}", catalogs.en.errors.GITHUB_RATE_LIMITED);
  await until(() => root.textContent.includes(expected), "a GitHub failure was not explained");
  return true;
};
`;

test("the details rows follow the branch, the pull request, and GitHub's answers", {
  timeout: 90_000, skip: electronProbeSkip,
}, async () => {
  const result = await runRendererProbe(`import React from "react";\n${fixture}`);
  assert.ok(result.passed, result.output);
});
