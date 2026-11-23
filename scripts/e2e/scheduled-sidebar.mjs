import assert from "node:assert/strict";
import { waitFor } from "./wait.mjs";

export async function verifyScheduledSidebar({ invoke, evaluate, click, choose }) {
  const title = "Temporary scheduled review";
  const { task } = await invoke("scheduledCreate", {
    title, prompt: "Reply with the result.", cadence: "manual", workspacePath: null,
  });
  const openScheduled = async () => {
    await evaluate(`document.querySelector('[data-nav="scheduled"]').click()`);
    await waitFor(() => evaluate(`document.querySelector('.page-title')?.textContent === 'Scheduled'`), 5000, "scheduled page");
  };
  const checkbox = 'form input[type="checkbox"]';
  const check = 'Show in sidebar after completion';
  await openScheduled();
  await click("Edit task");
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(checkbox)})?.checked === false`), 5000, "sidebar checkbox defaults to off");
  await choose("Conversation", "Reuse one conversation");
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(checkbox)})`), false);
  await choose("Conversation", "New conversation per run");
  await click(check, "form label.ui-checkbox");
  await click("Save task");
  await waitFor(async () => {
    const { tasks } = await invoke("scheduledList");
    return tasks.find(({ id }) => id === task.id)?.showInSidebar &&
      !(await evaluate(`!!document.querySelector('form')`));
  }, 5000, "saved sidebar visibility");

  const tempGroup = '[data-sidebar-session-section="temporary"]';
  const rowButton = (id) => `${tempGroup} [data-sidebar-session-row="${id}"] .thread-item-main`;
  const waitForOpenSession = (id) => waitFor(() => evaluate(`
    document.querySelector(${JSON.stringify(rowButton(id))})?.getAttribute('aria-current') === 'page'
      && document.body.innerText.includes('Scheduled review complete.')
  `), 10_000, `opened run ${id}`);
  const sessionIds = [];
  for (const count of [1, 2]) {
    await click("Run now");
    let run;
    await waitFor(async () => {
      const { runs } = await invoke("scheduledListRuns", { taskId: task.id });
      run = runs[0];
      return runs.length === count && run.status === "completed";
    }, 30_000, `completed run ${count}`);
    sessionIds.push(run.sessionId);
    await waitFor(() => evaluate(`
      document.querySelector(${JSON.stringify(rowButton(run.sessionId))})?.textContent.trim() === ${JSON.stringify(title)}
    `), 5000, `sidebar entry for run ${count}`);
    await click(title, rowButton(run.sessionId));
    await waitForOpenSession(run.sessionId);
    await openScheduled();
  }
  assert.notEqual(sessionIds[0], sessionIds[1]);
  for (const [index, id] of sessionIds.toReversed().entries()) {
    await openScheduled();
    await click("Open conversation", `.scheduled-runs .scheduled-run:nth-child(${index + 1}) button[aria-label]`, true);
    await waitForOpenSession(id);
  }
  await invoke("scheduledDelete", task.id);
  console.log("PASS opted-in task adds two titled temporary conversations, both reachable from the sidebar and run history");
}
