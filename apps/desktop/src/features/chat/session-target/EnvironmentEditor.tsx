import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_IDLE_RECLAIM_HOURS,
  MAX_IDLE_RECLAIM_HOURS,
  WORKSPACE_GIT_MAX_REGENERABLE_DIR_LENGTH,
  WORKSPACE_GIT_MAX_REGENERABLE_DIRS,
  isRegenerableDirPath,
  type RemoteEnvironment,
  type RemoteHostSummary,
} from "@pi-desktop/shared";
import { Button, Field, Input, Select, Textarea } from "../../../components/ui";
import { api } from "../../../lib/api";
import { WorktreeDialogFrame } from "../../worktree/WorktreeDialogFrame";
import { environmentVariableProblems, environmentVariablesToSave } from "./environment-variables";
import { remoteTargetErrorText } from "./remote-target-error-message";

export function EnvironmentEditor({ hosts, environment, onSaved, onClose }: {
  hosts: RemoteHostSummary[];
  environment?: RemoteEnvironment;
  onSaved(environment: RemoteEnvironment): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(environment?.name ?? "");
  const [hostKey, setHostKey] = useState(environment?.hostKey ?? hosts[0]?.hostKey ?? "");
  const [script, setScript] = useState(environment?.setupScript ?? "");
  const [reclaimHours, setReclaimHours] = useState(String(environment?.idleReclaimHours ?? DEFAULT_IDLE_RECLAIM_HOURS));
  const [regenerableDirLines, setRegenerableDirLines] = useState((environment?.regenerableDirs ?? []).join("\n"));
  const [variables, setVariables] = useState(() => (environment?.variables ?? []).map((row) => ({ ...row, id: crypto.randomUUID() })));
  const [busy, setBusy] = useState(false);
  // The rejection itself, so its text follows the current language.
  const [error, setError] = useState<{ cause: unknown }>();
  const close = useCallback(() => onClose(), [onClose]);
  const hoursHintId = useId();
  const directoriesHintId = useId();
  const directoriesErrorId = useId();
  const variablesNoteId = useId();
  const variablesErrorId = useId();
  const idleReclaimHours = Number(reclaimHours);
  const validHours = reclaimHours !== "" && Number.isInteger(idleReclaimHours)
    && idleReclaimHours >= 0 && idleReclaimHours <= MAX_IDLE_RECLAIM_HOURS;
  const regenerableDirs = regenerableDirLines.split("\n").map((path) => path.trim()).filter(Boolean);
  let directoriesError: string | undefined;
  if (regenerableDirs.length > WORKSPACE_GIT_MAX_REGENERABLE_DIRS) {
    directoriesError = t("sessionTarget.regenerableDirsLimit", { count: WORKSPACE_GIT_MAX_REGENERABLE_DIRS });
  } else if (regenerableDirs.some((path) => !isRegenerableDirPath(path))) {
    directoriesError = t("sessionTarget.regenerableDirsInvalid", { maxLength: WORKSPACE_GIT_MAX_REGENERABLE_DIR_LENGTH });
  }
  const variableProblems = environmentVariableProblems(variables);
  const problemKinds = new Set(variableProblems.values());
  const variablesError = [
    problemKinds.has("required") && t("sessionTarget.environmentEditor.variableNameRequired"),
    problemKinds.has("invalid") && t("sessionTarget.environmentEditor.variableNameInvalid"),
    problemKinds.has("duplicate") && t("sessionTarget.environmentEditor.variableNameDuplicate"),
  ].filter(Boolean).join(" ");
  const canSave = !busy && Boolean(name.trim()) && Boolean(hostKey) && validHours && !directoriesError && !variablesError;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.upsertEnvironment({
        id: environment?.id, name: name.trim(), hostKey, setupScript: script,
        variables: environmentVariablesToSave(variables),
        idleReclaimHours, regenerableDirs,
      });
      onSaved(result.environment);
    } catch (cause) {
      setError({ cause });
    } finally {
      setBusy(false);
    }
  }
  function edit(id: string, key: "name" | "value", value: string) {
    setVariables((rows) => rows.map((item) => item.id === id ? { ...item, [key]: value } : item));
  }
  return <WorktreeDialogFrame id="remote-environment" title={t(environment ? "sessionTarget.editEnvironment" : "sessionTarget.newEnvironment")} busy={busy} onClose={close}
    actions={<Button disabled={!canSave} onClick={() => void save()}>{t("sessionTarget.save")}</Button>}>
    <p className="session-target-note">{t("sessionTarget.environmentEditor.appliesToNewSessions")}</p>
    <Field label={t("sessionTarget.environmentName")}><Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label={t("sessionTarget.environmentHost")}><Select disabled={Boolean(environment)} value={hostKey} onChange={(event) => setHostKey(event.target.value)}>
      {hosts.map((host) => <option key={host.hostKey} value={host.hostKey}>{host.label}</option>)}
    </Select></Field>
    <Field label={t("sessionTarget.setupScript")} hint={t("sessionTarget.setupScriptHint")}>
      <Textarea value={script} maxLength={65_536} rows={5} onChange={(event) => setScript(event.target.value)} />
    </Field>
    <div>
      <Field label={t("sessionTarget.idleReclaimHours")}>
        <Input type="number" min={0} max={MAX_IDLE_RECLAIM_HOURS} step={1} value={reclaimHours}
          aria-describedby={hoursHintId} aria-invalid={!validHours || undefined}
          onChange={(event) => setReclaimHours(event.target.value)} />
      </Field>
      <p id={hoursHintId} className="session-target-note" role={validHours ? undefined : "alert"}>
        {t("sessionTarget.idleReclaimHoursHint", { maxHours: MAX_IDLE_RECLAIM_HOURS })}
      </p>
    </div>
    <div>
      <Field label={t("sessionTarget.regenerableDirs")}>
        <Textarea rows={3} value={regenerableDirLines} aria-invalid={Boolean(directoriesError) || undefined}
          aria-describedby={directoriesError ? `${directoriesHintId} ${directoriesErrorId}` : directoriesHintId}
          onChange={(event) => setRegenerableDirLines(event.target.value)} />
      </Field>
      <p id={directoriesHintId} className="session-target-note">{t("sessionTarget.regenerableDirsHint")}</p>
      {directoriesError && <p id={directoriesErrorId} role="alert">{directoriesError}</p>}
    </div>
    <Field label={t("sessionTarget.variables")}>
      <div className="session-target-fields">
        <p id={variablesNoteId} className="session-target-note">{t("sessionTarget.environmentEditor.plainText")}</p>
        {variables.map((variable) => <div className="session-target-row" key={variable.id}>
          <Input aria-label={t("sessionTarget.variableName")} value={variable.name} maxLength={128}
            aria-invalid={variableProblems.has(variable.id) || undefined}
            aria-describedby={variableProblems.has(variable.id) ? `${variablesNoteId} ${variablesErrorId}` : variablesNoteId}
            onChange={(event) => edit(variable.id, "name", event.target.value)} />
          <Input aria-label={t("sessionTarget.variableValue")} value={variable.value} maxLength={8192} onChange={(event) => edit(variable.id, "value", event.target.value)} />
          <Button variant="secondary" onClick={() => setVariables((rows) => rows.filter((row) => row.id !== variable.id))}>{t("sessionTarget.remove")}</Button>
        </div>)}
        <Button variant="secondary" disabled={variables.length >= 64} onClick={() => setVariables((rows) => [...rows, { name: "", value: "", id: crypto.randomUUID() }])}>{t("sessionTarget.addVariable")}</Button>
        {variablesError && <p id={variablesErrorId} role="alert">{variablesError}</p>}
      </div>
    </Field>
    {error && <p role="alert">{remoteTargetErrorText(t, error.cause)}</p>}
  </WorktreeDialogFrame>;
}
