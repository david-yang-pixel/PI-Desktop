import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createBuiltinGitHubMcp } = await import("../electron/main/github/builtin-mcp.ts");

test("the built-in GitHub tools use the current connector token without sharing it with user servers", async () => {
  let enabled = true;
  let token = "fixture-connector-token";
  let statusReads = 0;
  const builtin = createBuiltinGitHubMcp({
    enabled: async () => enabled,
    connector: () => ({
      status: async () => { statusReads++; return { connected: Boolean(token) }; },
      token: async () => token,
      withAgentToolsDeviceToken: async () => null,
    }),
  });
  const oauth = builtin.oauth({ getValidAccessToken: async () => "user-server-token", hasOAuth: async () => true });
  const custom = { id: "github", url: "https://example.invalid/custom" };
  const [record] = await builtin.merge([]);
  assert.equal(record.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(record.headers["X-MCP-Toolsets"], "issues,pull_requests");
  assert.equal(await oauth.getValidAccessToken("github", { ...record }), token);
  assert.equal(await oauth.getValidAccessToken("github", custom), "user-server-token");
  assert.equal(await oauth.getValidAccessToken("other", record), "user-server-token");
  assert.deepEqual(await builtin.merge([custom]), [custom]);
  assert.equal(await builtin.state([custom]), "shadowed");
  token = "replacement";
  assert.equal(await oauth.getValidAccessToken("github", record), token);
  enabled = false;
  const before = statusReads;
  assert.deepEqual(await builtin.merge([]), []);
  assert.equal(statusReads, before);
  assert.equal(await oauth.getValidAccessToken("github", record), null);
  enabled = true;
  token = null;
  assert.equal(await builtin.state([]), "disconnected");
});

const { createGitHubConnector } = await import("../electron/main/github/connector.ts");
const { createGitHubApi } = await import("../electron/main/github/github-api.ts");
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");

const HOSTED = "https://api.githubcopilot.com/mcp/";
const REST = "https://api.github.com";
const DEVICE_TOKEN = "gho_agentToolsFixture01";
const CUSTOM_TOKEN = "custom-server-fixture";
const PROJECT = "/projects/github-tools";
const REPO = { owner: "example", repo: "app" };
const ISSUE = { number: 7, title: "Example issue", body: "Issue body", state: "open", html_url: "https://github.com/example/app/issues/7" };
const PULL = { ...ISSUE, number: 8, html_url: "https://github.com/example/app/pull/8", head: { ref: "fix" }, base: { ref: "main" } };
const OK = { content: [{ type: "text", text: "hosted result" }] };
const mcpReply = (request, result) => Response.json({ jsonrpc: "2.0", id: request.id, result });
const toolText = (result) => JSON.parse(result.content[0].text);

function fixture(t, { hosted, rest, kind = "oauth" }) {
  let enabled = true;
  let credential = { version: 1, kind, token: DEVICE_TOKEN, login: "fixture", scopes: ["repo"], savedAt: "2026-11-20T00:00:00.000Z" };
  const requests = [];
  const audit = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const authorization = new Headers(init.headers).get("authorization");
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method, authorization, body, redirect: init.redirect });
    if (url.href === HOSTED) {
      assert.equal(authorization, `Bearer ${credential.token}`);
      assert.equal(new Headers(init.headers).get("x-mcp-toolsets"), "issues,pull_requests");
      const response = await hosted?.(body, init);
      if (response) return response;
    } else if (url.origin === REST) {
      assert.equal(authorization, `Bearer ${credential.token}`);
      assert.equal(init.redirect, "manual");
      if (url.pathname === "/user") return (await rest?.(url, init, body)) ?? Response.json({ login: "fixture" });
      const response = await rest?.(url, init, body);
      assert.ok(response, `unexpected REST request for ${url.pathname}`);
      return response;
    } else {
      assert.equal(url.href, "https://example.invalid/custom");
      assert.equal(authorization, `Bearer ${CUSTOM_TOKEN}`);
    }
    switch (body.method) {
      case "initialize": return mcpReply(body, { capabilities: { tools: {} } });
      case "notifications/initialized": return new Response(null, { status: 202 });
      case "tools/list": return mcpReply(body, { tools: [{ name: "hosted_probe" }] });
      case "tools/call": return mcpReply(body, OK);
      default: assert.fail(`unexpected MCP method ${body.method}`);
    }
  };
  const connector = createGitHubConnector({
    store: { read: async () => credential },
    api: createGitHubApi({ fetchImpl }),
    clientId: "fixture-client",
    emit: (...args) => audit.push(args),
    log: (...args) => audit.push(args),
    now: () => new Date("2026-11-20T00:00:00.000Z"),
  });
  const builtin = createBuiltinGitHubMcp({ connector: () => connector, enabled: async () => enabled, fetchImpl });
  const runtime = new UserMcpRuntime({
    createClient: (config) => new McpServerClient({ ...config, fetchImpl }),
    createBuiltinGitHubClient: builtin.createClient,
    oauth: builtin.oauth({ getValidAccessToken: async () => CUSTOM_TOKEN, hasOAuth: async () => true }),
    audit: (entry) => audit.push(entry),
    log: (...args) => audit.push(args),
  });
  connector.onChange(() => runtime.invalidateBuiltinGitHub());
  t.after(() => runtime.disposeAll());
  return {
    runtime, requests, audit, connector,
    setEnabled: (value) => { enabled = value; },
    replaceToken: (token) => { credential = { ...credential, token }; },
    async discover(records = [], configured = records) {
      runtime.setRecords(await builtin.merge(records, configured), PROJECT);
      return runtime.toolsForProject(PROJECT);
    },
    call: (name, args) => runtime.callTool(`mcp_github_${name}`, args, PROJECT, "session-1"),
  };
}

