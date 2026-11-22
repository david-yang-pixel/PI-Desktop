import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";
import { fileURLToPath } from "node:url";
import i18n from "i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { submitWithLatestDraftRestore } from "../src/features/chat/composer/hooks/submit-with-latest-draft-restore.mjs";

// The composer's first send to a remote environment creates the session before
// the prompt goes out. When that step fails, the user must learn why, in their
// language, and keep the text they typed.

const en = catalogs.en;
const startFailed = (reason) => en.sessionTarget.startFailed.replace("{{message}}", reason);
const ENVIRONMENT = {
  id: "env:ssh-one",
  name: "Remote Linux",
  hostKey: "ssh-one",
  setupScript: "",
  variables: [],
  idleReclaimHours: 0,
  regenerableDirs: [],
  isDefault: false,
};
const REPOSITORY = { owner: "octo", name: "app", defaultBranch: "main" };

let server;
let createQueueSlice;
let createNavigationIntentController;
let useSessionTargetStore;
const previousWindow = globalThis.window;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts"));
  ({ createNavigationIntentController } = await server.ssrLoadModule("/src/lib/navigation-intent.ts"));
  ({ useSessionTargetStore } = await server.ssrLoadModule(
    "/src/features/chat/session-target/session-target-store.ts",
  ));
  await i18n.init({
    lng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(en) } },
    interpolation: { escapeValue: false },
  });
});

afterEach(() => {
  globalThis.window = previousWindow;
  useSessionTargetStore.getState().beginDraft({ environmentId: "local" });
});

after(async () => {
  await server?.close();
});

const failure = (code, message) => ({ ok: false, error: { code, message } });

/** Main's side of the IPC boundary: the only thing the test replaces. */
function stubMain(handlers) {
  const calls = [];
  globalThis.window = {
    piDesktop: {
      on: () => () => {},
      invoke: async (channel, payload) => {
        calls.push(channel);
        const handler = handlers[channel];
        if (!handler) throw new Error(`Unexpected IPC: ${channel}`);
        return handler(payload);
      },
    },
  };
  return calls;
}

/** The home composer with an unsent draft and the real queue slice behind it. */
function homeComposer({
  materializeDraftSession = async () => assert.fail("a remote target must not start a local draft session"),
} = {}) {
  const nav = createNavigationIntentController();
  const toasts = [];
  let state = {
    activeSessionId: undefined,
    sessions: [],
    messages: [],
    pendingPlans: {},
    runningSessions: {},
    latestTurnResults: {},
    sessionOutcomes: {},
    choosingLocalTaskProject: false,
    draftConfiguration: null,
    settings: undefined,
    showToast: (message, options) => toasts.push({ message, variant: options?.variant }),
    activateProject: async (path) => ({ path }),
    selectSession: async () => assert.fail("a failed start must not select a session"),
  };
  const slice = createQueueSlice({
    get: () => state,
    set: (update) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    },
    runtime: {
      beginNavigationIntent: nav.begin,
      navigationIntentIsCurrent: nav.isCurrent,
      submittedComposerDrafts: new Map(),
      sessionModeSelections: new Map(),
      sessionTranscriptCache: new Map(),
      insertOptimisticUserMessage() {},
      retractOptimisticUserMessage() {},
    },
    promptAttachmentsFromDraft: () => [],
    withoutRecordKey: (record, key) => {
      const next = { ...record };
      delete next[key];
      return next;
    },
    viewingSessionIdForPrompt: () => null,
    messageErrorFromUnknown: (error) => ({ code: error?.code ?? "INTERNAL", message: String(error) }),
    assistantErrorMessage: () => ({ role: "assistant", content: "failed" }),
    materializeDraftSession,
    persistSessionAndSelect: async () => assert.fail("a failed start must not persist a session"),
    flushPendingSessionConfiguration: async () => {},
  });
  Object.assign(state, slice);
  const text = "Fix the flaky upload test";
  const draft = { text, fileReferences: [] };
  let composerText = text;
  return {
    toasts,
    state: () => state,
    composerText: () => composerText,
    /** What the composer's Send does: clear the box, send, restore on rejection. */
    async send() {
      composerText = "";
      return submitWithLatestDraftRestore(
        "home",
        () => slice.sendPrompt(text, draft, undefined, undefined, true),
        () => { composerText = draft.text; },
      );
    },
  };
}

