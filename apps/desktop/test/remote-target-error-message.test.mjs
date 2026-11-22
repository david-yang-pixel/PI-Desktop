import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import i18n from "i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { remoteTargetErrorText, remoteTargetErrorTextForCode } = await import(
  "../src/features/chat/session-target/remote-target-error-message.ts"
);

const en = catalogs.en;
const zhCN = catalogs["zh-CN"];
const translator = i18n.createInstance();
await translator.init({
  lng: "en",
  keySeparator: false,
  resources: {
    en: { translation: flattenCatalog(en) },
    "zh-CN": { translation: flattenCatalog(zhCN) },
  },
  interpolation: { escapeValue: false },
});
const t = (key, options) => translator.t(key, options);
const coded = (code, message) => Object.assign(new Error(message), { code });

test("every remote target and workspace code main reports maps to a catalog sentence", () => {
  const expected = {
    AGENT_UNAVAILABLE: en.sessionTarget.errors.hostOffline,
    HOST_DISCONNECTED: en.sessionTarget.errors.hostOffline,
    REMOTE_CONNECTION_FAILED: en.sessionTarget.errors.hostOffline,
    REMOTE_TARGET_HOST_OFFLINE: en.sessionTarget.errors.hostOffline,
    HOST_VERSION_MISMATCH: en.sessionTarget.errors.hostOutdated,
    REMOTE_TARGET_UNSUPPORTED: en.sessionTarget.errors.hostOutdated,
    REMOTE_ENVIRONMENT_NOT_FOUND: en.sessionTarget.environmentUnavailable,
    REMOTE_WORKSPACE_NOT_READY: en.sessionTarget.errors.workspaceNotReady,
    REMOTE_WORKSPACE_CANCELLED: en.sessionTarget.preparationControl.cancelled,
    WORKSPACE_GIT_UNAVAILABLE: en.sessionTarget.errors.gitUnavailable,
    WORKSPACE_GIT_AUTH_REQUIRED: en.sessionTarget.errors.gitAuthRequired,
    WORKSPACE_GIT_REPOSITORY_NOT_FOUND: en.errors.GITHUB_NOT_FOUND,
    WORKSPACE_GIT_BRANCH_NOT_FOUND: en.sessionTarget.errors.branchNotFound,
    WORKSPACE_GIT_NOT_FOUND: en.sessionTarget.errors.worktreeMissing,
    WORKSPACE_GIT_BUSY: en.sessionTarget.errors.gitBusy,
    WORKSPACE_GIT_JOB_NOT_FOUND: en.sessionTarget.errors.gitFailed,
    WORKSPACE_GIT_FAILED: en.sessionTarget.errors.gitFailed,
    WORKSPACE_GIT_SETUP_FAILED: en.sessionTarget.errors.setupRequired,
    WORKSPACE_GIT_TRANSPORT_REFUSED: en.sessionTarget.errors.transportRefused,
    WORKSPACE_GIT_PUSH_REJECTED: en.sessionTarget.gitErrors.pushRejected,
    WORKSPACE_GIT_WORKFLOW_SCOPE_REQUIRED: en.sessionTarget.gitErrors.workflowScopeRequired,
    WORKSPACE_GIT_STALLED: en.sessionTarget.gitErrors.stalled,
    WORKSPACE_GIT_CREDENTIAL_UNAVAILABLE: en.sessionTarget.errors.credentialUnavailable,
  };
  for (const [code, sentence] of Object.entries(expected)) {
    assert.equal(typeof sentence, "string", code);
    assert.equal(remoteTargetErrorText(t, coded(code, "raw main text")), sentence, code);
  }
});

test("GitHub connector codes keep the connector's sentences", () => {
  assert.equal(
    remoteTargetErrorText(t, coded("GITHUB_NOT_CONNECTED", "Connect GitHub to start a repository session")),
    en.errors.GITHUB_NOT_CONNECTED,
  );
});

test("the sentence follows the current language", async () => {
  await translator.changeLanguage("zh-CN");
  try {
    assert.equal(
      remoteTargetErrorText(t, coded("REMOTE_TARGET_HOST_OFFLINE", "The selected remote host is offline")),
      zhCN.sessionTarget.errors.hostOffline,
    );
    assert.equal(
      remoteTargetErrorTextForCode(t, "WORKSPACE_GIT_PUSH_REJECTED", "! [rejected] (fetch first)"),
      zhCN.sessionTarget.gitErrors.pushRejected,
    );
  } finally {
    await translator.changeLanguage("en");
  }
});

test("a failure without a mapped code keeps its own message", () => {
  // The renderer's own target checks throw text that is already localized.
  assert.equal(
    remoteTargetErrorText(t, new Error(en.sessionTarget.branchRequired)),
    en.sessionTarget.branchRequired,
  );
  assert.equal(remoteTargetErrorText(t, coded("INTERNAL", "disk quota exceeded")), "disk quota exceeded");
  assert.equal(remoteTargetErrorText(t, "plain rejection"), "plain rejection");
  assert.equal(remoteTargetErrorText(t, undefined), "undefined");
});

test("codes from across the IPC boundary cannot reach object prototype keys", () => {
  for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(remoteTargetErrorTextForCode(t, code, "fallback"), "fallback", code);
  }
  assert.equal(remoteTargetErrorTextForCode(t, 42, "fallback"), "fallback");
});