test("session discovery recovers a rejected Device Flow token and dispatches REST reads and writes as MCP tools", async (t) => {
  const f = fixture(t, {
    hosted: (request) => request.method === "tools/list" ? new Response(DEVICE_TOKEN, { status: 401 }) : undefined,
    rest: (url, { method }, body) => {
      const route = url.pathname.slice("/repos/example/app".length);
      if (route === "/issues" && method === "GET") {
        assert.equal(url.searchParams.get("page"), "2");
        return Response.json([ISSUE, { ...PULL, pull_request: {} }], {
          headers: { link: '<https://example.invalid/never-follow>; rel="next"' },
        });
      }
      if (route === "/issues/7") return Response.json({ ...ISSUE, body: `Echo ${DEVICE_TOKEN}` });
      if (route === "/pulls") {
        if (method === "GET") return Response.json([PULL]);
        assert.deepEqual(body, { title: "Fix it", head: "fix", base: "main" });
        return Response.json(PULL, { status: 201 });
      }
      if (route === "/pulls/8") return Response.json(PULL);
      if (route === "/issues" && method === "POST") {
        assert.deepEqual(body, { title: "Report it", body: "Details" });
        return Response.json(ISSUE, { status: 201 });
      }
      if (route === "/issues/8/comments") {
        assert.deepEqual(body, { body: "Looks good" });
        return Response.json({ id: 23, body: body.body, html_url: `${PULL.html_url}#issuecomment-23` }, { status: 201 });
      }
    },
  });
  const tools = await f.discover();
  assert.deepEqual(tools.map((tool) => tool.fullName).sort(), [
    "mcp_github_rest_add_issue_comment",
    "mcp_github_rest_create_issue",
    "mcp_github_rest_create_pull_request",
    "mcp_github_rest_issue_read",
    "mcp_github_rest_list_issues",
    "mcp_github_rest_list_pull_requests",
    "mcp_github_rest_pull_request_read",
  ]);
  assert.ok(tools.every((tool) => tool.serverId === "github" && tool.schema.type === "object"));
  assert.deepEqual(f.requests.map((request) => request.body?.method ?? request.url.pathname), [
    "initialize", "notifications/initialized", "tools/list", "/user",
  ]);
  const issues = toolText(await f.call("rest_list_issues", { ...REPO, page: 2 }));
  assert.deepEqual(issues.items.map((item) => item.number), [7]);
  assert.equal(issues.hasMore, true);
  const issue = toolText(await f.call("rest_issue_read", { ...REPO, number: 7 }));
  assert.equal(issue.body, "Echo [redacted]");
  assert.equal(toolText(await f.call("rest_list_pull_requests", REPO)).items[0].number, 8);
  assert.equal(toolText(await f.call("rest_pull_request_read", { ...REPO, number: 8 })).head, "fix");
  assert.equal(toolText(await f.call("rest_create_issue", { ...REPO, title: "Report it", body: "Details" })).number, 7);
  assert.equal(toolText(await f.call("rest_create_pull_request", { ...REPO, title: "Fix it", head: "fix", base: "main" })).number, 8);
  assert.equal(toolText(await f.call("rest_add_issue_comment", { ...REPO, number: 8, body: "Looks good" })).id, 23);
  assert.equal(f.requests.filter((request) => request.url.origin === REST && request.method === "POST").length, 3);
  assert.equal(f.requests.filter((request) => request.body?.method === "tools/call").length, 0);
  assert.ok(!(await f.connector.status()).needsReauthentication);
  assert.ok(!JSON.stringify({ tools, audit: f.audit, status: f.runtime.listStatuses(PROJECT) }).includes(DEVICE_TOKEN));
  const count = f.requests.length;
  await assert.rejects(f.call("rest_issue_read", { owner: "example", repo: "..", number: 7 }), /valid GitHub repository/);
  await assert.rejects(f.call("rest_issue_read", { ...REPO, number: "7" }), /number/);
  assert.equal(f.requests.length, count);
});

