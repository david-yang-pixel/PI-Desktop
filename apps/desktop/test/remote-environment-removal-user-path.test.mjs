import assert from "node:assert/strict";
import test from "node:test";
import { electronProbeSkip, probeDomHelpers, runRendererProbe } from "./helpers/electron-renderer-probe.mjs";

// Removing an environment from Remote Hosts settings asks first, and a
// refusal is explained in the user's language instead of as "Error: …".

const fixture = String.raw`
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { RemoteEnvironmentSettings } from "./src/features/chat/session-target/RemoteEnvironmentSettings";
import { useAppStore } from "./src/stores/app-store";
${probeDomHelpers}

globalThis.rendererProbe = async () => {
  await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
  const removed = [];
  let refuse = false;
  window.piDesktop = {
    on() { return () => {}; },
    async invoke(channel, input) {
      switch (channel) {
        case IPC.invoke.environmentsList: return { ok: true, data: { environments: [
          { id: "default:host", name: "Build host", hostKey: "host", setupScript: "", variables: [], idleReclaimHours: 72, regenerableDirs: [], isDefault: true },
          { id: "env-gpu", name: "GPU box", hostKey: "host", setupScript: "", variables: [], idleReclaimHours: 72, regenerableDirs: [], isDefault: false },
        ] } };
        case IPC.invoke.remoteHostList: return { ok: true, data: { hosts: [{ hostKey: "host", label: "Build host", connected: false }] } };
        case IPC.invoke.environmentsRemove:
          removed.push(input);
          return refuse
            ? { ok: false, error: { code: "REMOTE_ENVIRONMENT_NOT_FOUND", message: "environment not found" } }
            : { ok: true, data: { ok: true } };
        default: throw new Error("Unexpected channel " + channel);
      }
    },
  };
  const copy = catalogs.en.sessionTarget;
  createRoot(document.querySelector("#root")).render(<RemoteEnvironmentSettings />);
  await until(() => document.body.textContent.includes("GPU box"), "environments did not load");
  const dialog = () => document.querySelector('[role="dialog"]');

  button(copy.remove).click();
  await until(() => dialog(), "Remove did not ask for confirmation");
  if (removed.length) throw new Error("removed before confirmation");
  if (!dialog().textContent.includes("GPU box") || !dialog().textContent.includes(copy.environmentRemoval.detail)) {
    throw new Error("confirmation does not name the environment and its effect");
  }
  button(catalogs.en.common.cancel, dialog()).click();
  await until(() => !dialog(), "Cancel did not close the confirmation");
  if (removed.length) throw new Error("Cancel removed the environment");

  refuse = true;
  button(copy.remove).click();
  await until(() => dialog(), "Remove did not ask again");
  button(copy.remove, dialog()).click();
  const expected = copy.environmentRemoval.failed.replace("{{message}}", copy.environmentUnavailable);
  await until(() => useAppStore.getState().toasts.some((toast) => toast.message === expected && toast.variant === "error"),
    "a refused removal was not explained: " + JSON.stringify(useAppStore.getState().toasts));
  if (useAppStore.getState().toasts.some((toast) => toast.message.includes("environment not found"))) {
    throw new Error("the raw main-process message reached the user");
  }

  refuse = false;
  button(copy.remove, dialog()).click();
  await until(() => !dialog(), "a confirmed removal did not close the dialog");
  if (JSON.stringify(removed) !== JSON.stringify(["env-gpu", "env-gpu"])) throw new Error("wrong removals " + JSON.stringify(removed));
  return true;
};
`;

test("removing an environment asks first and explains a refusal in the user's language", {
  timeout: 90_000, skip: electronProbeSkip,
}, async () => {
  const result = await runRendererProbe(fixture);
  assert.ok(result.passed, result.output);
});
