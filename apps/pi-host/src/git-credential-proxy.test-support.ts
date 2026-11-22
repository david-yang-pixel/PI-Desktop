/**
 * Shared fixtures of the credential proxy test files: constants, a local
 * server standing in for GitHub, a request helper, and receive-pack bodies.
 * Each test file registers `cleanup` with its own `afterEach`.
 */
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createGitCredentialProxy, type GitCredentialProxy, type GitCredentialProxyOptions, type GitProxyScope } from "./git-credential-proxy.js";

export const TOKEN = "fixture-token-not-a-real-credential";
export const INSTALLATION = "00000000-0000-4000-8000-000000000000";
export const WORK_BRANCH = "pi-desktop/8b54618f6bc1";
export const scope: GitProxyScope = { installationId: INSTALLATION, sessionId: "session-1", repository: { owner: "octo", name: "repo" }, workBranch: WORK_BRANCH };
export const ZERO = "0".repeat(40);
export const A = "a".repeat(40);
export const B = "b".repeat(40);

export type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };
export type Reply = { status: number; headers: Record<string, string>; body: Buffer };
export type Sent = { method?: string; headers?: Record<string, string>; body?: Buffer | Buffer[] };

/** Closed in reverse order by each test file's `afterEach`. */
export const cleanup: Array<() => Promise<void>> = [];
export async function runCleanup(): Promise<void> {
  for (const close of cleanup.splice(0).reverse()) await close();
}

/** A local server standing in for GitHub; it records everything it receives. */
export async function upstream(respond: (seen: Seen) => { status?: number; headers?: Record<string, string>; body?: string } = () => ({})) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      const reply = respond(entry);
      res.writeHead(reply.status ?? 200, { "content-type": "application/x-git-result", ...reply.headers });
      res.end(reply.body ?? "upstream-ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function proxyFor(
  upstreamUrl: string,
  logOrOptions?: GitCredentialProxyOptions["log"] | Omit<GitCredentialProxyOptions, "upstream">,
): Promise<GitCredentialProxy> {
  const extra = typeof logOrOptions === "function" ? { log: logOrOptions } : (logOrOptions ?? {});
  const proxy = createGitCredentialProxy({ upstream: upstreamUrl, env: {}, ...extra });
  await proxy.start();
  cleanup.push(() => proxy.close());
  return proxy;
}

export function send(url: string, sent: Sent = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: sent.method ?? "GET", headers: sent.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    const body = sent.body;
    if (Array.isArray(body)) {
      // Chunked, in several writes, the way git streams a large pack.
      void (async () => {
        for (const chunk of body) { req.write(chunk); await new Promise((resolve) => setTimeout(resolve, 5)); }
        req.end();
      })();
    } else req.end(body);
  });
}

export function pkt(line: string): Buffer {
  const body = Buffer.from(line, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
}
export const FLUSH = Buffer.from("0000", "ascii");
export const PACK = Buffer.concat([Buffer.from("PACK", "ascii"), Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))]);
export const push = (...commands: string[]) => Buffer.concat([...commands.map((command, index) => pkt(index === 0 ? `${command}\u0000report-status side-band-64k\n` : `${command}\n`)), FLUSH, PACK]);
export const RECEIVE_HEADERS = { "content-type": "application/x-git-receive-pack-request" };
export const basic = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