const cases = [
  {
    name: "an offline host behind a no-repository environment",
    target: { environmentId: ENVIRONMENT.id },
    main: {
      [IPC.invoke.environmentsList]: () => ({ ok: true, data: { environments: [ENVIRONMENT] } }),
      [IPC.invoke.remoteHostCreateSession]: () => failure("AGENT_UNAVAILABLE", "remote host is disconnected"),
    },
    expected: () => startFailed(en.sessionTarget.errors.hostOffline),
    raw: /remote host is disconnected/,
  },
  {
    name: "a no-repository host on another release",
    target: { environmentId: ENVIRONMENT.id },
    main: {
      [IPC.invoke.environmentsList]: () => ({ ok: true, data: { environments: [ENVIRONMENT] } }),
      [IPC.invoke.remoteHostCreateSession]: () => failure(
        "HOST_VERSION_MISMATCH",
        "Upgrade pi-host to use Environment setup and variables in sessions without a repository",
      ),
    },
    expected: () => startFailed(en.sessionTarget.errors.hostOutdated),
    raw: /Upgrade pi-host/,
  },
  {
    name: "an offline host behind a repository target",
    target: { environmentId: ENVIRONMENT.id, repository: REPOSITORY },
    main: {
      [IPC.invoke.remoteSessionTargetResolve]: () => failure(
        "REMOTE_TARGET_HOST_OFFLINE",
        "The selected remote host is offline",
      ),
    },
    expected: () => startFailed(en.sessionTarget.errors.hostOffline),
    raw: /The selected remote host is offline/,
  },
  {
    name: "a repository target with GitHub disconnected",
    target: { environmentId: ENVIRONMENT.id, repository: REPOSITORY },
    main: {
      [IPC.invoke.remoteSessionTargetResolve]: () => failure(
        "GITHUB_NOT_CONNECTED",
        "Connect GitHub to start a repository session",
      ),
    },
    expected: () => startFailed(en.errors.GITHUB_NOT_CONNECTED),
    raw: /Connect GitHub to start a repository session/,
  },
  {
    name: "an environment that no longer exists",
    target: { environmentId: ENVIRONMENT.id },
    main: {
      [IPC.invoke.environmentsList]: () => ({ ok: true, data: { environments: [] } }),
    },
    expected: () => startFailed(en.sessionTarget.environmentUnavailable),
  },
];

for (const scenario of cases) {
  test(`Send explains ${scenario.name} and restores the draft`, async () => {
    useSessionTargetStore.getState().beginDraft(scenario.target);
    stubMain(scenario.main);
    const composer = homeComposer();

    assert.equal(await composer.send(), false);

    assert.equal(composer.composerText(), "Fix the flaky upload test");
    assert.deepEqual(composer.toasts, [{ message: scenario.expected(), variant: "error" }]);
    if (scenario.raw) assert.doesNotMatch(composer.toasts[0].message, scenario.raw);
    assert.deepEqual(composer.state().sessions, []);
    assert.equal(composer.state().activeSessionId, undefined);
  });
}

test("a failed start releases the draft so the next Send tries again", async () => {
  useSessionTargetStore.getState().beginDraft({ environmentId: ENVIRONMENT.id });
  const calls = stubMain(cases[0].main);
  const composer = homeComposer();

  assert.equal(await composer.send(), false);
  assert.equal(await composer.send(), false);

  assert.equal(calls.filter((channel) => channel === IPC.invoke.remoteHostCreateSession).length, 2);
  assert.equal(composer.toasts.length, 2);
});

test("a local draft that cannot start explains why once and restores the draft", async () => {
  useSessionTargetStore.getState().beginDraft({ environmentId: "local" });
  stubMain({});
  const composer = homeComposer({
    materializeDraftSession: async () => {
      throw Object.assign(new Error("host unavailable"), { code: "HOST_UNAVAILABLE" });
    },
  });

  assert.equal(await composer.send(), false);

  assert.equal(composer.composerText(), "Fix the flaky upload test");
  const reason = en.errors.HOST_UNAVAILABLE;
  assert.equal(typeof reason, "string");
  assert.deepEqual(composer.toasts, [{
    message: en.sessionTarget.sendFailure.message.replace("{{message}}", reason),
    variant: "error",
  }]);
});

test("a local failure without a catalog sentence keeps its own message", async () => {
  useSessionTargetStore.getState().beginDraft({ environmentId: "local" });
  stubMain({});
  const composer = homeComposer({
    materializeDraftSession: async () => { throw new Error("disk quota exceeded"); },
  });

  assert.equal(await composer.send(), false);

  assert.deepEqual(composer.toasts.map((toast) => toast.message), [
    en.sessionTarget.sendFailure.message.replace("{{message}}", "disk quota exceeded"),
  ]);
});
