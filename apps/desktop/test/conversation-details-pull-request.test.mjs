import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

/*
 * A repository session's details name the recorded pull request with its
 * state, so a merged request reads as merged instead of disappearing.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function withPullRequestLink(run) {
  const server = await createServer({
    root: ROOT, configFile: false, appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { PullRequestLink } = await server.ssrLoadModule("/src/components/ConversationDetails.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });
    const render = (pullRequest) => renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(PullRequestLink, { pullRequest })));
    await run(render);
  } finally {
    await server.close();
  }
}

test("the pull request link names its state next to the number", async () => {
  await withPullRequestLink((render) => {
    const url = "https://github.com/octo/repo/pull/12";
    const text = (pullRequest) => render(pullRequest).replace(/<[^>]+>/g, "");
    assert.equal(text({ number: 12, url, state: "merged", draft: false }), "View PR #12 · Merged");
    assert.equal(text({ number: 12, url, state: "closed", draft: false }), "View PR #12 · Closed");
    assert.equal(text({ number: 12, url, state: "open", draft: false }), "View PR #12 · Open");
    assert.equal(text({ number: 12, url, state: "open", draft: true }), "View PR #12 · Draft");
    // A link recorded before states were stored has no state to show yet.
    assert.equal(text({ number: 12, url }), "View PR #12");
    assert.match(render({ number: 12, url, state: "merged" }), /href="https:\/\/github\.com\/octo\/repo\/pull\/12"/);
  });
});
