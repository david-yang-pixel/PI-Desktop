import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { environmentVariableProblems, environmentVariablesToSave } = await import(
  "../src/features/chat/session-target/environment-variables.ts"
);

// The environment editor checks names with the Host's own rule, so a name the
// Host would refuse is flagged before Save instead of failing after it.

const row = (id, name, value = "x") => ({ id, name, value });

test("names follow the shared variable rule, reserved names included", () => {
  const problems = environmentVariableProblems([
    row("ok", "API_URL"),
    row("underscore", "_PRIVATE"),
    row("digit", "1BAD"),
    row("dash", "API-URL"),
    row("space", "API URL"),
    row("path", "PATH"),
    row("git", "GIT_DIR"),
    row("pi", "PI_TOKEN"),
    row("trimmed", "  NODE_ENV  "),
  ]);
  assert.deepEqual(Object.fromEntries(problems), {
    digit: "invalid",
    dash: "invalid",
    space: "invalid",
    path: "invalid",
    git: "invalid",
    pi: "invalid",
  });
});

test("a repeated name flags every row that uses it, compared exactly like the Host", () => {
  const problems = environmentVariableProblems([
    row("a", "TOKEN_NAME"),
    row("b", "OTHER"),
    row("c", " TOKEN_NAME"),
    row("d", "token_name"),
  ]);
  assert.deepEqual(Object.fromEntries(problems), { a: "duplicate", c: "duplicate" });
});

test("a value without a name needs one, and an untouched blank row is not saved", () => {
  const rows = [row("blank", "", ""), row("value", " ", "secret"), row("ok", " API_URL ", "https://example.test")];
  assert.deepEqual(Object.fromEntries(environmentVariableProblems(rows)), { value: "required" });
  assert.deepEqual(environmentVariablesToSave([rows[0], rows[2]]), [{ name: "API_URL", value: "https://example.test" }]);
});
