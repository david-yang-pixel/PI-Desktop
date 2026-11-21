import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

const workspace = {
  environmentId: "environment", hostKey: "host", repository: { owner: "octo", name: "repo" },
  baseBranch: "main", workBranch: "pi-desktop/abc",
};
const i18n = createInstance();
let server;
let EnvironmentEditor;
let RemoteSessionActions;
let WorkspacePreparationStatus;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const feature = "/src/features/chat/session-target";
  ({ EnvironmentEditor } = await server.ssrLoadModule(`${feature}/EnvironmentEditor.tsx`));
  ({ RemoteSessionActions } = await server.ssrLoadModule(`${feature}/RemoteSessionActions.tsx`));
  ({ WorkspacePreparationStatus } = await server.ssrLoadModule(`${feature}/WorkspacePreparationStatus.tsx`));
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });
});
after(async () => { await server?.close(); });

function render(Component, props) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Component, props)));
}

test("the environment editor defaults to 72 hours and preserves a saved off setting", () => {
  const editor = (environment) => render(EnvironmentEditor, {
    hosts: [{ hostKey: "host", label: "Build host" }], environment, onSaved() {}, onClose() {},
  });
  const legacy = { id: "environment", name: "Build host", hostKey: "host" };
  for (const html of [editor(), editor(legacy)]) {
    assert.match(html, /<input[^>]*type="number"[^>]*min="0"[^>]*max="8760"[^>]*step="1"[^>]*value="72"/);
    assert.match(html, /Ignored files outside these directories prevent reclamation/);
  }
  const configured = editor({ ...legacy, idleReclaimHours: 0, regenerableDirs: ["node_modules", "client/dist"] });
  assert.match(configured, /<input[^>]*type="number"[^>]*value="0"/);
  assert.match(configured, /<textarea[^>]*>node_modules\nclient\/dist<\/textarea>/);
});

test("reclaimed and reclaiming workspaces show status and a rebuild failure exposes its log", () => {
  const status = (props) => render(WorkspacePreparationStatus, { sessionId: "session", workspace: { ...workspace, ...props } });
  const reclaimed = status({ state: "reclaimed" });
  assert.match(reclaimed, /role="status".*Workspace reclaimed.*Send a message to restore…/);
  assert.doesNotMatch(reclaimed, /<button/);
  assert.match(status({ state: "reclaiming" }), /role="status".*Reclaiming workspace…/);

  const failed = status({ state: "failed", error: { message: "Setup failed" }, setup: { status: "failed", logTail: "install <failed>" } });
  assert.match(failed, /role="alert".*Could not prepare the workspace: Setup failed/);
  assert.match(failed, /<button[^>]*>Retry<\/button>/);
  assert.match(failed, /<details><summary>Show log<\/summary><pre[^>]*>install &lt;failed&gt;<\/pre><\/details>/);
  assert.doesNotMatch(status({ state: "failed", error: { message: "Checkout failed" } }), /Show log/);
});

test("reclaimed workspace actions show a recorded PR without publish controls", () => {
  const pullRequest = { number: 7, url: "https://github.com/octo/repo/pull/7" };
  const actions = (props) => render(RemoteSessionActions, { sessionId: "session", sessionTitle: "Ship", workspace: { ...workspace, ...props } });
  const reclaimed = actions({ state: "reclaimed", pullRequest });
  assert.match(reclaimed, /<button[^>]*>View PR #7<\/button>/);
  assert.doesNotMatch(reclaimed, /Push branch|Create pull request/);
  assert.doesNotMatch(actions({ state: "reclaimed" }), /<button/);
});
