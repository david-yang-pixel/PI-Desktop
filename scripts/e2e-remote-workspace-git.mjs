#!/usr/bin/env node
/**
 * Remote git workspaces, end to end, with no real GitHub and no real token:
 *
 *   desktop boot API -> loopback RACP -> pi-host operations -> real host-core
 *   -> git -> pi-host credential proxy -> a local `git http-backend` fixture
 *
 * Scenarios `E2E-REMOTE-repo-session-prepares-isolated-worktree`,
 * `E2E-REMOTE-git-proxy-rejects-foreign-ref`,
 * `E2E-REMOTE-repo-session-delete-during-prepare-removes-worktree`,
 * `E2E-REMOTE-repo-session-preparation-resumes-after-host-reconnect`, and
 * `E2E-REMOTE-repo-session-offline-delete-records-pending-removal`
 * (docs/spec/06-delivery/e2e/live-and-remote.md).
 *
 * Usage: PI_HOST_CORE_BINARY=<host-core binary> node scripts/e2e-remote-workspace-git.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { HostProcess, createHostSessionPort, createHostQueueStore } = await import("../packages/host-runtime/dist/index.js");
const { AgentHost } = await import("../packages/agent-host/dist/index.js");
const { bindRacpWebSocket, RacpServer, MemoryCredentialStore, DeviceTokenAuthenticator, hashToken, newDeviceToken } = await import("../packages/racp/dist/index.js");
const { createHostOperations } = await import("../apps/pi-host/dist/host-operations.js");
const { createGitCredentialProxy } = await import("../apps/pi-host/dist/git-credential-proxy.js");
const { detectWorkspaceGitReclaim, workspaceGitWorkBranch } = await import("../apps/pi-host/dist/workspace-git.js");
const { createRemoteHostsBoot } = await import("../apps/desktop/electron/main/bootstrap/remote-hosts.ts");
const { createBackendRouter } = await import("../apps/desktop/electron/main/remote/backend-router.ts");
const { createSessionWorkspaces } = await import("../apps/desktop/electron/main/remote/session-workspaces.ts");
const { createSessionWorkspaceGit } = await import("../apps/desktop/electron/main/remote/session-workspace-git.ts");
const { createGitHubSessionTools, githubSessionPullRequestTool, githubSessionPushTool } = await import("../apps/desktop/electron/main/github/session-github-tools.ts");
const { createHostRuntime } = await import("../apps/desktop/electron/main/runtime/host.ts");
const { createRemoteWorkspaceToolRelay } = await import("../apps/desktop/electron/main/remote/remote-workspace-tools.ts");
const { saveComposerPasteFiles } = await import("../apps/desktop/electron/main/composer-paste.ts");
const { formatFileInsert, IPC } = await import("../packages/shared/dist/index.js");
const { startGitHttpFixture } = await import("./e2e/git-http-fixture.mjs");

assert.ok(process.env.PI_HOST_CORE_BINARY, "PI_HOST_CORE_BINARY must name the current candidate Rust binary");

const FIXTURE_TOKEN = "e2e-fixture-token-0123456789-not-a-real-credential";
const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const OWNER_TOKEN = newDeviceToken();
const repository = { owner: "octo", name: "repo" };
const HOST = "fixture";

const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-workspace-git-"));
const hostDataDir = join(root, "host-data");
const workspacesRoot = join(root, "pi-workspaces");
const remoteRoot = join(root, "github");
const bare = join(remoteRoot, "octo", "repo.git");

// Never inherit configuration that could redirect git in this harness.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=PI E2E", "-c", "user.email=pi-e2e@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { env: { ...gitEnv, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remoteHead = (branch) => git(bare, "rev-parse", "--verify", `refs/heads/${branch}`);
/**
 * A receive-pack POST that can change refs. Before a pack larger than
 * `http.postBuffer` git sends a probe whose body is only a flush packet
 * (`0000`); the proxy lets it through because it names no ref and changes
 * nothing, so it does not count as a push reaching "GitHub".
 */
const isRefUpdate = (request) => request.method === "POST" && request.path.endsWith("/git-receive-pack") && request.contentLength !== "4";
const remoteHasBranch = (branch) => {
  try { remoteHead(branch); return true; } catch { return false; }
};

let currentStep = "setup";
async function step(name, action) {
  currentStep = name;
  await action();
  console.log(`ok - ${name}`);
}

let fixture; let host; let proxy; let binding; let server; let boot; let localHost; let repositorySessions;
const hostLogs = [];
let token = FIXTURE_TOKEN;
/** One entry per token pi-host was given: true for a token, false for a clear. */
const tokenSets = [];
const deadline = setTimeout(() => { console.error(`FAILED - ${currentStep}: remote workspace git acceptance exceeded 180s`); process.exit(1); }, 180_000);

async function pollJob(jobId) {
  const phases = [];
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await boot.workspaceGit.job(HOST, jobId);
    if (phases.at(-1) !== job.phase) phases.push(job.phase);
    if (job.state !== "running") return { job, phases };
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`job ${jobId} did not finish; phases ${phases.join(",")}`);
}

