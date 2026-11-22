import { readFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as tcpConnect, type AddressInfo, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";

import {
  A, B, basic, cleanup, INSTALLATION, proxyFor, push, RECEIVE_HEADERS, runCleanup, scope, send, TOKEN, upstream, WORK_BRANCH, type Seen,
} from "./git-credential-proxy.test-support.js";

/** Upstream HTTP and HTTPS proxies between the credential proxy and GitHub. */
afterEach(runCleanup);

const TEST_CERT_DIR = new URL("../../../scripts/e2e/fixtures/certificates/", import.meta.url);
const LOCALHOST_CERT = readFileSync(new URL("localhost-cert.pem", TEST_CERT_DIR));
const LOCALHOST_KEY = readFileSync(new URL("localhost-key.pem", TEST_CERT_DIR));

type SeenHttps = Seen & { servername: string | undefined };
type SeenConnect = { authority: string; headers: IncomingHttpHeaders };
type SeenProxyHttp = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };

async function httpsUpstream(respond: (seen: SeenHttps) => { status?: number; headers?: Record<string, string>; body?: string } = () => ({})) {
  const seen: SeenHttps[] = [];
  const server = createHttpsServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const tlsSocket = req.socket as TLSSocket;
      const entry: SeenHttps = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
        servername: tlsSocket.servername || undefined,
      };
      seen.push(entry);
      const reply = respond(entry);
      res.writeHead(reply.status ?? 200, { "content-type": "application/x-git-result", ...reply.headers });
      res.end(reply.body ?? "https-upstream-ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, url: `https://localhost:${port}` };
}