test("a rejected hosted mutation is never replayed and the next catalog exposes separate REST actions", async (t) => {
  const f = fixture(t, {
    hosted(request) {
      if (request.method === "tools/list") {
        return mcpReply(request, { tools: [
          { name: "create_issue", description: `Create an issue ${DEVICE_TOKEN}` },
          { name: "rest-create-issue" },
        ] });
      }
      if (request.method === "tools/call") return new Response(null, { status: 403 });
    },
    rest: (_url, init) => init.method === "POST" ? Response.json(ISSUE, { status: 201 }) : undefined,
  });
  const [hostedTool, ...extra] = await f.discover();
  assert.deepEqual(extra, []);
  assert.equal(hostedTool.fullName, "mcp_github_create_issue");
  assert.equal(hostedTool.description, "Create an issue [redacted]");
  await assert.rejects(f.call("create_issue", { ...REPO, title: "First attempt" }), /Check GitHub/);
  assert.equal(f.requests.filter(({ body }) => body?.method === "tools/call").length, 1);
  assert.ok(!f.requests.some(({ url }) => url.origin === REST));

  assert.ok((await f.discover()).some(({ fullName }) => fullName === "mcp_github_rest_create_issue"));
  const requestCount = f.requests.length;
  await assert.rejects(f.call("create_issue", { ...REPO, title: "Stale hosted tool" }), { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(f.requests.length, requestCount);
  assert.equal(toolText(await f.call("rest_create_issue", { ...REPO, title: "An independently requested write" })).number, 7);
  assert.equal(f.requests.filter(({ method, url }) => method === "POST" && url.origin === REST).length, 1);
});

test("hosted success preserves its tool catalog and redacts reflected credentials", async (t) => {
  const f = fixture(t, {
    hosted(request) {
      if (request.method === "tools/call") {
        if (request.params.arguments.fail) {
          return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: `Error 401: ${DEVICE_TOKEN}` } });
        }
        return mcpReply(request, { content: [{ type: "text", text: `Echo ${DEVICE_TOKEN}` }] });
      }
    },
  });
  assert.deepEqual((await f.discover()).map(({ fullName }) => fullName), ["mcp_github_hosted_probe"]);
  assert.equal((await f.call("hosted_probe", {})).content[0].text, "Echo [redacted]");
  await assert.rejects(f.call("hosted_probe", { fail: true }), /Error 401: \[redacted\]/);
  assert.deepEqual((await f.discover()).map(({ fullName }) => fullName), ["mcp_github_hosted_probe"]);
  assert.ok(!f.requests.some(({ url }) => url.origin === REST));
  assert.ok(!JSON.stringify(f.audit).includes(DEVICE_TOKEN));
});

test("only a hosted access rejection can activate Device Flow fallback", async (t) => {
  const cases = [
    ["PAT rejected", { kind: "pat" }, () => new Response(null, { status: 401 })],
    ["rate-limited 403", {}, () => new Response(null, { status: 403, headers: { "retry-after": "5" } })],
    ["rate-limited 429", {}, () => new Response(null, { status: 429 })],
    ["upstream outage", {}, () => new Response(null, { status: 503 })],
    ["request failure containing 401", {}, () => { throw new Error(`Handshake failed: 401 ${DEVICE_TOKEN}`); }],
    ["redirect", {}, () => new Response(null, { status: 307, headers: { location: "https://example.invalid/redirect" } })],
  ];
  for (const [name, options, fail] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t, { ...options, hosted: fail });
      assert.deepEqual(await f.discover(), []);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].url.href, HOSTED);
      assert.equal(f.requests[0].redirect, "manual");
      assert.ok(!JSON.stringify({ audit: f.audit, statuses: f.runtime.listStatuses(PROJECT) }).includes(DEVICE_TOKEN));
    });
  }
});

