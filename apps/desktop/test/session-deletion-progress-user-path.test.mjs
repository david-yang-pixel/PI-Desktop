import assert from "node:assert/strict";
import test from "node:test";
import { electronProbeSkip, probeDomHelpers, runRendererProbe } from "./helpers/electron-renderer-probe.mjs";

// Deleting a preparing repository session stops its Host job first, which can
// take tens of seconds. The sidebar row and the composer say "Deleting…" until
// it settles, and a second Delete meanwhile sends nothing.

const fixture = String.raw`
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { useAppStore } from "./src/stores/app-store";
import { RemoteSessionBadge } from "./src/features/chat/session-target/RemoteSessionBadge";
import { WorkspacePreparationStatus } from "./src/features/chat/session-target/WorkspacePreparationStatus";
${probeDomHelpers}

globalThis.rendererProbe = async () => {
  await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
  const copy = catalogs.en.sessionTarget;
  const deletes = [];
  let finishDelete;
  window.piDesktop = {
    on() { return () => {}; },
    async invoke(channel, input) {
      if (channel === IPC.invoke.remoteSessionDeletePreflight) return { ok: true, data: { kind: "none" } };
      if (channel === IPC.invoke.sessionDelete) {
        deletes.push(input);
        return new Promise((resolve) => { finishDelete = () => resolve({ ok: true, data: { ok: true } }); });
      }
      if (channel === IPC.invoke.sessionList) return { ok: true, data: { sessions: [], runningSessionIds: [] } };
      return { ok: true, data: {} };
    },
  };
  const workspace = { environmentId: "env", hostKey: "h", repository: { owner: "octo", name: "app" }, baseBranch: "main",
    state: "preparing", phase: "cloning" };
  useAppStore.setState({ sessions: [{ id: "s1", title: "Preparing task", remoteRepository: workspace,
    createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-20T00:00:00Z" }] });
  function Surface() {
    const sessions = useAppStore((state) => state.sessions);
    return <>
      {sessions.map((session) => <div key={session.id} data-row={session.id}><RemoteSessionBadge session={session} /></div>)}
      {sessions[0] && <WorkspacePreparationStatus sessionId={sessions[0].id} workspace={sessions[0].remoteRepository} />}
    </>;
  }
  const root = document.querySelector("#root");
  createRoot(root).render(<Surface />);
  await until(() => root.querySelector('[data-remote-session-status="preparing"]'), "the preparing row was not marked");

  const deletion = useAppStore.getState().deleteSession("s1");
  await until(() => root.querySelector('[data-remote-session-status="deleting"]')?.textContent === copy.deletion.deleting,
    "the row did not say Deleting…");
  const status = await until(() => [...root.querySelectorAll('[role="status"]')].find((element) =>
    element.textContent === copy.deletion.deletingSession), "the composer did not say the session is being deleted");
  if (status.getAttribute("aria-busy") !== "true" || button(copy.preparationControl.cancel)) {
    throw new Error("the composer still offers preparation controls while deleting");
  }
  await useAppStore.getState().deleteSession("s1");
  if (deletes.length !== 1) throw new Error("a second Delete sent another request: " + deletes.length);

  finishDelete();
  await deletion;
  await until(() => !root.querySelector("[data-row]"), "the deleted session stayed in the list");
  return true;
};
`;

test("a slow repository session deletion shows its progress until it settles", {
  timeout: 90_000, skip: electronProbeSkip,
}, async () => {
  const result = await runRendererProbe(fixture);
  assert.ok(result.passed, result.output);
});
