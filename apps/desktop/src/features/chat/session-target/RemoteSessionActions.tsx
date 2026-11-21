import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionRemoteRepository } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

export function RemoteSessionActions({ workspace }: { workspace: SessionRemoteRepository }) {
  const { t } = useTranslation();
  const toast = useAppStore((state) => state.showToast);
  const [hostLabel, setHostLabel] = useState(workspace.hostLabel ?? workspace.hostKey);
  const pullRequest = workspace.pullRequest;

  useEffect(() => {
    let current = true;
    void api.listRemoteHosts().then(({ hosts }) => {
      if (current) setHostLabel(hosts.find((host) => host.hostKey === workspace.hostKey)?.label ?? workspace.hostKey);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [workspace.hostKey]);

  return <div className="session-target-row">
    <span title={hostLabel}>
      {`${hostLabel} · ${workspace.repository.owner}/${workspace.repository.name}`}{workspace.workBranch ? ` · ${workspace.workBranch}` : ""}
    </span>
    {pullRequest && <Button variant="secondary" onClick={() => {
      void api.browserOpenExternal(pullRequest.url).catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { variant: "error" });
      });
    }}>{t("sessionTarget.openPullRequest", { number: pullRequest.number })}</Button>}
  </div>;
}
