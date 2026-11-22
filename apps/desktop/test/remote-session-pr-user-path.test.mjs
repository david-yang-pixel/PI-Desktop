import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs } from "@pi-desktop/i18n";
import { EnvironmentEditor } from "./src/features/chat/session-target/EnvironmentEditor";
import { WorkspacePreparationStatus } from "./src/features/chat/session-target/WorkspacePreparationStatus";

globalThis.remoteWorkspaceProbe = async () => {
  await i18n.use(initReactI18next).init({ lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
  const invoked = [];
  const savedEnvironments = [];
  let savedEnvironment;
  window.piDesktop = {
    on() { return () => {}; },
    async invoke(channel, input) {
      invoked.push(channel);
      let data;
      switch (channel) {
        case IPC.invoke.remoteSessionWorkspaceRetry: data = {}; break;
        case IPC.invoke.environmentsUpsert:
          savedEnvironments.push(input);
          data = { environment: { ...input, isDefault: false } };
          break;
        default: throw new Error("Unexpected channel " + channel);
      }
      return { ok: true, data };
    },
  };
  const view = createRoot(document.querySelector("#root"));
  const button = (label, container = document) => [...container.querySelectorAll("button")]
    .find((element) => element.textContent.trim() === label);
  async function until(read, description) {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(description);
  }
  flushSync(() => view.render(<WorkspacePreparationStatus sessionId="session" workspace={{
    state: "failed", error: { message: "Setup failed" }, setup: { status: "failed", logTail: "Build failed" },
  }} />));
  const disclosure = document.querySelector("details");
  disclosure.querySelector("summary").click();
  if (!disclosure.open || disclosure.querySelector("pre").textContent !== "Build failed") {
    throw new Error("setup log could not be opened");
  }
  button("Retry").click();
  if (invoked.at(-1) !== IPC.invoke.remoteSessionWorkspaceRetry) throw new Error("retry was not dispatched");

  flushSync(() => view.render(<EnvironmentEditor hosts={[{ hostKey: "host", label: "Build host" }]}
    environment={{ id: "environment", name: "Build", hostKey: "host" }}
    onSaved={(value) => { savedEnvironment = value; }} onClose={() => {}} />));
  const hours = document.querySelector('input[type="number"]');
  const directories = document.querySelector("textarea[aria-describedby]");
  if (hours?.value !== "72" || directories?.value !== "") throw new Error("missing legacy settings defaults");
  function fill(element, value) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  for (const value of ["", "-1", "1.5", "8761"]) {
    fill(hours, value);
    if (!button("Save").disabled || hours.getAttribute("aria-invalid") !== "true") {
      throw new Error("accepted invalid idle hours: " + value);
    }
  }
  for (const value of ["0", "1", "8760"]) {
    fill(hours, value);
    if (button("Save").disabled) throw new Error("rejected valid idle hours: " + value);
  }
  for (const value of ["  /node_modules  ", "../cache", "packages/*/dist", "a".repeat(257),
    Array.from({ length: 65 }, (_, index) => "cache-" + index).join("\n")]) {
    fill(directories, value);
    if (!button("Save").disabled || directories.getAttribute("aria-invalid") !== "true") {
      throw new Error("accepted invalid regenerable directory input: " + value);
    }
  }
  fill(directories, ["a".repeat(256), ...Array.from({ length: 63 }, (_, index) => "cache-" + index)].join("\n"));
  if (button("Save").disabled) throw new Error("rejected directories at the limits");
  fill(hours, "0");
  fill(directories, "  node_modules  \n\n  client/dist\n");
  button("Save").click();
  await until(() => savedEnvironment, "environment settings were not saved");
  const [input] = savedEnvironments;
  if (savedEnvironments.length !== 1 || input.id !== "environment" || input.idleReclaimHours !== 0 ||
    JSON.stringify(input.regenerableDirs) !== JSON.stringify(["node_modules", "client/dist"])) {
    throw new Error("wrong environment settings payload: " + JSON.stringify(input));
  }
  return true;
};
`;

test("remote workspace exposes rebuild retry and saves environment settings", {
  timeout: 75_000,
  skip: process.platform === "linux" && !process.env.DISPLAY && "Isolated Electron UI test requires a display",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-remote-pr-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "apps/desktop"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  await window.loadFile(join(__dirname, "index.html"));
  if (await window.webContents.executeJavaScript("globalThis.remoteWorkspaceProbe()") !== true) {
    throw new Error("Remote workspace probe did not complete");
  }
  console.log("REMOTE_WORKSPACE_PROBE passed");
  app.exit(0);
}).catch((error) => { console.error(error.stack ?? error); app.exit(1); });
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      const [code] = await once(child, "close");
      assert.equal(code, 0, output);
      assert.match(output, /^REMOTE_WORKSPACE_PROBE passed$/m, output);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
