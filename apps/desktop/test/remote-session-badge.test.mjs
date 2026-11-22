import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

// A repository session that is still preparing, or whose preparation failed,
// is marked in the sidebar so the user can find it without opening it.

let server;
let RemoteSessionBadge;
let remoteSessionBadgeStatus;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ RemoteSessionBadge, remoteSessionBadgeStatus } = await server.ssrLoadModule(
    "/src/features/chat/session-target/RemoteSessionBadge.tsx",
  ));
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
});

after(async () => {
  await server?.close();
});

const workspace = (state, extra = {}) => ({
  environmentId: "env-1", hostKey: "h1", repository: { owner: "octo", name: "repo" }, baseBranch: "main", state, ...extra,
});
const render = (session) => renderToStaticMarkup(
  createElement(I18nextProvider, { i18n }, createElement(RemoteSessionBadge, { session })),
);

test("only a preparing or failed workspace is marked", () => {
  assert.equal(remoteSessionBadgeStatus(undefined), null);
  for (const state of ["ready", "reclaiming", "reclaimed", "removing"]) {
    assert.equal(remoteSessionBadgeStatus(workspace(state)), null, state);
    assert.equal(render({ id: "s", remoteRepository: workspace(state) }), "", state);
  }
  assert.equal(remoteSessionBadgeStatus(workspace("preparing")), "preparing");
  assert.equal(remoteSessionBadgeStatus(workspace("failed")), "failed");
});

test("a preparing row shows a spinner and the preparing label", () => {
  const html = render({ id: "s", remoteRepository: workspace("preparing", { phase: "cloning" }) });
  assert.match(html, /data-remote-session-status="preparing"/);
  assert.match(html, /remote-session-badge-spinner/);
  assert.ok(html.includes(`>${catalogs.en.sessionTarget.sessionBadge.preparing}</span>`), html);
});

test("a failed row names the localized reason in its tooltip", () => {
  const html = render({ id: "s", remoteRepository: workspace("failed", {
    error: { code: "REMOTE_TARGET_HOST_OFFLINE", message: "The remote host could not be reached" },
  }) });
  assert.match(html, /data-remote-session-status="failed"/);
  assert.match(html, /badge-error/);
  assert.ok(html.includes(`>${catalogs.en.sessionTarget.sessionBadge.failed}</span>`), html);
  const reason = catalogs.en.sessionTarget.errors.hostOffline;
  assert.ok(html.includes(`title="Could not prepare the workspace: ${reason}"`), html);
  assert.doesNotMatch(html, /could not be reached/);
});

test("the sidebar mounts the mark in every session row", () => {
  const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  const row = sidebar.slice(sidebar.indexOf("const renderSessionRows"), sidebar.indexOf("const renderProjectGroup"));
  assert.match(row, /<RemoteSessionBadge session=\{session\} \/>/);
});
