/**
 * Checks for the environment editor's variable rows, with the same rules the
 * Host applies when it saves an environment: a name from the shared
 * `isEnvironmentVariableName` rule (which also refuses reserved names), and
 * each name once, compared exactly as the Host does.
 */
import { isEnvironmentVariableName } from "@pi-desktop/shared";

export type EnvironmentVariableRow = { id: string; name: string; value: string };
export type EnvironmentVariableProblem = "required" | "invalid" | "duplicate";

/** The rows the editor saves: a row left entirely blank is dropped, names are trimmed. */
export function environmentVariablesToSave(rows: readonly EnvironmentVariableRow[]) {
  return rows
    .filter((row) => row.name.trim() || row.value)
    .map(({ name, value }) => ({ name: name.trim(), value }));
}

/** Each row whose name the Host would refuse, by row id. */
export function environmentVariableProblems(
  rows: readonly EnvironmentVariableRow[],
): ReadonlyMap<string, EnvironmentVariableProblem> {
  const problems = new Map<string, EnvironmentVariableProblem>();
  const firstWithName = new Map<string, string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) {
      if (row.value) problems.set(row.id, "required");
      continue;
    }
    if (!isEnvironmentVariableName(name)) {
      problems.set(row.id, "invalid");
      continue;
    }
    const first = firstWithName.get(name);
    if (first === undefined) {
      firstWithName.set(name, row.id);
      continue;
    }
    problems.set(first, "duplicate");
    problems.set(row.id, "duplicate");
  }
  return problems;
}
