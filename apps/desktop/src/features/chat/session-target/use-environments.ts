import { useEffect, useState } from "react";
import type { RemoteEnvironment, RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

export function useEnvironments() {
  const [environments, setEnvironments] = useState<RemoteEnvironment[]>([]);
  const [inventory, setInventory] = useState<{ hosts: RemoteHostSummary[]; hostRevision: number }>({ hosts: [], hostRevision: 0 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void Promise.all([api.listEnvironments(), api.listRemoteHosts()]).then(([env, paired]) => {
        if (current !== generation) return;
        setEnvironments(env.environments);
        setInventory({ hosts: paired.hosts, hostRevision: current });
        setError(undefined);
        setLoaded(true);
      }, (cause) => {
        if (current === generation) setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    const offEnv = api.onEnvironmentsChanged(refresh);
    const offHost = api.onSessionsChanged((event) => {
      if (event.reason === "remote.host.changed" || event.reason === "remote.leftovers.changed") refresh();
    });
    refresh();
    return () => { ++generation; offEnv(); offHost(); };
  }, []);
  return { environments, ...inventory, loaded, error };
}
