import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { demoPrincipal } from "./demo-data";

export interface Membership {
  tenantId: number;
  tenantName: string;
  tenantStatus: string;
  role: "TENANT_ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER";
}

export interface Principal {
  userId: number;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  totpEnabled: boolean;
  memberships: Membership[];
}

export type LoginOutcome = "ok" | "totp-required" | "error";

interface AuthState {
  mode: "demo" | "live" | null;
  principal: Principal | null;
  activeTenant: Membership | null;
  login: (
    email: string,
    password: string,
    totpCode?: string,
  ) => Promise<{ outcome: LoginOutcome; message?: string }>;
  enterDemo: () => void;
  logout: () => Promise<void>;
  setActiveTenant: (tenantId: number) => void;
  /** Authenticated fetch against /api/v1 with tenant scoping. */
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const AuthContext = createContext<AuthState | null>(null);
const BASE = "/api/v1";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthState["mode"]>(() =>
    (localStorage.getItem("pfm.mode") as AuthState["mode"]) ?? null,
  );
  const [principal, setPrincipal] = useState<Principal | null>(() =>
    mode === "demo" ? (demoPrincipal as Principal) : null,
  );
  const [tenantId, setTenantId] = useState<number | null>(null);

  // Live mode: try to restore the cookie session on load.
  useEffect(() => {
    if (mode !== "live") return;
    void (async () => {
      try {
        const res = await fetch(`${BASE}/auth/me`, { credentials: "include" });
        if (res.ok) setPrincipal((await res.json()) as Principal);
        else {
          setMode(null);
          localStorage.removeItem("pfm.mode");
        }
      } catch {
        setMode(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTenant = useMemo(() => {
    if (!principal) return null;
    return (
      principal.memberships.find((m) => m.tenantId === tenantId) ??
      principal.memberships[0] ??
      null
    );
  }, [principal, tenantId]);

  const value = useMemo<AuthState>(
    () => ({
      mode,
      principal,
      activeTenant,
      async login(email, password, totpCode) {
        const res = await fetch(`${BASE}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, password, totpCode }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          code?: string;
          message?: string;
          principal?: Principal;
        };
        if (res.ok && body.principal) {
          setPrincipal(body.principal);
          setMode("live");
          localStorage.setItem("pfm.mode", "live");
          return { outcome: "ok" };
        }
        if (body.code === "TOTP_REQUIRED") return { outcome: "totp-required" };
        return {
          outcome: "error",
          message: body.message ?? `Login failed (${res.status})`,
        };
      },
      enterDemo() {
        setPrincipal(demoPrincipal as Principal);
        setMode("demo");
        localStorage.setItem("pfm.mode", "demo");
      },
      async logout() {
        if (mode === "live") {
          await fetch(`${BASE}/auth/logout`, {
            method: "POST",
            credentials: "include",
          }).catch(() => undefined);
        }
        setPrincipal(null);
        setMode(null);
        localStorage.removeItem("pfm.mode");
      },
      setActiveTenant: setTenantId,
      async api<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(`${BASE}${path}`, {
          credentials: "include",
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(activeTenant ? { "X-Tenant-Id": String(activeTenant.tenantId) } : {}),
            ...(init?.headers ?? {}),
          },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? `Request failed (${res.status})`);
        }
        return res.json() as Promise<T>;
      },
    }),
    [mode, principal, activeTenant],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
