/**
 * Run a renderer fixture in a hidden, sandboxed Electron window.
 *
 * The fixture is TSX source resolved from `apps/desktop`. It must define
 * `globalThis.rendererProbe` as an async function that drives the real
 * components through the DOM and resolves `true`, or throws to fail. Only
 * `window.piDesktop` (main's side of the IPC bridge) should be stubbed.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "../../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

/** Skip reason for `node:test` when no display is available. */
export const electronProbeSkip =
  process.platform === "linux" && !process.env.DISPLAY && "Isolated Electron UI test requires a display";

const MARKER = "RENDERER_PROBE passed";

export async function runRendererProbe(fixture) {
  const temp = await mkdtemp(join(tmpdir(), "pi-renderer-probe-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "apps/desktop"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "empty" },
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
  if (await window.webContents.executeJavaScript("globalThis.rendererProbe()") !== true) {
    throw new Error("renderer probe did not complete");
  }
  console.log(${JSON.stringify(MARKER)});
  app.exit(0);
}).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
`);
    const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "0" };
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
      return { code, output, passed: code === 0 && output.split("\n").some((line) => line === MARKER) };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** DOM helpers the fixtures share, as source to paste into a fixture. */
export const probeDomHelpers = String.raw`
const button = (label, container = document) => [...container.querySelectorAll("button")]
  .find((element) => element.textContent.trim() === label);
async function until(read, description, timeout = 5_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(description);
}
function fill(element, value) {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
`;
