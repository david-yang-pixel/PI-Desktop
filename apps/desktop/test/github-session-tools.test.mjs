import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { ErrorCodes } = await import("@pi-desktop/shared");
const {
  createGitHubSessionTools,
  githubSessionPullRequestTool,
  githubSessionPushTool,
  githubSessionToolDefinitions,
} = await import("../electron/main/github/session-github-tools.ts");

const SESSION = "session-1";
const status = (extra = {}) => ({
  reachable: true, workBranch: "pi-desktop/abc123", baseBranch: "main",
  ahead: 0, behind: 0, aheadOfBase: 1, uncommittedFiles: 0, unpushedCommits: 0, pushedOnce: true, ...extra,
});
const coded = (errorCode, message = errorCode) => Object.assign(new Error(message), { errorCode });

function fixture({ binding = { state: "ready", workBranch: "pi-desktop/abc123" }, connector = { connected: true }, git = {} } = {}) {
  const calls = [];
  const sessions = {
    workspaces: { binding: async (id) => (id === SESSION ? binding : null) },
    connector: { status: async () => connector },
    git: {
      push: async (id, assertCurrent, options) => {
        calls.push(options?.forceWithLease ? ["push", id, options] : ["push", id]);
        assertCurrent?.();
        return git.push ? git.push() : status();
      },
      status: async (id) => {
        calls.push(["status", id]);
        return git.status ? git.status() : status();
      },
      create: async (id, input, assertCurrent) => {
        calls.push(["create", id, input]);
        assertCurrent?.();
        return { number: 7, url: "https://github.com/octo/repo/pull/7", title: input.title };
      },
      refreshPullRequest: async (id) => { calls.push(["refreshPullRequest", id]); },
    },
  };
  return { tools: createGitHubSessionTools(() => sessions), calls };
}

const run = (tools, toolName, extra = {}) => tools.execute({
  sessionId: SESSION, toolName, mode: "agent", args: {}, isCurrent: () => true, ...extra,
});

test("cloud sessions expose push and pull request tools as high-risk connector tools", () => {
  assert.deepEqual(githubSessionToolDefinitions.map((tool) => tool.name), [
    "plugin_pi_github_PushSessionBranch",
    "plugin_pi_github_CreateSessionPullRequest",
  ]);
  for (const tool of githubSessionToolDefinitions) {
    assert.equal(tool.risk, "high");
    assert.equal(tool.externalToolSource, "connector");
  }
  const { tools } = fixture();
  assert.equal(tools.owns(githubSessionPushTool.name), true);
  assert.equal(tools.owns(githubSessionPullRequestTool.name), true);
  assert.equal(tools.owns("mcp_github_create_pull_request"), false);
});

test("the tools are offered whenever the connector is signed in, with no settings switch involved", async () => {
  assert.equal(await fixture().tools.available(SESSION), true);
  assert.equal(await fixture().tools.available("other-session"), false);
  assert.equal(await fixture({ binding: { state: "preparing" } }).tools.available(SESSION), false);
  assert.equal(await fixture({ connector: { connected: false } }).tools.available(SESSION), false);
  assert.equal(await fixture({ connector: { connected: true, needsReauthentication: true } }).tools.available(SESSION), false);
  // The executor takes no settings at all: the GitHub Agent tools switch
  // governs only the issues and pull requests MCP server.
  const { tools, calls } = fixture();
  const result = await run(tools, githubSessionPushTool.name, { settings: { githubAgentTools: false } });
  assert.equal(result.pushed, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["push"]);
});

test("Plan and Goal turns cannot push or open a pull request", async () => {
  for (const mode of ["plan", "goal", undefined]) {
    for (const toolName of [githubSessionPushTool.name, githubSessionPullRequestTool.name]) {
      const { tools, calls } = fixture();
      await assert.rejects(run(tools, toolName, { mode, args: { title: "x" } }),
        (error) => error.errorCode === ErrorCodes.PERMISSION_DENIED);
      assert.deepEqual(calls, []);
    }
  }
});

test("push reports the branch counts after pushing", async () => {
  const { tools, calls } = fixture({ git: { push: () => status({ unpushedCommits: 0 }) } });
  const result = await run(tools, githubSessionPushTool.name);
  assert.equal(result.pushed, true);
  assert.equal(result.workBranch, "pi-desktop/abc123");
  assert.equal(result.baseBranch, "main");
  assert.deepEqual(calls, [["push", SESSION]]);
});

test("an up-to-date branch answers with its counts instead of failing", async () => {
  const { tools, calls } = fixture({
    git: {
      push: () => { throw coded(ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH, "The work branch is already pushed"); },
      status: () => status({ aheadOfBase: 0, pushedOnce: false, uncommittedFiles: 3 }),
    },
  });
  const result = await run(tools, githubSessionPushTool.name);
  assert.equal(result.pushed, false);
  assert.equal(result.uncommittedFiles, 3, "the Agent learns it still has to commit");
  assert.deepEqual(calls.map(([kind]) => kind), ["push", "status"]);
});

