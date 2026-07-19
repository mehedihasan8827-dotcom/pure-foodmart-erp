import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import {
  demoDailySeries,
  demoDashboard,
  demoFunds,
  type DailyPl,
  type DashboardData,
  type FundsData,
} from "./demo-data";

/**
 * Live refresh (blueprint §12.1 step 6): one EventSource per open page,
 * fed by the ledger's own pg_notify → SSE fan-out. Every committed
 * journal entry pings connected dashboards, which refetch.
 */
function useLedgerEvents(onEvent: () => void): boolean {
  const { mode, activeTenant } = useAuth();
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (mode !== "live" || !activeTenant) return;
    const source = new EventSource(
      `/api/v1/portal/live?tenantId=${activeTenant.tenantId}`,
    );
    source.addEventListener("hello", () => setConnected(true));
    source.addEventListener("ledger", () => cb.current());
    source.onerror = () => setConnected(false);
    return () => {
      source.close();
      setConnected(false);
    };
  }, [mode, activeTenant]);
  return connected;
}

interface Loadable<T> {
  data: T | null;
  error: string | null;
  live: boolean; // SSE connected (live mode only)
  reload: () => void;
}

function useReport<T>(path: string, demo: T): Loadable<T> {
  const { mode, api } = useAuth();
  const [data, setData] = useState<T | null>(mode === "demo" ? demo : null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (mode === "demo") {
      setData(demo);
      return;
    }
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, path]);

  useEffect(reload, [reload]);
  const live = useLedgerEvents(reload);
  return { data, error, live, reload };
}

export function useDashboard(): Loadable<DashboardData> {
  return useReport<DashboardData>("/portal/reports/dashboard", demoDashboard);
}

export function useDailySeries(): Loadable<DailyPl[]> {
  return useReport<DailyPl[]>("/portal/reports/daily?days=14", demoDailySeries);
}

export function useFunds(): Loadable<FundsData> {
  return useReport<FundsData>("/portal/reports/funds", demoFunds);
}