test("a revoked Device Flow token never contributes REST tools and the connector requests sign-in", async (t) => {
  const f = fixture(t, {
    hosted: () => new Response(null, { status: 401 }),
    rest: () => new Response(DEVICE_TOKEN, { status: 401 }),
  });
  assert.deepEqual(await f.discover(), []);
  assert.equal((await f.connector.status()).needsReauthentication, true);
  assert.equal(await f.connector.token(), null);
  assert.deepEqual(await f.discover(), []);
  assert.deepEqual(f.requests.map(({ url }) => url.href), [HOSTED, `${REST}/user`]);
  assert.ok(!JSON.stringify(f.audit).includes(DEVICE_TOKEN));
});

test("custom GitHub MCP, credential changes, and disabling the built-in take effect on the normal session path", async (t) => {
  const f = fixture(t, {
    hosted(request) {
      if (request.method === "initialize" && f.requests.at(-1).authorization === `Bearer ${DEVICE_TOKEN}`) {
        return new Response(null, { status: 401 });
      }
    },
  });
  assert.ok((await f.discover()).some(({ fullName }) => fullName === "mcp_github_rest_create_issue"));
  f.replaceToken("gho_replacementFixture02");
  assert.deepEqual((await f.discover()).map(({ fullName }) => fullName), ["mcp_github_hosted_probe"]);
  f.replaceToken(DEVICE_TOKEN);
  assert.ok((await f.discover()).some(({ fullName }) => fullName === "mcp_github_rest_create_issue"));
  f.setEnabled(false);
  await assert.rejects(f.call("rest_create_issue", { ...REPO, title: "Disabled" }), { errorCode: "UNAVAILABLE" });
  assert.deepEqual(await f.discover(), []);
  f.setEnabled(true);

  const custom = { id: "github", label: "Custom GitHub", transport: "http", url: "https://example.invalid/custom", enabled: true, level: "global" };
  const count = f.requests.length;
  assert.deepEqual(await f.discover([], [{ ...custom, enabled: false }]), []);
  await assert.rejects(f.call("rest_create_issue", { ...REPO, title: "Shadowed" }), { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(f.requests.length, count);
  assert.deepEqual((await f.discover([custom])).map(({ fullName }) => fullName), ["mcp_github_hosted_probe"]);
  assert.deepEqual(await f.call("hosted_probe", {}), OK);
  assert.ok(f.requests.slice(count).every(({ url, authorization }) =>
    url.href === custom.url && authorization === `Bearer ${CUSTOM_TOKEN}`));
});

test("a failed REST write stays a single request and asks the caller to check GitHub", async (t) => {
  const f = fixture(t, {
    hosted: () => new Response(null, { status: 401 }),
    rest: (url) => url.pathname === "/user" ? undefined : new Response(null, { status: 503 }),
  });
  await f.discover();
  await assert.rejects(f.call("rest_create_issue", { ...REPO, title: "May have been applied" }), /Check GitHub before trying the write again/);
  assert.equal(f.requests.filter(({ method, url }) => method === "POST" && url.origin === REST).length, 1);
  assert.equal(f.requests.filter(({ body }) => body?.method === "tools/call").length, 0);
});

test("session cancellation aborts a REST mutation without replaying it", async (t) => {
  const { promise: started, resolve: start } = Promise.withResolvers();
  const f = fixture(t, {
    hosted: () => new Response(null, { status: 401 }),
    rest: (url, { signal }) => {
      if (url.pathname === "/user") return undefined;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        start();
      });
    },
  });
  await f.discover();
  const pending = f.call("rest_create_issue", { ...REPO, title: "Cancelled" });
  await started;
  f.runtime.cancelSessionCalls("session-1");
  await assert.rejects(pending, { code: "TOOL_ABORTED", message: /Check GitHub/ });
  assert.equal(f.requests.filter(({ method, url }) => method === "POST" && url.origin === REST).length, 1);
});
