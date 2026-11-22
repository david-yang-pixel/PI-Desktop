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

const lookupFixture = String.raw`
${setup}
globalThis.rendererProbe = async () => {
  useSessionTargetStore.getState().beginDraft({ environmentId: "default:build", defaultEnvironmentId: "default:build" });
  const listed = Array.from({ length: 3 }, (_, index) => ({ owner: "octo", name: "app-" + index, fullName: "octo/app-" + index,
    private: false, defaultBranch: "main", archived: false }));
  const calls = await start({
    [IPC.invoke.environmentsList]: () => ok({ environments: [environmentRow("default:build", "Build host", "build")] }),
    [IPC.invoke.remoteHostList]: () => ok({ hosts: [{ hostKey: "build", label: "Build host", connected: true }] }),
    [IPC.invoke.githubConnectorStatus]: () => ok({ connected: true, deviceLoginAvailable: false }),
    [IPC.invoke.githubRepositories]: () => ok({ repositories: listed, truncated: true }),
    [IPC.invoke.githubRepository]: ({ owner, name }) => ok({ repository: name === "hidden"
      ? { owner, name, fullName: owner + "/" + name, private: true, defaultBranch: "trunk", archived: false } : null }),
    [IPC.invoke.githubBranches]: () => ok({ branches: [{ name: "trunk", protected: true }], defaultBranch: "trunk", truncated: true }),
    [IPC.invoke.githubBranch]: ({ branch }) => ok({ branch: branch === "release/2026.11" ? { name: branch, protected: false } : null }),
  });
  const searchBox = (label) => document.querySelector('.session-target-menu.is-open input[aria-label="' + label + '"]');

  await until(() => trigger(copy.chooseRepository), "the repository picker did not appear");
  trigger(copy.chooseRepository).click();
  await until(() => menuButton("octo/app-0"), "the repository list did not load");
  if (!document.querySelector(".session-target-menu.is-open").textContent.includes(copy.lookup.repositoryHint)) {
    throw new Error("a truncated list does not say how to find more");
  }
  fill(searchBox(copy.searchRepositories), "big-org/missing");
  await until(() => document.body.textContent.includes(copy.lookup.repositoryNotFound.replace("{{name}}", "big-org/missing")),
    "a missing repository was not reported");
  fill(searchBox(copy.searchRepositories), "big-org/hidden");
  await until(() => menuButton("big-org/hidden"), "the unlisted repository was not offered");
  if (calls.filter(({ channel }) => channel === IPC.invoke.githubRepository).some(({ input }) => input.name.length < 6)) {
    throw new Error("a lookup was sent for a half-typed name");
  }
  menuButton("big-org/hidden").click();
  await until(() => trigger(copy.chooseRepository)?.textContent.trim() === "big-org/hidden", "the unlisted repository was not selected");
  const selected = useSessionTargetStore.getState();
  if (selected.repository?.defaultBranch !== "trunk" || selected.baseBranch !== "trunk") throw new Error("the lookup lost the default branch");

  // Typing a listed name looks nothing up.
  trigger(copy.chooseRepository).click();
  await until(() => searchBox(copy.searchRepositories), "the repository menu did not reopen");
  const lookups = calls.filter(({ channel }) => channel === IPC.invoke.githubRepository).length;
  fill(searchBox(copy.searchRepositories), "octo/app-1");
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (calls.filter(({ channel }) => channel === IPC.invoke.githubRepository).length !== lookups) {
    throw new Error("a listed repository was looked up");
  }
  trigger(copy.chooseRepository).click();

  trigger(copy.chooseBranch).click();
  await until(() => menuButton("trunk"), "the branch list did not load");
  if (!document.querySelector(".session-target-menu.is-open").textContent.includes(copy.lookup.branchesTruncated)) {
    throw new Error("a truncated branch list does not say so");
  }
  fill(searchBox(copy.searchBranches), "release/2026.11");
  await until(() => menuButton("release/2026.11"), "the unlisted branch was not offered");
  const branchLookup = calls.find(({ channel }) => channel === IPC.invoke.githubBranch);
  if (JSON.stringify(branchLookup.input) !== JSON.stringify({ owner: "big-org", name: "hidden", branch: "release/2026.11" })) {
    throw new Error("wrong branch lookup " + JSON.stringify(branchLookup.input));
  }
  menuButton("release/2026.11").click();
  await until(() => trigger(copy.chooseBranch)?.textContent.trim() === "release/2026.11", "the unlisted branch was not selected");
  return true;
};
`;

test("a repository or branch beyond the capped lists is found by its exact name", {
  timeout: 90_000, skip: electronProbeSkip,
}, async () => {
  const result = await runRendererProbe(lookupFixture);
  assert.ok(result.passed, result.output);
});
