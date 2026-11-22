import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RacpHostModel } from "@pi-desktop/shared";
import { IconBot, IconChevronDown } from "../../../components/icons";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { Button, Input, TooltipButton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useSessionTargetStore } from "./session-target-store";
import "./session-target.css";

type Catalog = { hostKey: string; models: RacpHostModel[] };

export function HostSessionModelPicker({ environmentId, disabled }: { environmentId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const selection = useSessionTargetStore((state) => state.hostModel);
  const setHostModel = useSessionTargetStore((state) => state.setHostModel);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (disabled) close();
  }, [close, disabled]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const { environments } = await api.listEnvironments();
        if (!current) return;
        const environment = environments.find((entry) => entry.id === environmentId);
        if (!environment) throw new Error(t("sessionTarget.environmentUnavailable"));
        const { models } = await api.listRemoteHostModels(environment.hostKey);
        if (current) setCatalog({ hostKey: environment.hostKey, models });
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [environmentId, open, retry, t]);

  const selected = selection?.hostKey === catalog?.hostKey ? selection?.selection : undefined;
  const activeModel = catalog?.models.find((model) =>
    model.providerId === selected?.providerId && model.modelId === selected.modelId,
  );
  const label = activeModel?.alias ?? selection?.selection.modelId ?? t("sessionTarget.hostDefaultModel");
  const modelLabel = t("chat.model");
  const visibleModels = catalog?.models.filter((model) =>
    `${model.alias ?? ""} ${model.modelId} ${model.providerName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ) ?? [];

  return (
    <AnchoredMenu
      open={open && !disabled}
      onClose={close}
      label={modelLabel}
      role="dialog"
      className="composer-model-thinking"
      menuClassName="session-target-menu"
      align="end"
      side="top"
      initialFocus="input"
      trigger={(ref) => (
        <TooltipButton ref={ref} type="button" className="icon-btn composer-model-thinking-chip"
          data-nav="host-session-model" tooltip={label} ariaLabel={`${modelLabel}: ${label}`}
          aria-haspopup="dialog" aria-expanded={open && !disabled} disabled={disabled}
          onClick={() => { setQuery(""); setOpen((value) => !value); }}>
          <IconBot size={14} aria-hidden />
          <span className="composer-model-thinking-model">{label}</span>
          <IconChevronDown size={12} aria-hidden className="composer-model-thinking-chevron" />
        </TooltipButton>
      )}
    >
      <Input aria-label={modelLabel} placeholder={modelLabel} value={query} onChange={(event) => setQuery(event.target.value)} />
      <Button type="button" variant="secondary" aria-pressed={!selection} onClick={() => {
        if (selection) setHostModel(environmentId, selection.hostKey);
        close();
      }}>
        {t("sessionTarget.hostDefaultModel")}
      </Button>
      {loading && <p role="status">{t("app.loadingView")}</p>}
      {error && <>
        <p role="alert">{t("sessionTarget.loadFailed", { message: error })}</p>
        <Button type="button" variant="secondary" onClick={() => setRetry((value) => value + 1)}>{t("sessionTarget.refresh")}</Button>
      </>}
      {!loading && !error && catalog && visibleModels.map(({ providerId, providerName, modelId, alias }) => (
        <Button type="button" variant="secondary" key={JSON.stringify([providerId, modelId])}
          aria-pressed={providerId === selected?.providerId && modelId === selected.modelId}
          onClick={() => { setHostModel(environmentId, catalog.hostKey, { providerId, modelId }); close(); }}>
          {alias ?? modelId} · {providerName}
        </Button>
      ))}
    </AnchoredMenu>
  );
}