async function until(read, description, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

let racpListener;
/**
 * Make the paired Host really unreachable: its RACP listener goes away, so
 * the Desktop's reconnect before each workspace-git call fails with the
 * WebSocket connect error rather than a typed offline result.
 */
async function takeHostOffline() {
  await binding.close();
  await until(async () => !(await boot.list()).find((entry) => entry.hostKey === HOST)?.connected, "the Desktop to see the Host disconnect");
}
async function bringHostOnline() {
  binding = await racpListener();
}

async function prepare(sessionId, baseBranch, extra = {}) {
  const { jobId } = await boot.workspaceGit.prepare(HOST, { sessionId, repository, baseBranch, ...extra });
  const { job, phases } = await pollJob(jobId);
  assert.equal(job.state, "succeeded", `prepare ${sessionId}: ${JSON.stringify(job.error)} after ${phases.join(",")}`);
  return { worktree: job.worktree, phases };
}

let shell;
let toolCall = 0;
/** Run one Bash command in a session's worktree through the remote tool path. */
async function bash(sessionId, path, command) {
  toolCall += 1;
  const result = await boot.executeWorkspaceTool({
    hostKey: HOST, path, sessionId, turnId: "e2e-turn", toolCallId: `e2e-call-${toolCall}`, toolName: "Bash",
    args: { command: `${command}\necho "exit=$?"` }, timeoutMs: 60_000,
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  const output = `${result.content?.stdout ?? ""}${result.content?.stderr ?? ""}`;
  const exit = /exit=(\d+)\s*$/.exec(output.trim());
  assert.ok(exit, `Bash produced no exit marker: ${JSON.stringify(result)}`);
  return { exitCode: Number(exit[1]), output };
}

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

try {
  // "GitHub": one private repository with two branches.
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "README.md"), "main\n");
  git(source, "add", "README.md");
  git(source, "commit", "-q", "-m", "init");
  git(source, "checkout", "-q", "-b", "develop");
  await writeFile(join(source, "develop.txt"), "develop\n");
  git(source, "add", "develop.txt");
  git(source, "commit", "-q", "-m", "develop");
  git(source, "checkout", "-q", "main");
  await mkdir(join(remoteRoot, "octo"), { recursive: true });
  git(root, "clone", "-q", "--bare", source, bare);
  fixture = await startGitHttpFixture({ projectRoot: remoteRoot, repositoryPath: "/octo/repo.git", token: FIXTURE_TOKEN });
  const mainHead = remoteHead("main");
  const developHead = remoteHead("develop");

  // The paired host: real host-core, pi-host's operations and proxy, RACP on loopback.
  host = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: hostDataDir, onStderr: (text) => hostLogs.push(String(text)) });
  await host.handshake();
  // The only way to point the proxy anywhere but GitHub: its constructor.
  proxy = createGitCredentialProxy({ upstream: fixture.url, log: (level, message, data) => hostLogs.push(JSON.stringify({ level, message, data })) });
  // Record when pi-host is handed a token (never the value): connecting must not.
  const proxySetToken = proxy.setToken.bind(proxy);
  proxy.setToken = (installationId, value) => { tokenSets.push(value !== null); return proxySetToken(installationId, value); };
  await proxy.start();
  const agentHost = new AgentHost({ sessions: createHostSessionPort(() => host),
    runtime: { async prompt() { throw new Error("no remote model"); }, async stop() { return { requested: false }; }, async abort() {}, async respondInput() {} },
    approvals: { async resolveTool() { throw new Error("no remote approval"); }, async resolveContract() { throw new Error("no remote contract"); }, async listPendingTools() { return []; } },
  });
  const credentials = new MemoryCredentialStore();
  await credentials.saveDevice({ deviceId: "fixture-owner", label: "Fixture", roles: ["owner"], tokenHash: hashToken(OWNER_TOKEN), createdAt: new Date().toISOString() });
  const authenticator = new DeviceTokenAuthenticator(credentials);
  const reclaimSupported = await detectWorkspaceGitReclaim(host);
  const operations = createHostOperations({
    getHost: () => host, runtime: { isBusy: () => false, async compact() { throw new Error("no remote model"); } },
    browseRoot: root, dataDir: hostDataDir, workspacesRoot, gitProxy: proxy,
    workspaceGitReclaimSupported: (candidate) => candidate === host && reclaimSupported,
  });
  server = new RacpServer({ agentHost, operations, authenticator, hostId: "git-host", serverVersion: "fixture", log: (level, message, data) => hostLogs.push(JSON.stringify({ level, message, data })) });
  binding = await bindRacpWebSocket({ server, authenticator, host: "127.0.0.1", port: 0, log: () => {} });
  const racpPort = binding.address.port;
  racpListener = () => bindRacpWebSocket({ server, authenticator, host: "127.0.0.1", port: racpPort, log: () => {} });
  const desktopLogs = [];
  boot = createRemoteHostsBoot({
    dataDir: join(root, "desktop"), router: createBackendRouter(), clientInfo: { name: "workspace-git-fixture", version: "fixture" }, emit: () => {},
    encryption: { isAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    getInstallationId: async () => INSTALLATION,
    log: (level, message, data) => desktopLogs.push(JSON.stringify({ level, message, data })),
  });
  await mkdir(join(root, "desktop"), { recursive: true });

  let a; let b;
  const workA = workspaceGitWorkBranch(INSTALLATION, "session-a");
  const workB = workspaceGitWorkBranch(INSTALLATION, "session-b");

  await step("1 connect; the credential waits for its first use", async () => {
    boot.workspaceGit.setCredentialProvider(async () => token);
    assert.equal((await boot.addHost({ hostKey: HOST, label: "Fixture", url: `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`, deviceToken: OWNER_TOKEN })).connected, true);
    await boot.workspaceGit.refreshCredential();
    assert.equal(await boot.workspaceGit.supported(HOST), true);
    shell = await boot.workspaceCommandShell(HOST);
    const where = await boot.workspaceGit.repository(HOST, repository);
    assert.deepEqual(where, { path: join(workspacesRoot, "repos/github.com/octo/repo"), cloned: false });
    assert.equal(existsSync(workspacesRoot), false, "asking where a repository lives creates nothing");
    assert.equal(fixture.requests.length, 0);
    // Least privilege (D695): connecting and signing in hand the host no token.
    assert.deepEqual(tokenSets, [], "the token waits for the first operation that needs it");
  });

  await step("2 prepare session A from main (E2E-REMOTE-repo-session-prepares-isolated-worktree)", async () => {
    const prepared = await prepare("session-a", "main");
    a = prepared.worktree;
    assert.equal(a.workBranch, workA);
    assert.equal(a.baseCommit, mainHead);
    assert.equal(a.mainPath, join(workspacesRoot, "repos/github.com/octo/repo"));
    assert.ok(a.path.startsWith(join(workspacesRoot, "worktrees/github.com/octo/repo/")));
    assert.equal(git(a.path, "rev-parse", "HEAD"), mainHead);
    assert.equal(git(a.path, "symbolic-ref", "--short", "HEAD"), workA);
    assert.ok(existsSync(join(a.mainPath, ".git")), "the main checkout exists");
    // The stored remote is the GitHub URL: no proxy address, no credential.
    assert.equal(git(a.mainPath, "config", "--get", "remote.origin.url"), "https://github.com/octo/repo.git");
    assert.deepEqual(await boot.workspaceGit.repository(HOST, repository), { path: a.mainPath, cloned: true });
    assert.ok(fixture.requests.length > 0 && fixture.requests.every((request) => request.authorized), "the clone went through the proxy with the credential");
    assert.deepEqual(tokenSets, [true], "the first prepare delivered the token once");
    // A retry returns the same worktree instead of a second one.
    assert.deepEqual((await prepare("session-a", "develop")).worktree, a);
  });

  await step("3 prepare session B from develop", async () => {
    const seen = fixture.requests.length;
    const prepared = await prepare("session-b", "develop");
    b = prepared.worktree;
    // The repository is cloned once; a later session only fetches.
    assert.equal(prepared.phases.includes("cloning"), false, prepared.phases.join(","));
    assert.ok(fixture.requests.length > seen, "the fetch reached the fixture");
    assert.equal(b.workBranch, workB);
    assert.notEqual(b.path, a.path);
    assert.equal(git(b.path, "rev-parse", "HEAD"), developHead);
    assert.ok(existsSync(join(b.path, "develop.txt")));
    assert.equal(git(a.path, "rev-parse", "HEAD"), mainHead, "session A is untouched");
    assert.equal(existsSync(join(a.path, "develop.txt")), false);
  });

  let committed;
  await step("4 the agent's Bash commits and pushes its work branch", async () => {
    const commit = await bash("session-a", a.path, "printf 'work\\n' > work.txt && git add work.txt && git -c user.name='PI E2E' -c user.email=pi-e2e@example.invalid commit -q -m work");
    assert.equal(commit.exitCode, 0, commit.output);
    committed = git(a.path, "rev-parse", "HEAD");
    assert.equal(remoteHasBranch(workA), false);

    // A forked session starts from the parent's commit while it is still unpushed.
    const fork = await prepare("session-c", "main", { fromSessionId: "session-a" });
    assert.equal(fork.worktree.baseCommit, committed);
    assert.equal(git(fork.worktree.path, "rev-parse", "HEAD"), committed);
    assert.equal(git(fork.worktree.path, "symbolic-ref", "--short", "HEAD"), workspaceGitWorkBranch(INSTALLATION, "session-c"));
    assert.equal(fork.worktree.baseBranch, "main");

    const pushed = await bash("session-a", a.path, "git push 2>&1");
    assert.equal(pushed.exitCode, 0, pushed.output);
    assert.equal(remoteHead(workA), committed, "the fixture's repository has the work branch");
    assert.equal(remoteHead("main"), mainHead);
    // The same push as a host job is a no-op that reports the remote head.
    const { jobId } = await boot.workspaceGit.push(HOST, "session-a");
    const { job } = await pollJob(jobId);
    assert.deepEqual([job.state, job.pushed], ["succeeded", { branch: workA, remoteHead: committed }]);
  });

  await step("4b pushes larger than git's post buffer go through", async () => {
    // Above 1 MiB git first sends an empty probe request, then streams the pack.
    const commitLarge = (name) => `head -c 3145728 /dev/urandom > ${name} && git add ${name} && git -c user.name='PI E2E' -c user.email=pi-e2e@example.invalid commit -q -m ${name}`;
    const first = await bash("session-b", b.path, `${commitLarge("large-1.bin")} && git push 2>&1`);
    assert.equal(first.exitCode, 0, first.output);
    assert.equal(remoteHead(workB), git(b.path, "rev-parse", "HEAD"), "the agent's large push reached the fixture");
    const second = await bash("session-b", b.path, commitLarge("large-2.bin"));
    assert.equal(second.exitCode, 0, second.output);
    const head = git(b.path, "rev-parse", "HEAD");
    const { jobId } = await boot.workspaceGit.push(HOST, "session-b");
    const { job } = await pollJob(jobId);
    assert.deepEqual([job.state, job.pushed, job.error], ["succeeded", { branch: workB, remoteHead: head }, undefined]);
    assert.equal(remoteHead(workB), head, "the host's large push reached the fixture");
    assert.equal(remoteHead("develop"), developHead);
  });

  await step("5 a push to another ref is refused by the proxy (E2E-REMOTE-git-proxy-rejects-foreign-ref)", async () => {
    const receivePacks = () => fixture.requests.filter(isRefUpdate).length;
    const before = receivePacks();
    for (const command of ["git push origin HEAD:main 2>&1", "git push origin HEAD:refs/heads/other 2>&1", "git push origin :develop 2>&1", `git push origin HEAD:${workA} HEAD:refs/tags/v1 2>&1`]) {
      const foreign = await bash("session-a", a.path, command);
      assert.notEqual(foreign.exitCode, 0, `${command}: ${foreign.output}`);
      assert.match(foreign.output, /403/, command);
    }
    assert.equal(receivePacks(), before, "no refused push reached the fixture");
    assert.equal(remoteHead("main"), mainHead, "main is unchanged");
    assert.equal(remoteHead("develop"), developHead, "develop still exists");
    assert.equal(remoteHasBranch("other"), false);
    assert.equal(git(bare, "tag", "--list"), "");
  });

  await step("6 status, guarded removal, and list", async () => {
    const status = await boot.workspaceGit.status(HOST, "session-a");
    assert.deepEqual([status.unpushedCommits, status.pushedOnce, status.uncommittedFiles, status.ahead, status.behind], [0, true, 0, 0, 0]);
    await writeFile(join(a.path, "scratch.txt"), "uncommitted\n");
    assert.deepEqual(await boot.workspaceGit.remove(HOST, "session-a", false), { removed: false, uncommittedFiles: 1, unpushedCommits: 0 });
    assert.ok(existsSync(join(a.path, "scratch.txt")));
    assert.deepEqual(await boot.workspaceGit.remove(HOST, "session-a", true), { removed: true, uncommittedFiles: 1, unpushedCommits: 0 });
    assert.equal(existsSync(a.path), false);
    // The fork has nothing unpushed any more (its commit is on the remote): no force needed.
    assert.deepEqual(await boot.workspaceGit.remove(HOST, "session-c", false), { removed: true, uncommittedFiles: 0, unpushedCommits: 0 });
    const listed = await boot.workspaceGit.list(HOST);
    assert.deepEqual(listed.map((worktree) => worktree.sessionId), ["session-b"]);
    assert.equal(remoteHead(workA), committed, "removing a worktree never deletes the remote branch");
    assert.ok(existsSync(join(b.path, "develop.txt")));
  });

  await step("7 without the credential, git fails closed with an authentication error", async () => {
    const fetched = await bash("session-b", b.path, "git fetch 2>&1");
    assert.equal(fetched.exitCode, 0, fetched.output);
    token = null;
    await boot.workspaceGit.refreshCredential();
    const seen = fixture.requests.length;
    const started = Date.now();
    const refused = await bash("session-b", b.path, "git fetch 2>&1");
    assert.ok(Date.now() - started < 30_000, "the fetch failed promptly");
    assert.notEqual(refused.exitCode, 0, refused.output);
    assert.match(refused.output, /terminal prompts disabled|Authentication failed|could not read Username|error: 401/i, refused.output);
    assert.equal(fixture.requests.length, seen, "nothing reached the fixture without a credential");
    // The host's own push fails the same way, as a typed job error.
    const { jobId } = await boot.workspaceGit.push(HOST, "session-b");
    const { job } = await pollJob(jobId);
    assert.deepEqual([job.state, job.error?.code], ["failed", "WORKSPACE_GIT_AUTH_REQUIRED"]);
    assert.equal(fixture.requests.length, seen);
    boot.workspaceGit.setCredentialProvider(null);
    await boot.reconnectHost(HOST);
    const reconnected = await bash("session-b", b.path, "git fetch 2>&1");
    assert.notEqual(reconnected.exitCode, 0, reconnected.output);
    assert.match(reconnected.output, /terminal prompts disabled|Authentication failed|could not read Username|error: 401/i);
    assert.equal(fixture.requests.length, seen, "a fresh unauthenticated connection also cannot contact GitHub");
    boot.workspaceGit.setCredentialProvider(async () => token);
  });

  await step("8 the token is nowhere on the host's disk, in a URL, or in a log", async () => {
    const basic = Buffer.from(`x-access-token:${FIXTURE_TOKEN}`).toString("base64");
    const needles = [Buffer.from(FIXTURE_TOKEN), Buffer.from(basic)];
    const files = [...await filesUnder(hostDataDir), ...await filesUnder(workspacesRoot)];
    assert.ok(files.length > 20, "the scan covered the data directory and the workspaces");
    for (const file of files) {
      const content = await readFile(file);
      for (const needle of needles) assert.equal(content.includes(needle), false, `${file} contains the token`);
    }
    for (const request of fixture.requests) {
      assert.equal(`${request.path}?${request.query}`.includes(FIXTURE_TOKEN), false, "the token was never part of a URL");
    }
    const logs = [...hostLogs, ...desktopLogs].join("\n");
    assert.equal(logs.includes(FIXTURE_TOKEN), false, "no log line carries the token");
    assert.equal(logs.includes(basic), false);
    assert.equal(/\/[0-9a-f]{64}\//.test(logs), false, "no log line carries a proxy handle");
    // The worktree's git configuration names neither the proxy nor a credential.
    const config = await readFile(join(workspacesRoot, "repos/github.com/octo/repo/.git/config"), "utf8");
    assert.equal(/127\.0\.0\.1|insteadOf|credential/i.test(config), false, config);
  });

  await step("9 create a repository session, run setup, and relay tools to the bound checkout", async () => {
    token = FIXTURE_TOKEN;
    await boot.workspaceGit.refreshCredential();
    localHost = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: join(root, "local-host"), onStderr: (text) => hostLogs.push(String(text)) });
    await localHost.handshake();
    const call = (method, params) => localHost.call(method, params);
    const events = [];
    const requests = new Map();
    let lastPullRequestNumber = 0;
    let lookupError = null;
    let cancelOnLookup = false;
    let isPullRequestTurnActive = true;
    const connector = {
      status: async () => ({ connected: true }),
      findPullRequest: async (_repository, head, state) => {
        // Every state: a merged or closed request must stay visible.
        assert.equal(state, undefined);
        if (cancelOnLookup) isPullRequestTurnActive = false;
        if (lookupError) throw lookupError;
        return requests.get(head) ?? null;
      },
      createPullRequest: async (_repository, input) => {
        assert.deepEqual(_repository, repository);
        assert.equal(input.base, "main");
        assert.ok(remoteHasBranch(input.head), "the branch is on the remote before opening its PR");
        const number = ++lastPullRequestNumber;
        const result = { number, url: `https://github.com/octo/repo/pull/${number}`, state: "open", ...input };
        requests.set(input.head, result);
        return result;
      },
    };
    const dispatch = Promise.withResolvers();
    const dispatched = [];
    const queueStore = createHostQueueStore(() => localHost);
    const localAgentHost = new AgentHost({
      sessions: createHostSessionPort(() => localHost), queueStore,
      runtime: {
        async prompt(request) {
          dispatched.push(request);
          return { turnId: "reclaimed-fixture-turn" };
        },
        async canDispatchQueued(sessionId) {
          const { session } = await call("session.get", { id: sessionId, messageLimit: 1 });
          return session?.remoteRepository?.state === "ready";
        },
        async stop() { return { requested: false }; }, async abort() {}, async respondInput() {},
      },
      approvals: { async resolveTool() {}, async resolveContract() {}, async listPendingTools() { return []; } },
      onQueueChange(_sessionId, entries) {
        if (dispatched.length && !entries.length) dispatch.resolve();
      },
    });
    const emit = (channel, payload) => {
      events.push({ channel, payload });
      if (payload.remoteRepository?.state === "ready" && localAgentHost.queueEntries(payload.sessionId).length) {
        localAgentHost.kick(payload.sessionId);
      }
    };
    let safeRemoval = true;
    const removalCalls = [];
    const gitPort = { ...boot.workspaceGit,
      supportsSafeRemoval: (key) => safeRemoval && boot.workspaceGit.supportsSafeRemoval(key),
      remove: (...args) => {
        removalCalls.push(args);
        return boot.workspaceGit.remove(...args);
      },
    };
    const hostPort = () => ({ ...boot, workspaceGit: gitPort });
    const workspaces = createSessionWorkspaces({ call, hosts: hostPort, connector, emit, log: (message, error) => hostLogs.push(`${message}: ${error}`) });
    repositorySessions = workspaces;
    const repositoryGit = createSessionWorkspaceGit({ call, workspaces, connector, emit });
    const githubSessionTools = createGitHubSessionTools(() => ({ workspaces, connector, git: repositoryGit }));
    const pluginHost = {
      call,
      onNotification(handler) {
        localHost.onNotification((method, params) => {
          if (method === "plugins.execute") handler(method, params);
        });
      },
      onExit() {},
    };
    createHostRuntime({
      runtimeState: { host: pluginHost }, logger: { app() {} }, sessionProjects: new Map(),
      plugins: { getTools: () => [], drainToasts: () => [] }, githubSessionTools,
      isTurnDispatchable: (_sessionId, turnId) => isPullRequestTurnActive && turnId === "agent-pr-turn",
    }).wireHost(pluginHost);
    const environment = await workspaces.upsert({
      hostKey: HOST, name: "Fixture setup", variables: [{ name: "E2E_SETUP_VALUE", value: "setup-value" }],
      setupScript: 'printf "%s" "$E2E_SETUP_VALUE" > setup.txt',
    });
    const { projectPath } = await workspaces.resolve({ environmentId: environment.id, repository, defaultBranch: "main" });
    assert.equal((await workspaces.resolve({ environmentId: environment.id, repository, defaultBranch: "main" })).projectPath, projectPath);
    const { session } = await call("session.create", { projectPath, mode: "agent" });
    const { session: unbound } = await call("session.create", { projectPath, mode: "agent" });
    let relayCalls = 0;
    const relay = createRemoteWorkspaceToolRelay(localHost, {
      getBoot: () => boot, isCurrent: () => true, isTurnDispatchable: () => true, log: () => {},
    });
    const off = localHost.onNotification((method, params) => {
      if (method === "tools.remoteExecute") { relayCalls++; void relay.execute(params); }
      if (method === "tools.remoteAbort") relay.cancel(params);
      if (method === "permissions.request") void call("permissions.resolve", { requestId: params.requestId, decision: "allow-once" });
    });
    try {
      const read = (sessionId) => call("tools.execute", { sessionId, turnId: "local-tool-turn", toolCallId: "read-setup", toolName: "Read", mode: "agent", args: { path: "setup.txt" } });
      await assert.rejects(read(unbound.id), (error) => error.data?.errorCode === "REMOTE_WORKSPACE_NOT_READY");
      assert.equal(relayCalls, 0);
      await workspaces.start({ sessionId: session.id, environmentId: environment.id, repository, baseBranch: "main" });
      await workspaces.waitUntilReady(session.id);
      const { session: ready } = await call("session.get", { id: session.id, messageLimit: 1 });
      assert.equal(ready.remoteRepository.state, "ready");
      assert.equal(ready.remoteRepository.setup.status, "ok");
      assert.equal(await readFile(join(ready.remoteWorkspace.path, "setup.txt"), "utf8"), "setup-value");
      const result = await read(session.id);
      assert.ok(result.ok, JSON.stringify(result));
      assert.match(JSON.stringify(result), /setup-value/);
      assert.equal(relayCalls, 1);
      const localData = join(root, "local-host");
      const text = "Desktop attachment marker. " + "A checklist entry.\n".repeat(40);
      const [pasted] = await saveComposerPasteFiles(localData, session.id, [
        { name: "pasted-text-list.txt", mimeType: "text/plain", data: new TextEncoder().encode(text).buffer },
      ]);
      await call("session.appendMessage", { sessionId: session.id, message: {
        id: "desktop-attachment-message", role: "user",
        content: `Review the checklist ${formatFileInsert(pasted.path, "file").trim()}`,
        createdAt: new Date().toISOString(),
      } });
      const localRead = await call("tools.execute", {
        sessionId: session.id, toolCallId: "read-desktop-attachment", toolName: "Read",
        mode: "agent", args: { path: pasted.path },
      });
      assert.ok(localRead.ok, JSON.stringify(localRead));
      assert.match(localRead.content.content, /Desktop attachment marker/);
      assert.equal(relayCalls, 1, "attachment path and bytes never went to the remote Host");
      assert.ok(!existsSync(join(workspacesRoot, "repos/github.com/octo/repo/setup.txt")));
      const committedInSession = await bash(session.id, ready.remoteWorkspace.path, "git add setup.txt && git -c user.name='PI E2E' -c user.email=pi-e2e@example.invalid commit -qm setup");
      assert.equal(committedInSession.exitCode, 0, committedInSession.output);
      const { session: child } = await call("session.fork", { sessionId: session.id });
      await workspaces.ensureSession(child.id, session.id);
      await workspaces.waitUntilReady(child.id);
      const childBinding = await workspaces.binding(child.id);
      assert.equal(git(childBinding.path, "rev-parse", "HEAD"), git(ready.remoteWorkspace.path, "rev-parse", "HEAD"));
      assert.equal(boot.workspaceGit.supportsSafeRemoval(HOST), true);
      // A deleted directory is explicit on the wire. Reconnecting restores
      // the session from its actual work branch even if its environment is gone.
      const head = git(ready.remoteWorkspace.path, "rev-parse", "HEAD");
      await workspaces.removeEnvironment(environment.id);
      await rm(ready.remoteWorkspace.path, { recursive: true });
      const missingCheckout = await boot.workspaceGit.status(HOST, session.id);
      assert.equal(missingCheckout.worktree.checkoutPresent, false);
      assert.equal(missingCheckout.unpushedCommits, 1);
      await workspaces.resume(HOST);
      await workspaces.waitUntilReady(session.id);
      assert.equal(git(ready.remoteWorkspace.path, "rev-parse", "HEAD"), head);

      assert.equal(await githubSessionTools.available(unbound.id), false);
      assert.equal(await githubSessionTools.available(session.id), true);
      const publishByAgent = (args) => call("tools.execute", {
        sessionId: session.id, turnId: "agent-pr-turn", toolCallId: "publish-pr",
        toolName: githubSessionPullRequestTool.name, mode: "agent", declaredRisk: "high", args,
      });
      cancelOnLookup = true;
      const cancelled = await publishByAgent({ title: "Cancelled" });
      assert.equal(cancelled.errorCode, "TOOL_TURN_CANCELLED", JSON.stringify(cancelled));
      assert.equal(remoteHasBranch((await workspaces.binding(session.id)).workBranch), false);
      cancelOnLookup = false;
      isPullRequestTurnActive = true;
      // E2E-REMOTE-agent-pushes-session-branch-through-connector: the Agent
      // pushes without a pull request, Plan turns cannot, and an up-to-date
      // branch answers with its counts instead of failing.
      const pushByAgent = (mode) => call("tools.execute", {
        sessionId: session.id, turnId: "agent-pr-turn", toolCallId: `push-${mode}`,
        toolName: githubSessionPushTool.name, mode, declaredRisk: "high", args: {},
      });
      // Host-core authorizes with the durable session mode, so the session
      // itself must be in Plan for the refusal to be real.
      await call("session.configure", { id: session.id, mode: "plan" });
      const planPush = await pushByAgent("plan");
      assert.equal(planPush.errorCode, "PLUGIN_DISABLED_IN_PLAN", JSON.stringify(planPush));
      assert.equal(remoteHasBranch((await workspaces.binding(session.id)).workBranch), false);
      await call("session.configure", { id: session.id, mode: "agent" });
      const pushed = await pushByAgent("agent");
      assert.equal(pushed.ok, true, JSON.stringify(pushed));
      assert.equal(pushed.content.pushed, true);
      assert.equal(pushed.content.workBranch, (await workspaces.binding(session.id)).workBranch);
      assert.equal(pushed.content.unpushedCommits, 0);
      assert.equal(remoteHasBranch(pushed.content.workBranch), true);
      assert.equal(events.filter(({ channel, payload }) => channel === IPC.event.remoteSessionPushProgress
        && payload.sessionId === session.id).at(-1)?.payload.active, false, "the composer must clear push progress");
      const upToDate = await pushByAgent("agent");
      assert.equal(upToDate.ok, true, JSON.stringify(upToDate));
      assert.equal(upToDate.content.pushed, false);
      const published = await publishByAgent({ title: "Fixture PR", draft: true });
      assert.equal(published.ok, true, JSON.stringify(published));
      const pushEvents = events.filter(({ channel, payload }) => channel === IPC.event.remoteSessionPushProgress && payload.sessionId === session.id);
      assert.equal(pushEvents.at(-1)?.payload.active, false, "the composer must clear progress when publication finishes");
      const pr = published.content;
      assert.equal(pr.number, 1);
      assert.equal(pr.draft, true);
      assert.equal((await repositoryGit.create(session.id, { title: "Ignored duplicate", body: "", draft: false })).title, "Fixture PR");
      lookupError = new Error("fixture GitHub lookup unavailable");
      await assert.rejects(repositoryGit.find(session.id), /lookup unavailable/);
      assert.equal((await workspaces.binding(session.id)).pullRequest.number, 1);
      lookupError = null;
      requests.set(pr.head, { ...pr, state: "closed" });
      assert.equal((await repositoryGit.find(session.id)).state, "closed");
      // The closed request stays linked with its state instead of vanishing.
      assert.deepEqual((await workspaces.binding(session.id)).pullRequest, { number: 1, url: pr.url, state: "closed", draft: true });
      const replacement = await repositoryGit.create(session.id, { title: "Replacement PR", body: "", draft: false });
      assert.equal(replacement.number, 2);
      assert.deepEqual((await workspaces.binding(session.id)).pullRequest, { number: 2, url: replacement.url, state: "open", draft: false });

      assert.equal(boot.workspaceGit.supportsReclaim(HOST), true);
      const checkout = ready.remoteWorkspace.path;
      const sharedCheckout = join(workspacesRoot, "repos/github.com/octo/repo");
      const exclude = join(sharedCheckout, ".git/info/exclude");
      await writeFile(exclude, `${await readFile(exclude, "utf8")}\nnode_modules/\n.env.local\n`);
      await bash(session.id, checkout, "mkdir -p node_modules");
      await writeFile(join(checkout, "node_modules/dependency"), "cache");
      await writeFile(join(checkout, ".env.local"), "LOCAL_VALUE=fixture");
      const beforeReclaim = await workspaces.binding(session.id);
      const protectedResult = await workspaces.reclaim(beforeReclaim, []);
      assert.equal(protectedResult.reclaimed, false);
      assert.equal(protectedResult.reason, "protectedIgnoredFiles");
      assert.equal(await readFile(join(checkout, ".env.local"), "utf8"), "LOCAL_VALUE=fixture");
      await rm(join(checkout, ".env.local"));
      const looseCommit = join(sharedCheckout, ".git/objects", head.slice(0, 2), head.slice(2));
      const refs = git(sharedCheckout, "show-ref", "--head");
      const childHead = git(childBinding.path, "rev-parse", "HEAD");
      assert.ok(existsSync(looseCommit));
      assert.equal((await workspaces.reclaim(await workspaces.binding(session.id), [])).reclaimed, true);
      assert.equal(existsSync(checkout), false);
      assert.equal(existsSync(looseCommit), false);
      assert.equal(git(sharedCheckout, "show-ref", "--head"), refs);
      assert.equal(git(childBinding.path, "rev-parse", "HEAD"), childHead);
      assert.equal(git(sharedCheckout, "rev-parse", `refs/heads/${pr.head}`), head);
      await workspaces.resume(HOST);
      const { session: history } = await call("session.get", { id: session.id, messageLimit: 1 });
      assert.equal(history.remoteRepository.state, "reclaimed");
      assert.equal(history.remoteWorkspace, undefined);
      assert.equal(existsSync(checkout), false);

      const editEnvironment = (setupScript) => workspaces.upsert({ id: environment.id, hostKey: HOST, name: environment.name, setupScript });
      await editEnvironment("printf 'fixture initialization failed\\n'; exit 2");
      const input = "Continue with the restored repository";
      const admission = await localAgentHost.startTurn({ subject: "fixture", roles: ["owner"] }, {
        sessionId: session.id, admission: "queue", input: { text: input }, context: { requestId: "fixture-resume" },
      });
      assert.equal(admission.turn.status, "queued");
      await assert.rejects(workspaces.waitUntilReady(session.id), (error) => error.errorCode === "REMOTE_WORKSPACE_NOT_READY");
      const failedRebuild = await workspaces.binding(session.id);
      assert.equal(failedRebuild.error.code, "WORKSPACE_GIT_SETUP_FAILED");
      assert.match(failedRebuild.setup.logTail, /fixture initialization failed/);
      assert.deepEqual((await queueStore.listAll()).map((entry) => entry.content), [input]);
      assert.deepEqual(dispatched, []);
      assert.equal(git(checkout, "rev-parse", "HEAD"), head);
      await editEnvironment("mkdir -p node_modules && printf 'restored' > node_modules/dependency");
      await workspaces.retry(session.id);
      await workspaces.waitUntilReady(session.id);
      await dispatch.promise;
      assert.deepEqual(dispatched.map((request) => request.content), [input]);
      assert.deepEqual(await queueStore.listAll(), []);
      assert.equal(await readFile(join(checkout, "node_modules/dependency"), "utf8"), "restored");
      assert.equal(git(checkout, "rev-parse", "HEAD"), head);
      assert.equal((await workspaces.binding(session.id)).pullRequest.number, 2);

      await writeFile(join(ready.remoteWorkspace.path, "dirty.txt"), "pending work");
      const preflight = await repositoryGit.preflight(session.id);
      assert.deepEqual(preflight, { kind: "atRisk", uncommittedFiles: 1, unpushedCommits: 0 });
      await assert.rejects(repositoryGit.beforeDelete(session.id, false), (error) => error.errorCode === "CONFLICT");
      assert.ok(existsSync(join(ready.remoteWorkspace.path, "dirty.txt")));
      await repositoryGit.beforeDelete(session.id, true);
      await call("session.delete", { id: session.id });
      assert.equal(await workspaces.binding(session.id), null);
      assert.ok(!existsSync(ready.remoteWorkspace.path));
      assert.ok(remoteHasBranch(pr.head));
      assert.ok(events.some(({ payload }) => payload.remoteRepository?.state === "preparing"));
      assert.ok(events.some(({ payload }) => payload.remoteRepository?.state === "ready"));
      // Losing the original job (such as during a Host restart) still
      // recovers the canonical checkout through the Host's worktree list.
      await rm(childBinding.path, { recursive: true });
      await workspaces.update(child.id, { state: "preparing", jobId: "job-lost-after-restart" });
      await workspaces.resume(HOST);
      await workspaces.waitUntilReady(child.id);
      assert.equal((await workspaces.binding(child.id)).path, childBinding.path);
      assert.equal(git(childBinding.path, "rev-parse", "HEAD"), head);

      const runningSetup = (sessionId) => events.some(({ payload }) => payload.sessionId === sessionId
        && payload.remoteRepository?.phase === "runningSetup");
      const pendingRemovals = async () => (await call("sessionWorkspace.pendingRemoval.list", { hostKey: HOST })).removals;
      const connectFailed = (error) => (error.errorCode ?? error.code) === "REMOTE_CONNECTION_FAILED";

      // E2E-REMOTE-repo-session-delete-during-prepare-removes-worktree
      const slow = await workspaces.upsert({ hostKey: HOST, name: "Slow setup", setupScript: "sleep 30" });
      const { session: preparing } = await call("session.create", { projectPath, mode: "agent" });
      await workspaces.start({ sessionId: preparing.id, environmentId: slow.id, repository, baseBranch: "main" });
      await until(() => runningSetup(preparing.id), "the slow setup to start");
      const preparingTree = (await boot.workspaceGit.status(HOST, preparing.id)).worktree;
      assert.ok(existsSync(preparingTree.path));
      assert.deepEqual(await repositoryGit.preflight(preparing.id), { kind: "clean" });
      const deleteStarted = Date.now();
      await repositoryGit.beforeDelete(preparing.id, false);
      await call("session.delete", { id: preparing.id });
      assert.ok(Date.now() - deleteStarted < 25_000, "the setup was cancelled, not waited out");
      assert.equal(await workspaces.binding(preparing.id), null);
      assert.ok(!existsSync(preparingTree.path), "the cancelled worktree is removed");
      assert.ok(!(await boot.workspaceGit.list(HOST)).some((tree) => tree.sessionId === preparing.id));
      assert.equal(git(sharedCheckout, "branch", "--list", preparingTree.workBranch), "");
      assert.deepEqual(await pendingRemovals(), []);

      // E2E-REMOTE-repo-session-preparation-resumes-after-host-reconnect
      const acrossReconnect = await workspaces.upsert({ hostKey: HOST, name: "Setup across a reconnect", setupScript: "sleep 2; printf resumed > resumed.txt" });
      const { session: interrupted } = await call("session.create", { projectPath, mode: "agent" });
      await workspaces.start({ sessionId: interrupted.id, environmentId: acrossReconnect.id, repository, baseBranch: "main" });
      await until(() => runningSetup(interrupted.id), "setup to start before the Host goes away");
      await takeHostOffline();
      const offlinePreparation = await until(async () => {
        const current = await workspaces.binding(interrupted.id);
        return current?.state === "failed" && current;
      }, "the preparation to report the unreachable Host");
      assert.equal(offlinePreparation.error.code, "REMOTE_TARGET_HOST_OFFLINE");
      assert.ok(events.some(({ payload }) => payload.sessionId === interrupted.id
        && payload.remoteRepository?.error?.code === "REMOTE_TARGET_HOST_OFFLINE"), "the renderer is told");
      await bringHostOnline();
      // What the Host's connect handler runs.
      await workspaces.resume(HOST);
      await workspaces.waitUntilReady(interrupted.id);
      const resumedPreparation = await workspaces.binding(interrupted.id);
      assert.equal(resumedPreparation.error, null);
      assert.equal(await readFile(join(resumedPreparation.path, "resumed.txt"), "utf8"), "resumed");

      // E2E-REMOTE-repo-session-offline-delete-records-pending-removal
      await takeHostOffline();
      await assert.rejects(boot.workspaceGit.status(HOST, child.id), connectFailed, "the real connect error reaches the delete flow");
      assert.deepEqual(await repositoryGit.status(child.id), { reachable: false, workBranch: childBinding.workBranch, baseBranch: "main" });
      assert.deepEqual(await repositoryGit.preflight(child.id), { kind: "unknown" });
      // Only the user's confirmation of the warning lets the Host be skipped.
      await assert.rejects(repositoryGit.beforeDelete(child.id, false), connectFailed);
      assert.deepEqual(await pendingRemovals(), []);
      await repositoryGit.beforeDelete(child.id, true);
      await call("session.delete", { id: child.id });
      assert.equal((await pendingRemovals()).length, 1);
      assert.ok(existsSync(childBinding.path));
      await bringHostOnline();
      const recovered = createSessionWorkspaceGit({ call, workspaces, connector, emit });
      safeRemoval = false;
      const beforeLegacyReconcile = removalCalls.length;
      await recovered.reconcile(HOST);
      assert.equal(removalCalls.length, beforeLegacyReconcile, "legacy hosts never receive automatic removal requests");
      assert.ok(existsSync(childBinding.path));
      safeRemoval = true;
      assert.ok((await recovered.leftovers(HOST)).some((tree) => tree.sessionId === child.id));
      const beforeReconcile = events.length;
      await recovered.reconcile(HOST);
      assert.ok(!existsSync(childBinding.path));
      assert.ok(events.slice(beforeReconcile).some(({ payload }) => payload.reason === "remote.leftovers.changed"));
      assert.ok(!(await recovered.leftovers(HOST)).some((tree) => tree.sessionId === child.id));
      await recovered.reconcile(HOST);
      assert.deepEqual((await call("sessionWorkspace.pendingRemoval.list", { hostKey: HOST })).removals, []);
    } finally {
      off?.();
    }
  });

  // ---- Push lease, typed rejection, squash-merged work, SSH rewrite, and
  // redacted tool output (fix/cloud-host-git, D694). Scenarios
  // `E2E-REMOTE-git-push-rebased-branch-with-lease`,
  // `E2E-REMOTE-git-squash-merged-work-counts-as-pushed`, and
  // `E2E-REMOTE-git-ssh-url-uses-proxy`. Kept as one separate block.
  await step("10 a rebased work branch replaces its remote only under a lease (E2E-REMOTE-git-push-rebased-branch-with-lease)", async () => {
    token = FIXTURE_TOKEN;
    await boot.workspaceGit.refreshCredential();
    const before = remoteHead(workB);
    // The Agent rewrites its branch, as a rebase onto a moved base would.
    const rewrite = await bash("session-b", b.path, "git reset -q --hard HEAD~1 && printf 'rebased\\n' > rebased.txt && git add rebased.txt && git -c user.name='PI E2E' -c user.email=pi-e2e@example.invalid commit -q -m rebased");
    assert.equal(rewrite.exitCode, 0, rewrite.output);
    const rebased = git(b.path, "rev-parse", "HEAD");
    const plain = await pollJob((await boot.workspaceGit.push(HOST, "session-b")).jobId);
    assert.deepEqual([plain.job.state, plain.job.error?.code], ["failed", "WORKSPACE_GIT_PUSH_REJECTED"], JSON.stringify(plain.job));
    assert.equal(remoteHead(workB), before, "a plain push never replaces the remote branch");
    const leased = await pollJob((await boot.workspaceGit.push(HOST, "session-b", { forceWithLease: true })).jobId);
    assert.deepEqual([leased.job.state, leased.job.pushed], ["succeeded", { branch: workB, remoteHead: rebased }], JSON.stringify(leased.job));
    assert.equal(remoteHead(workB), rebased);
    assert.equal(remoteHead("develop"), developHead, "the lease names the work branch only");
  });

  await step("11 squash-merged work does not count as unpushed after its branch is deleted (E2E-REMOTE-git-squash-merged-work-counts-as-pushed)", async () => {
    // "GitHub" merged the pull request and deleted its head branch.
    git(bare, "branch", "-D", "--", workB);
    const fetched = await bash("session-b", b.path, "git fetch --prune 2>&1");
    assert.equal(fetched.exitCode, 0, fetched.output);
    const status = await boot.workspaceGit.status(HOST, "session-b");
    assert.deepEqual([status.pushedOnce, status.unpushedCommits, status.uncommittedFiles], [false, 0, 0]);
  });

  await step("12 the session repository's SSH URLs go through the proxy, and tool output names no handle (E2E-REMOTE-git-ssh-url-uses-proxy)", async () => {
    const receivePacks = () => fixture.requests.filter(isRefUpdate).length;
    const before = receivePacks();
    // A small post buffer makes git probe first and then stream the pack after
    // the refusal, as it does for any large push.
    const foreign = await bash("session-b", b.path, "git -c http.postBuffer=4096 push git@github.com:octo/repo.git HEAD:main 2>&1");
    assert.notEqual(foreign.exitCode, 0, foreign.output);
    assert.match(foreign.output, /403/, "the proxy, not the host user's SSH key, answered");
    assert.equal(receivePacks(), before);
    assert.equal(remoteHead("main"), mainHead);
    const own = await bash("session-b", b.path, `git push ssh://git@github.com/octo/repo.git HEAD:refs/heads/${workB} 2>&1`);
    assert.equal(own.exitCode, 0, own.output);
    assert.equal(remoteHead(workB), git(b.path, "rev-parse", "HEAD"));
    const printed = await bash("session-b", b.path, 'printf "%s" "$GIT_CONFIG_KEY_0"');
    assert.match(printed.output, /url\.https:\/\/github\.com\/octo\/repo\.git\.insteadOf/);
    assert.equal(/[0-9a-f]{64}/.test(printed.output) || printed.output.includes("127.0.0.1"), false, printed.output);
  });

  await boot.removeHost(HOST);
  console.log("PASS remote git worktrees: clone, isolated worktrees, proxied push, guarded removal, idle reclaim, exact-commit restore, and queued input after setup retry");
} catch (error) {
  console.error(`FAILED - ${currentStep}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  repositorySessions?.dispose();
  await localHost?.dispose().catch(() => undefined);
  await boot?.closeAll().catch(() => undefined);
  server?.close();
  await binding?.close().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  await host?.dispose().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