test("other push failures stay failures", async () => {
  const { tools } = fixture({ git: { push: () => { throw coded(ErrorCodes.REMOTE_TARGET_HOST_OFFLINE, "The host is offline"); } } });
  await assert.rejects(run(tools, githubSessionPushTool.name),
    (error) => error.errorCode === ErrorCodes.REMOTE_TARGET_HOST_OFFLINE);
});

test("push takes only an optional forceWithLease flag and stops when the turn has ended", async () => {
  for (const args of [{ branch: "main" }, { forceWithLease: "yes" }, { forceWithLease: true, force: true }, ["x"]]) {
    await assert.rejects(run(fixture().tools, githubSessionPushTool.name, { args }),
      (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT, JSON.stringify(args));
  }
  const { tools, calls } = fixture();
  await assert.rejects(run(tools, githubSessionPushTool.name, { isCurrent: () => false }),
    (error) => error.errorCode === "TOOL_TURN_CANCELLED");
  assert.deepEqual(calls, []);
});

test("forceWithLease reaches the session's git only when the Agent sets it", async () => {
  const schema = githubSessionPushTool.parameters;
  assert.deepEqual(Object.keys(schema.properties), ["forceWithLease"]);
  assert.equal(schema.properties.forceWithLease.type, "boolean");
  assert.match(schema.properties.forceWithLease.description, /only after you rebased the work branch/i);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required, undefined);
  const { tools, calls } = fixture();
  await run(tools, githubSessionPushTool.name, { args: { forceWithLease: true } });
  await run(tools, githubSessionPushTool.name, { args: { forceWithLease: false } });
  await run(tools, githubSessionPushTool.name, { args: {} });
  assert.deepEqual(calls, [["push", SESSION, { forceWithLease: true }], ["push", SESSION], ["push", SESSION]]);
});

test("a rejected push reaches the Agent with its typed code", async () => {
  const { tools } = fixture({ git: { push: () => { throw coded(ErrorCodes.WORKSPACE_GIT_PUSH_REJECTED, "not a fast-forward"); } } });
  await assert.rejects(run(tools, githubSessionPushTool.name),
    (error) => error.errorCode === ErrorCodes.WORKSPACE_GIT_PUSH_REJECTED);
});

test("the pull request tool validates its input and opens the PR through the session's git", async () => {
  const { tools, calls } = fixture();
  await assert.rejects(run(tools, githubSessionPullRequestTool.name, { args: { title: " " } }),
    (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT);
  const pr = await run(tools, githubSessionPullRequestTool.name, { args: { title: "  Fix it  ", draft: true } });
  assert.equal(pr.number, 7);
  assert.deepEqual(calls, [["create", SESSION, { title: "Fix it", body: "", draft: true }]]);
});

test("a session without a repository workspace is refused", async () => {
  const tools = createGitHubSessionTools(() => null);
  await assert.rejects(run(tools, githubSessionPushTool.name),
    (error) => error.errorCode === ErrorCodes.REMOTE_SESSION_NOT_REPOSITORY);
  assert.equal(await tools.available(SESSION), false);
});

test("offering the tools refreshes the recorded pull request state in the background", async () => {
  const signedIn = fixture();
  assert.equal(await signedIn.tools.available(SESSION), true);
  assert.deepEqual(signedIn.calls, [["refreshPullRequest", SESSION]]);
  // Without a usable connector nothing is asked of GitHub.
  for (const connector of [{ connected: false }, { connected: true, needsReauthentication: true }]) {
    const signedOut = fixture({ connector });
    assert.equal(await signedOut.tools.available(SESSION), false);
    assert.deepEqual(signedOut.calls, []);
  }
});

test("the tools follow the connector between launches, and a stale list cannot publish after a sign-out", async () => {
  const connector = { connected: false };
  const { tools, calls } = fixture({ connector });
  // Signed out at the first launch: not offered.
  assert.equal(await tools.available(SESSION), false);
  // Signed in later: the next launch offers them, without restarting anything.
  connector.connected = true;
  assert.equal(await tools.available(SESSION), true);

  // A turn launched while signed in keeps its tool list; after a sign-out or
  // a rejected token its calls are refused before anything is pushed.
  calls.length = 0;
  for (const state of [{ connected: false }, { connected: true, needsReauthentication: true }]) {
    Object.assign(connector, { connected: state.connected, needsReauthentication: state.needsReauthentication });
    for (const toolName of [githubSessionPushTool.name, githubSessionPullRequestTool.name]) {
      await assert.rejects(run(tools, toolName, { args: toolName === githubSessionPushTool.name ? {} : { title: "Fix" } }),
        (error) => error.errorCode === ErrorCodes.GITHUB_NOT_CONNECTED);
    }
  }
  assert.deepEqual(calls, []);
});