/** Local HTTP proxy supporting both `CONNECT` tunneling (for HTTPS) and absolute-form HTTP forwarding. */
async function httpProxyServer(options: {
  connectStatus?: number;
  stallConnect?: (socket: Socket) => void;
  requireProxyAuth?: string;
} = {}) {
  const connects: SeenConnect[] = [];
  const forwarded: SeenProxyHttp[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      forwarded.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (options.requireProxyAuth && req.headers["proxy-authorization"] !== options.requireProxyAuth) {
        res.writeHead(407, { "proxy-authenticate": "Basic realm=\"test\"" });
        res.end("proxy auth required");
        return;
      }
      const target = new URL(req.url ?? "");
      const forwardHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && k.toLowerCase() !== "proxy-authorization") forwardHeaders[k] = v;
      }
      const upstreamReq = request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: forwardHeaders,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstreamReq.on("error", () => {
        res.writeHead(502);
        res.end("bad gateway");
      });
      upstreamReq.end(body);
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    connects.push({ authority: req.url ?? "", headers: req.headers });

    if (options.stallConnect) {
      options.stallConnect(clientSocket);
      return;
    }
    if (options.requireProxyAuth && req.headers["proxy-authorization"] !== options.requireProxyAuth) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\n\r\n");
      return;
    }
    if (options.connectStatus && options.connectStatus !== 200) {
      clientSocket.end(`HTTP/1.1 ${options.connectStatus} Proxy Error\r\n\r\n`);
      return;
    }
    const authority = req.url ?? "";
    const colon = authority.lastIndexOf(":");
    const port = Number(authority.slice(colon + 1));
    const targetSocket = tcpConnect(port, "127.0.0.1", () => {
      sockets.add(targetSocket);
      targetSocket.on("close", () => sockets.delete(targetSocket));
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => targetSocket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  return { connects, forwarded, port, url: `http://127.0.0.1:${port}` };
}

describe("git credential proxy upstream HTTP/HTTPS proxy support", () => {
  it("tunnels authenticated HTTPS git traffic via HTTP CONNECT without leaking GitHub Authorization on CONNECT", async () => {
    const up = await httpsUpstream(() => ({ body: "001e# service=git-upload-pack\n" }));
    const proxyUser = "corp-user";
    const proxyPass = "p@ss:w/rd#1";
    const expectedProxyAuth = `Basic ${Buffer.from(`${proxyUser}:${proxyPass}`, "utf8").toString("base64")}`;
    const corpProxy = await httpProxyServer({ requireProxyAuth: expectedProxyAuth });

    const proxyUrl = `http://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@127.0.0.1:${corpProxy.port}`;
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: proxyUrl },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    // 1. Authenticated GET info/refs through CONNECT tunnel.
    const advertised = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(advertised.status).toBe(200);
    expect(advertised.body.toString("utf8")).toBe("001e# service=git-upload-pack\n");

    // 2. Authenticated streaming POST git-receive-pack through CONNECT tunnel.
    const body = push(`${A} ${B} refs/heads/${WORK_BRANCH}`);
    const pushed = await send(`${base}octo/repo.git/git-receive-pack`, {
      method: "POST",
      headers: RECEIVE_HEADERS,
      body: [body.subarray(0, 20), body.subarray(20, 200), body.subarray(200)],
    });
    expect(pushed.status).toBe(200);

    expect(corpProxy.connects).toHaveLength(2);
    for (const connect of corpProxy.connects) {
      expect(connect.authority).toBe(`localhost:${up.port}`);
      expect(connect.headers.host).toBe(`localhost:${up.port}`);
      expect(connect.headers["proxy-authorization"]).toBe(expectedProxyAuth);
      // CRITICAL: GitHub Authorization must NEVER appear on the plaintext CONNECT request.
      expect(connect.headers.authorization).toBeUndefined();
      expect(JSON.stringify(connect.headers)).not.toContain(TOKEN);
      expect(JSON.stringify(connect.headers)).not.toContain(basic);
    }

    expect(up.seen).toHaveLength(2);
    expect(up.seen[0]!.url).toBe("/octo/repo.git/info/refs?service=git-upload-pack");
    expect(up.seen[0]!.headers.authorization).toBe(basic);
    expect(up.seen[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(up.seen[0]!.servername).toBe("localhost");

    expect(up.seen[1]!.url).toBe("/octo/repo.git/git-receive-pack");
    expect(up.seen[1]!.headers.authorization).toBe(basic);
    expect(up.seen[1]!.body.equals(body)).toBe(true);
    expect(up.seen[1]!.servername).toBe("localhost");
  });

  it("keeps TLS certificate verification enabled inside the CONNECT tunnel", async () => {
    const up = await httpsUpstream();
    const corpProxy = await httpProxyServer();
    // Intentionally omit `upstreamTls: { ca }` so the self-signed test cert is untrusted.
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: corpProxy.url },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(502);
    expect(corpProxy.connects).toHaveLength(1);
    // TLS verification failed before any HTTP request or GitHub credential was sent.
    expect(up.seen).toHaveLength(0);
  });

  it("bypasses the upstream proxy when NO_PROXY matches and connects directly", async () => {
    const up = await httpsUpstream();
    const corpProxy = await httpProxyServer();
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: corpProxy.url, NO_PROXY: "example.com, localhost" },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(200);
    expect(corpProxy.connects).toHaveLength(0);
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.headers.authorization).toBe(basic);
  });

  it("returns 502 on CONNECT 407, CONNECT 502, connection refused, or unsupported proxy without leaking credentials", async () => {
    const up = await httpsUpstream();
    const proxySecret = "super-secret-proxy-password";
    const proxyUser = "proxy-secret-user";

    // 1. Proxy rejects CONNECT with 407.
    const authProxy = await httpProxyServer({ requireProxyAuth: "Basic ZGlmZmVyZW50OmNyZWQ=" });
    const logs: string[] = [];
    const log = (level: "info" | "warn", message: string, data?: unknown) => logs.push(JSON.stringify({ level, message, data }));
    const p407 = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `http://${proxyUser}:${proxySecret}@127.0.0.1:${authProxy.port}` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    p407.setToken(INSTALLATION, TOKEN);
    const r407 = await send(`${p407.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(r407.status).toBe(502);
    expect(r407.body.toString("utf8")).not.toContain(proxySecret);
    expect(r407.body.toString("utf8")).not.toContain(TOKEN);

    // 2. Proxy fails CONNECT with 502.
    const failProxy = await httpProxyServer({ connectStatus: 502 });
    const p502 = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `http://${proxyUser}:${proxySecret}@127.0.0.1:${failProxy.port}` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    p502.setToken(INSTALLATION, TOKEN);
    const r502 = await send(`${p502.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(r502.status).toBe(502);

    // 3. Proxy connection refused.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const pRefused = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `http://${proxyUser}:${proxySecret}@127.0.0.1:${deadPort}` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    pRefused.setToken(INSTALLATION, TOKEN);
    const rRefused = await send(`${pRefused.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(rRefused.status).toBe(502);

    // 4. Unsupported proxy scheme (socks5).
    const pSocks = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `socks5://${proxyUser}:${proxySecret}@127.0.0.1:1080` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    pSocks.setToken(INSTALLATION, TOKEN);
    const rSocks = await send(`${pSocks.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(rSocks.status).toBe(502);

    expect(up.seen).toHaveLength(0);
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain(proxyUser);
    expect(allLogs).not.toContain(proxySecret);
    expect(allLogs).not.toContain(Buffer.from(`${proxyUser}:${proxySecret}`).toString("base64"));
    expect(allLogs).not.toContain(TOKEN);
    expect(allLogs).not.toContain(basic);
  });

  it("destroys an in-flight CONNECT tunnel when the client disconnects", async () => {
    const up = await httpsUpstream();
    let resolveConnectStarted!: () => void;
    let resolveConnectClosed!: () => void;
    const connectStarted = new Promise<void>((resolve) => { resolveConnectStarted = resolve; });
    const connectClosed = new Promise<void>((resolve) => { resolveConnectClosed = resolve; });

    const stalledProxy = await httpProxyServer({
      stallConnect(socket) {
        resolveConnectStarted();
        // Node HTTP server sockets are half-open by default; resume to observe client FIN.
        socket.resume();
        socket.once("end", () => { socket.destroy(); resolveConnectClosed(); });
        socket.once("close", () => resolveConnectClosed());
      },
    });
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: stalledProxy.url },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const clientReq = request(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    clientReq.on("error", () => undefined);
    clientReq.end();

    await connectStarted;
    clientReq.destroy();
    await connectClosed;
    expect(up.seen).toHaveLength(0);
  });

  it("forwards http upstream requests through an HTTP proxy using absolute-form URI and Proxy-Authorization", async () => {
    const up = await upstream(() => ({ body: "http-via-proxy-ok" }));
    const proxyAuth = `Basic ${Buffer.from("http-user:http-pass", "utf8").toString("base64")}`;
    const corpProxy = await httpProxyServer({ requireProxyAuth: proxyAuth });

    const proxy = await proxyFor(`${up.url}/prefix`, {
      env: { HTTP_PROXY: `http://http-user:http-pass@127.0.0.1:${corpProxy.port}` },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(200);
    expect(reply.body.toString("utf8")).toBe("http-via-proxy-ok");

    expect(corpProxy.connects).toHaveLength(0);
    expect(corpProxy.forwarded).toHaveLength(1);
    const seenAtProxy = corpProxy.forwarded[0]!;
    expect(seenAtProxy.url).toBe(`${up.url}/prefix/octo/repo.git/info/refs?service=git-upload-pack`);
    expect(seenAtProxy.headers.host).toBe(new URL(up.url).host);
    expect(seenAtProxy.headers["proxy-authorization"]).toBe(proxyAuth);

    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.url).toBe("/prefix/octo/repo.git/info/refs?service=git-upload-pack");
    expect(up.seen[0]!.headers.authorization).toBe(basic);
    expect(up.seen[0]!.headers.host).toBe(new URL(up.url).host);
  });
});
