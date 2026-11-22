import assert from "node:assert/strict";
import test from "node:test";
import { electronProbeSkip, probeDomHelpers, runRendererProbe } from "./helpers/electron-renderer-probe.mjs";

// The composer's target row, driven through its pickers with only main's side
// of the IPC bridge replaced.

const setup = String.raw`
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SessionTargetRow } from "./src/features/chat/session-target/SessionTargetRow";
import { useSessionTargetStore } from "./src/features/chat/session-target/session-target-store";
${probeDomHelpers}
const copy = catalogs.en.sessionTarget;
const environmentRow = (id, name, hostKey) => ({ id, name, hostKey, setupScript: "", variables: [],
  idleReclaimHours: 72, regenerableDirs: [], isDefault: id.startsWith("default:") });
async function start(handlers) {
  await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
  const calls = [];
  window.piDesktop = {
    on() { return () => {}; },
    async invoke(channel, input) {
      calls.push({ channel, input });
      const handler = handlers[channel];
      if (!handler) throw new Error("Unexpected channel " + channel);
      return handler(input);
    },
  };
  createRoot(document.querySelector("#root")).render(<SessionTargetRow />);
  return calls;
}
const ok = (data) => ({ ok: true, data });
const trigger = (label) => [...document.querySelectorAll(".session-target-trigger")].find((element) => element.getAttribute("aria-label") === label);
const menuButton = (text) => [...document.querySelectorAll(".session-target-menu.is-open button")].find((element) => element.textContent.trim() === text);
`;

const offlineFixture = String.raw`
${setup}
globalThis.rendererProbe = async () => {
  useSessionTargetStore.getState().beginDraft({ environmentId: "env-gpu", defaultEnvironmentId: "default:gpu" });
  await start({
    [IPC.invoke.environmentsList]: () => ok({ environments: [
      environmentRow("default:build", "Build host", "build"), environmentRow("env-gpu", "GPU box", "gpu"),
    ] }),
    [IPC.invoke.remoteHostList]: () => ok({ hosts: [
      { hostKey: "build", label: "Build host", connected: true }, { hostKey: "gpu", label: "GPU server", connected: false },
    ] }),
    [IPC.invoke.githubConnectorStatus]: () => ok({ connected: false, deviceLoginAvailable: false }),
  });
  const hint = copy.offlineHost.sendHint.replace("{{host}}", "GPU server");
  await until(() => document.body.textContent.includes(hint), "the offline Host was not explained near Send");
  if (document.querySelector('.session-target-note[role="status"]')?.textContent.trim() !== hint) {
    throw new Error("the hint is not a status note");
  }

  trigger(copy.environmentHost).click();
  await until(() => document.querySelector(".session-target-menu.is-open"), "the environment menu did not open");
  const gpu = document.querySelector('.session-target-menu.is-open [data-host-offline="true"]');
  if (!gpu || !gpu.textContent.includes("GPU box") || !gpu.textContent.includes(copy.offline) || gpu.disabled) {
    throw new Error("the offline environment is not marked, or cannot be chosen");
  }
  const build = menuButton("Build host");
  if (!build || build.hasAttribute("data-host-offline")) throw new Error("a connected environment is marked offline");

  build.click();
  await until(() => !document.body.textContent.includes(hint), "the hint stayed after choosing a connected Host");
  return true;
};
`;

test("an offline Host is marked in the environment picker and explained near Send", {
  timeout: 90_000, skip: electronProbeSkip,
}, async () => {
  const result = await runRendererProbe(offlineFixture);
  assert.ok(result.passed, result.output);
});
