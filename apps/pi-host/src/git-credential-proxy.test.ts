import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { createGitCredentialProxy } from "./git-credential-proxy.js";
import {
  A, B, basic, cleanup, FLUSH, INSTALLATION, PACK, pkt, proxyFor, push, RECEIVE_HEADERS, runCleanup, scope, send, TOKEN, upstream, WORK_BRANCH, ZERO,
} from "./git-credential-proxy.test-support.js";

afterEach(runCleanup);

describe("git credential proxy", () => {
  it("binds loopback and hands out one stable 256-bit handle per scope", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    const url = proxy.register(scope);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/);
    expect(proxy.register({ ...scope })).toBe(url);
    const other = proxy.register({ ...scope, sessionId: "session-2", workBranch: "pi-desktop/000000000000" });
    expect(other).not.toBe(url);
    expect(other).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/);
  });

  it("refuses to register before it is listening", () => {
    const proxy = createGitCredentialProxy({ upstream: "http://127.0.0.1:1" });
    expect(() => proxy.register(scope)).toThrow();
  });

  it("adds the basic credential to a scoped fetch and streams the answer back", async () => {
    const up = await upstream(() => ({ headers: { "x-upstream": "yes" }, body: "001e# service=git-upload-pack\n" }));
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const advertised = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`, { headers: { "git-protocol": "version=2", "user-agent": "git/2.43.0" } });
    expect(advertised.status).toBe(200);
    expect(advertised.body.toString()).toBe("001e# service=git-upload-pack\n");
    expect(advertised.headers["x-upstream"]).toBe("yes");
    const body = Buffer.from("0032want aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n00000009done\n");
    const fetched = await send(`${base}octo/repo.git/git-upload-pack`, { method: "POST", headers: { "content-type": "application/x-git-upload-pack-request" }, body });
    expect(fetched.status).toBe(200);
    expect(up.seen.map((entry) => [entry.method, entry.url, entry.headers.authorization])).toEqual([
      ["GET", "/octo/repo.git/info/refs?service=git-upload-pack", basic],
      ["POST", "/octo/repo.git/git-upload-pack", basic],
    ]);
    expect(up.seen[0]?.headers["git-protocol"]).toBe("version=2");
    expect(up.seen[0]?.headers["user-agent"]).toBe("git/2.43.0");
    expect(up.seen[1]?.body.equals(body)).toBe(true);
  });

  it("answers 401 with nothing upstream when the installation has no token", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    const base = proxy.register(scope);
    const first = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(first.status).toBe(401);
    // Another installation's token is not this scope's token.
    proxy.setToken("11111111-1111-4111-8111-111111111111", TOKEN);
    expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect((await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/${WORK_BRANCH}`) })).status).toBe(401);
    expect(up.seen).toEqual([]);
  });

  it("fails closed as soon as the token is dropped", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/info/refs?service=git-upload-pack`;
    expect((await send(url)).status).toBe(200);
    proxy.setToken(INSTALLATION, null);
    const started = Date.now();
    expect((await send(url)).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(up.seen).toHaveLength(1);
  });

  it("answers 404 for an unknown or unregistered handle", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const origin = new URL(base).origin;
    for (const path of [`/${"f".repeat(64)}/octo/repo.git/info/refs?service=git-upload-pack`, "/octo/repo.git/info/refs?service=git-upload-pack", "/", "/short/octo/repo.git/info/refs"]) {
      expect((await send(`${origin}${path}`)).status, path).toBe(404);
    }
    proxy.unregister(INSTALLATION, "session-1");
    expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(404);
    expect(up.seen).toEqual([]);
    // A scope registered again gets a new handle; the old one stays dead.
    expect(proxy.register(scope)).not.toBe(base);
  });

  it("forwards any other repository without credentials", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    for (const path of ["other/public.git/info/refs?service=git-upload-pack", "octo/repo-two.git/info/refs?service=git-upload-pack", "octo/repo/info/refs?service=git-upload-pack", "Octo/Repo.git/info/refs?service=git-upload-pack"]) {
      expect((await send(`${base}${path}`)).status, path).toBe(200);
    }
    expect(up.seen.map((entry) => entry.url)).toEqual([
      "/other/public.git/info/refs?service=git-upload-pack",
      "/octo/repo-two.git/info/refs?service=git-upload-pack",
      "/octo/repo/info/refs?service=git-upload-pack",
      "/Octo/Repo.git/info/refs?service=git-upload-pack",
    ]);
    for (const entry of up.seen) expect(entry.headers.authorization).toBeUndefined();
  });

  it("never forwards the client's own credentials or cookies", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const headers = { authorization: "Basic Y2xpZW50OnN1cHBsaWVk", cookie: "session=client", "proxy-authorization": "Basic cHJveHk6Y2xpZW50" };
    await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`, { headers });
    await send(`${base}other/public.git/info/refs?service=git-upload-pack`, { headers });
    expect(up.seen).toHaveLength(2);
    expect(up.seen[0]?.headers.authorization).toBe(basic);
    expect(up.seen[1]?.headers.authorization).toBeUndefined();
    for (const entry of up.seen) {
      expect(entry.headers.cookie).toBeUndefined();
      expect(entry.headers["proxy-authorization"]).toBeUndefined();
      expect(JSON.stringify(entry.headers)).not.toContain("Y2xpZW50OnN1cHBsaWVk");
    }
  });

  it("gives credentials only to the smart-HTTP endpoints of the scoped repository", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const anonymous: Array<[string, string]> = [
      ["GET", "octo/repo.git/info/refs"],
      ["GET", "octo/repo.git/info/refs?service=git-upload-archive"],
      ["GET", "octo/repo.git/info/refs?service=git-receive-pack&x=1"],
      ["POST", "octo/repo.git/git-receive-pack?x=1"],
      ["POST", "octo/repo.git/git-receive-pack/"],
      ["POST", "octo/repo.git/GIT-RECEIVE-PACK"],
      ["GET", "octo/repo.git/git-receive-pack"],
      ["GET", "octo/repo.git/objects/info/packs"],
      ["GET", "octo/repo.git/HEAD"],
    ];
    for (const [method, path] of anonymous) {
      const body = method === "POST" ? push(`${A} ${B} refs/heads/main`) : undefined;
      await send(`${base}${path}`, { method, ...(body ? { body } : {}) });
    }
    expect(up.seen).toHaveLength(anonymous.length);
    for (const entry of up.seen) expect(entry.headers.authorization, entry.url).toBeUndefined();
  });

  it("refuses paths that could be resolved to another repository upstream", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    for (const path of [
      "octo/repo.git/../../other/private.git/info/refs?service=git-upload-pack",
      "octo/repo.git/%2e%2e/%2e%2e/other/private.git/info/refs?service=git-upload-pack",
      "octo/repo.git/./info/refs?service=git-upload-pack",
      "octo/repo.git//info/refs?service=git-upload-pack",
      "octo/repo.git/info%2frefs?service=git-upload-pack",
      "octo/repo.git\\info\\refs",
      "octo/repo.git/info/refs;x?service=git-upload-pack",
    ]) {
      // `request` would normalize a URL object; send the raw path instead.
      const target = new URL(base);
      const reply = await new Promise<number>((resolve, reject) => {
        const req = request({ host: target.hostname, port: target.port, path: `${target.pathname}${path}`, method: "GET" }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject);
        req.end();
      });
      expect(reply, path).toBe(400);
    }
    expect(up.seen).toEqual([]);
  });

  it("forwards a push to the work branch byte for byte", async () => {
    const up = await upstream(() => ({ body: "000eunpack ok\n" }));
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const body = push(`${ZERO} ${B} refs/heads/${WORK_BRANCH}`);
    const reply = await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body });
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe("000eunpack ok\n");
    // The same push streamed in small chunks, split inside the command section.
    const chunked = await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: [body.subarray(0, 10), body.subarray(10, 61), body.subarray(61, 2000), body.subarray(2000)] });
    expect(chunked.status).toBe(200);
    // And gzip-encoded, as git sends small requests.
    const zipped = gzipSync(body);
    const gzip = await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: zipped });
    expect(gzip.status).toBe(200);
    expect(up.seen).toHaveLength(3);
    for (const entry of up.seen) {
      expect(entry.method).toBe("POST");
      expect(entry.url).toBe("/octo/repo.git/git-receive-pack");
      expect(entry.headers.authorization).toBe(basic);
      expect(entry.headers["content-type"]).toBe("application/x-git-receive-pack-request");
    }
    expect(up.seen[0]?.body.equals(body)).toBe(true);
    expect(up.seen[1]?.body.equals(body)).toBe(true);
    expect(up.seen[2]?.body.equals(zipped)).toBe(true);
    expect(up.seen[2]?.headers["content-encoding"]).toBe("gzip");
  });

  it("forwards git's empty probe push, which names no ref", async () => {
    // For a pack larger than `http.postBuffer` git first POSTs a body that is
    // one flush packet, to settle authentication before it streams the pack.
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/git-receive-pack`;
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: FLUSH })).status).toBe(200);
    expect((await send(url, { method: "POST", headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: gzipSync(FLUSH) })).status).toBe(200);
    expect(up.seen).toHaveLength(2);
    expect(up.seen[0]?.body.equals(FLUSH)).toBe(true);
    expect(up.seen[0]?.headers.authorization).toBe(basic);
    // Anything after the flush is not a probe.
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: Buffer.concat([FLUSH, FLUSH]) })).status).toBe(403);
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: [FLUSH, PACK] })).status).toBe(403);
    expect(up.seen).toHaveLength(2);
    // Without a token the probe is refused like any other scoped request.
    proxy.setToken(INSTALLATION, null);
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: FLUSH })).status).toBe(401);
    expect(up.seen).toHaveLength(2);
  });

  it("refuses a push that names any other ref before a byte reaches upstream", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/git-receive-pack`;
    const work = `${A} ${B} refs/heads/${WORK_BRANCH}`;
    const refused: Array<[string, Sent]> = [
      ["another branch", { body: push(`${A} ${B} refs/heads/main`) }],
      ["a delete of the base branch", { body: push(`${A} ${ZERO} refs/heads/main`) }],
      ["a tag", { body: push(`${ZERO} ${B} refs/tags/v1`) }],
      ["the work branch mixed with a tag", { body: push(work, `${ZERO} ${B} refs/tags/v1`) }],
      ["a foreign ref first, then the work branch", { body: push(`${A} ${B} refs/heads/main`, work) }],
      ["a prefix of the work branch", { body: push(`${A} ${B} refs/heads/pi-desktop/8b54618f6bc`) }],
      ["a longer name than the work branch", { body: push(`${A} ${B} refs/heads/${WORK_BRANCH}/x`) }],
      ["the work branch name outside refs/heads", { body: push(`${A} ${B} refs/tags/${WORK_BRANCH}`) }],
      ["a gzip-encoded foreign push", { headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: gzipSync(push(`${A} ${B} refs/heads/main`)) }],
      ["a body that is not gzip but says so", { headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: push(work) }],
      ["an unknown content encoding", { headers: { ...RECEIVE_HEADERS, "content-encoding": "br" }, body: push(work) }],
      ["a malformed command section", { body: Buffer.from("zzzz not pkt-lines") }],
      ["no commands at all", { body: Buffer.concat([FLUSH, PACK]) }],
      ["an empty body", { body: Buffer.alloc(0) }],
      ["a command section that never ends", { body: Buffer.concat(Array.from({ length: 900 }, () => pkt(`${A} ${B} refs/heads/${WORK_BRANCH}\n`))) }],
      ["a foreign ref streamed in pieces", { body: [pkt(`${A} ${B} refs/heads/${WORK_BRANCH}\u0000report-status\n`), pkt(`${A} ${B} refs/heads/main\n`), FLUSH, PACK] }],
    ];
    for (const [name, sent] of refused) {
      const reply = await send(url, { method: "POST", headers: RECEIVE_HEADERS, ...sent });
      expect(reply.status, name).toBe(403);
      expect(reply.body.toString().trim().split("\n"), name).toHaveLength(1);
    }
    expect(up.seen).toEqual([]);
    // The proxy still serves the next request.
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: push(work) })).status).toBe(200);
    expect(up.seen).toHaveLength(1);
  });

  it("lets a refused push finish uploading so git reads the refusal instead of a broken pipe", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const url = new URL(`${proxy.register(scope)}octo/repo.git/git-receive-pack`);
    // The command section arrives first and is refused at once; the pack keeps
    // streaming after that, as git's does for a large push. git reads the
    // answer only after it has sent the whole body, so an answer sent earlier
    // (and the socket closing behind it) reaches git as a broken pipe.
    type Outcome = { status: number; body: string; answeredAfterUpload: boolean; uploadError: Error | null };
    const reply = await new Promise<Outcome>((resolve) => {
      let uploaded = false;
      let uploadError: Error | null = null;
      let answer: Omit<Outcome, "uploadError"> | null = null;
      const settle = () => { if (answer && (uploaded || uploadError)) resolve({ ...answer, uploadError }); };
      const req = request(url, { method: "POST", headers: RECEIVE_HEADERS }, (res) => {
        const answeredAfterUpload = uploaded;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => { answer = { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), answeredAfterUpload }; settle(); });
      });
      req.on("finish", () => { uploaded = true; settle(); });
      req.on("error", (error) => {
        uploadError = error;
        if (answer) settle();
        else resolve({ status: 0, body: "", answeredAfterUpload: false, uploadError: error });
      });
      req.write(pkt(`${A} ${B} refs/heads/main\u0000report-status\n`));
      req.write(FLUSH);
      void (async () => {
        await new Promise((settle) => setTimeout(settle, 200));
        const chunk = Buffer.alloc(256 * 1024, 7);
        for (let sent = 0; sent < 16; sent += 1) {
          if (!req.write(chunk)) await new Promise((settle) => req.once("drain", settle));
        }
        req.end();
      })();
    });
    expect(reply.uploadError).toBeNull();
    expect(reply.answeredAfterUpload).toBe(true);
    expect(reply.status).toBe(403);
    expect(reply.body).toContain(`this session may only push refs/heads/${WORK_BRANCH}`);
    expect(up.seen).toEqual([]);
  });

  it("re-registering a scope keeps its handle and applies the new work branch", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    expect(proxy.register({ ...scope, workBranch: "pi-desktop/000000000000" })).toBe(base);
    const url = `${base}octo/repo.git/git-receive-pack`;
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/${WORK_BRANCH}`) })).status).toBe(403);
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/pi-desktop/000000000000`) })).status).toBe(200);
  });

  it("answers 502 when upstream cannot be reached, without leaking the handle", async () => {
    const lines: string[] = [];
    const proxy = await proxyFor("http://127.0.0.1:1", (level, message, data) => lines.push(JSON.stringify({ level, message, data })));
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(502);
    const handle = new URL(base).pathname.split("/")[1]!;
    expect(reply.body.toString()).not.toContain(handle);
    expect(lines.join("\n")).not.toContain(handle);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("gives up on a GitHub that stops answering and says so with 504", async () => {
    // Accepts the request and the body, then never answers.
    const held: Array<() => void> = [];
    const silent = createServer((req, res) => { req.resume(); held.push(() => res.destroy()); });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { for (const release of held) release(); silent.closeAllConnections(); silent.close(() => resolve()); }));
    const lines: string[] = [];
    const proxy = await proxyFor(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, {
      upstreamIdleMs: 200,
      log: (level, message, data) => lines.push(JSON.stringify({ level, message, data })),
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const started = Date.now();
    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reply.body.toString("utf8")).not.toContain(TOKEN);
    expect(lines.join("\n")).toContain("stopped responding");
    expect(lines.join("\n")).not.toContain(new URL(base).pathname.split("/")[1]!);
  });

  it("drops a response whose body stalls after the headers", async () => {
    const held: Array<() => void> = [];
    const stalling = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
      res.write("001e# service=git-upload-pack\n");
      held.push(() => res.destroy());
    });
    await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { for (const release of held) release(); stalling.closeAllConnections(); stalling.close(() => resolve()); }));
    const proxy = await proxyFor(`http://127.0.0.1:${(stalling.address() as AddressInfo).port}`, { upstreamIdleMs: 200 });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    // git must see a cut transfer, never a complete one.
    const outcome = await new Promise<string>((resolve) => {
      const req = request(`${base}octo/repo.git/info/refs?service=git-upload-pack`, (res) => {
        res.resume();
        res.on("error", () => resolve("cut"));
        res.on("close", () => resolve(res.complete ? "complete" : "cut"));
      });
      req.on("error", () => resolve("cut"));
      req.end();
    });
    expect(outcome).toBe("cut");
  });

  it("logs the session, never the token or the handle", async () => {
    const up = await upstream();
    const lines: string[] = [];
    const proxy = await proxyFor(up.url, (level, message, data) => lines.push(JSON.stringify({ level, message, data })));
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const handle = new URL(base).pathname.split("/")[1]!;
    await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/main`) });
    proxy.setToken(INSTALLATION, null);
    await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    await send(`${new URL(base).origin}/${"e".repeat(64)}/octo/repo.git/info/refs`);
    const text = lines.join("\n");
    expect(text).toContain("session-1");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(text).not.toContain(handle);
    expect(text).not.toContain("e".repeat(64));
  });

  it("destroys a connection that another local user opened, before reading a request", async () => {
    const up = await upstream();
    const lines: string[] = [];
    let uid: number | null = 4242;
    const lookups: Array<[number, number]> = [];
    const proxy = createGitCredentialProxy({
      upstream: up.url,
      env: {},
      log: (level, message, data) => lines.push(JSON.stringify({ level, message, data })),
      peerUid: (clientPort, proxyPort) => { lookups.push([clientPort, proxyPort]); return uid; },
    });
    await proxy.start();
    cleanup.push(() => proxy.close());
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/info/refs?service=git-upload-pack`;
    // Another user knows the handle (it is in git's process arguments) and uses it.
    await expect(send(url)).rejects.toThrow();
    await expect(send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/${WORK_BRANCH}`) })).rejects.toThrow();
    // A connection whose owner cannot be determined is refused too.
    uid = null;
    await expect(send(url)).rejects.toThrow();
    expect(up.seen).toEqual([]);
    expect(lookups.every(([clientPort, proxyPort]) => clientPort > 0 && proxyPort === Number(new URL(base).port))).toBe(true);
    // The same user is served.
    uid = process.getuid!();
    expect((await send(url)).status).toBe(200);
    expect(up.seen).toHaveLength(1);
    const text = lines.join("\n");
    expect(text).toContain("another user");
    expect(text).not.toContain(new URL(base).pathname.split("/")[1]!);
    expect(text).not.toContain(TOKEN);
  });

  it("reports whether it can tell which user opened a connection", () => {
    expect(createGitCredentialProxy({ peerUid: () => 1 }).verifiesPeerUser).toBe(typeof process.getuid === "function");
    // No lookup on this platform: the host must not offer git workspaces.
    expect(createGitCredentialProxy({ peerUid: null }).verifiesPeerUser).toBe(false);
    expect(createGitCredentialProxy().verifiesPeerUser).toBe(process.platform === "linux");
  });

  it.runIf(process.platform === "linux")("recognizes its own connections through the kernel's socket table", async () => {
    // No injected lookup: the real `/proc/net/tcp` must name this process's uid.
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(200);
    }
  });

  it("a new token replaces the installation's handles and the same token keeps them", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const first = proxy.register(scope);
    const otherScope = { ...scope, installationId: "11111111-1111-4111-8111-111111111111" };
    proxy.setToken(otherScope.installationId, "other-fixture");
    const other = proxy.register(otherScope);
    const path = "octo/repo.git/info/refs?service=git-upload-pack";
    expect((await send(`${first}${path}`)).status).toBe(200);

    // The same token again changes nothing: an address git or a tool already
    // holds keeps working.
    proxy.setToken(INSTALLATION, TOKEN);
    expect(proxy.register(scope)).toBe(first);
    expect((await send(`${first}${path}`)).status).toBe(200);

    // A different token rotates every handle of the installation.
    proxy.setToken(INSTALLATION, "rotated-fixture-token");
    expect((await send(`${first}${path}`)).status).toBe(404);
    const second = proxy.register(scope);
    expect(second).not.toBe(first);
    expect(proxy.register(scope)).toBe(second);
    expect((await send(`${second}${path}`)).status).toBe(200);
    // Another installation's handles are untouched.
    expect(proxy.register(otherScope)).toBe(other);
    expect((await send(`${other}${path}`)).status).toBe(200);
    // Dropping the token does not rotate: the handle answers 401.
    proxy.setToken(INSTALLATION, null);
    expect(proxy.register(scope)).toBe(second);
    expect((await send(`${second}${path}`)).status).toBe(401);
    // A token set after a drop is a new credential set, even if it is the
    // value from before: the dropped one is not remembered.
    proxy.setToken(INSTALLATION, "rotated-fixture-token");
    expect((await send(`${second}${path}`)).status).toBe(404);
    expect(proxy.register(scope)).not.toBe(second);
    expect(up.seen).toHaveLength(4);
  });

  it("stops answering after close", async () => {
    const up = await upstream();
    const proxy = createGitCredentialProxy({ upstream: up.url, env: {} });
    await proxy.start();
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(200);
    await proxy.close();
    await expect(send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).rejects.toThrow();
    await proxy.close();
  });
});
