import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The primary New task keeps the remembered environment, repository, and
// branch; a project's add button still opens its own defaults.

let server;
let useSessionTargetStore;

const previousWindow = globalThis.window;
const stored = new Map();

before(async () => {
  // The store persists its target; give it the browser storage it expects.
  globalThis.window = { localStorage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  } };
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ useSessionTargetStore } = await server.ssrLoadModule("/src/features/chat/session-target/session-target-store.ts"));
});

after(async () => {
  await server?.close();
  globalThis.window = previousWindow;
});

beforeEach(() => {
  useSessionTargetStore.getState().beginDraft({ environmentId: "local" });
});

const repository = { owner: "octo", name: "app", defaultBranch: "main" };
const target = () => {
  const { environmentId, repository, baseBranch, remoteProject, folderProject, hostModel } = useSessionTargetStore.getState();
  return { environmentId, repository, baseBranch, remoteProject, folderProject, hostModel };
};

test("New task keeps the last environment, repository, and branch the user picked", () => {
  const store = useSessionTargetStore.getState();
  store.setEnvironment("env-gpu", "gpu-host");
  store.setRepository(repository);
  store.setBaseBranch("develop");

  useSessionTargetStore.getState().beginDraft();

  assert.deepEqual(target(), {
    environmentId: "env-gpu", repository, baseBranch: "develop",
    remoteProject: undefined, folderProject: undefined, hostModel: undefined,
  });
});

test("New task drops what belonged only to the previous draft", () => {
  useSessionTargetStore.getState().beginDraft({
    environmentId: "default:gpu-host",
    folderProject: { path: "remote-project:gpu/folder", hostKey: "gpu-host" },
    remoteProject: { hostKey: "gpu-host", projectId: "p1", key: "remote::gpu-host::p1", name: "Folder" },
  });
  useSessionTargetStore.getState().setHostModel("default:gpu-host", "gpu-host", { providerId: "host", modelId: "m" });

  useSessionTargetStore.getState().beginDraft();

  assert.deepEqual(target(), {
    environmentId: "default:gpu-host", repository: undefined, baseBranch: undefined,
    remoteProject: undefined, folderProject: undefined, hostModel: undefined,
  });
});

test("a project's draft uses its own target", () => {
  useSessionTargetStore.getState().setEnvironment("env-gpu", "gpu-host");
  useSessionTargetStore.getState().setRepository(repository);

  useSessionTargetStore.getState().beginDraft({ environmentId: "local" });

  assert.equal(target().environmentId, "local");
  assert.equal(target().repository, undefined);
});

test("the remembered target survives a restart and local project drafts choose this computer", () => {
  useSessionTargetStore.getState().setEnvironment("env-gpu", "gpu-host");
  useSessionTargetStore.getState().setRepository(repository);
  assert.deepEqual(JSON.parse(stored.get("pi-desktop.sessionTarget.v1")).state, {
    environmentId: "env-gpu", repository, baseBranch: "main",
  });

  const slice = readFileSync(new URL("../src/stores/slices/session-slice.ts", import.meta.url), "utf8");
  const draft = slice.slice(slice.indexOf("openTaskDraft: async"), slice.indexOf("newSession: async"));
  assert.match(draft, /if \(projectPath && !target\) \{[\s\S]*?target = \{ environmentId: "local" \};[\s\S]*?\} else \{/);
});
