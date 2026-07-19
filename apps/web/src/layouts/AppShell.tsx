import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { DemoBanner } from "../components/ui";
import { useAuth } from "../lib/auth";
import type { MessageKey } from "../lib/i18n/en";
import { usePrefs } from "../lib/prefs";

interface NavItem {
  to: string;
  labelKey: MessageKey;
  icon: string; // simple glyphs — icon set arrives with B9 polish
}

const MAIN_NAV: NavItem[] = [
  { to: "/", labelKey: "navDashboard", icon: "◫" },
  { to: "/orders", labelKey: "navOrders", icon: "⬡" },
  { to: "/funds", labelKey: "navCourierFunds", icon: "৳" },
  { to: "/inventory", labelKey: "navInventory", icon: "▤" },
  { to: "/expenses", labelKey: "navExpenses", icon: "✎" },
  { to: "/more", labelKey: "navMore", icon: "⋯" },
];

const MOBILE_NAV: NavItem[] = [
  { to: "/", labelKey: "navHome", icon: "◫" },
  { to: "/funds", labelKey: "navFunds", icon: "৳" },
  { to: "/expenses", labelKey: "navAdd", icon: "＋" },
  { to: "/inventory", labelKey: "navStock", icon: "▤" },
  { to: "/more", labelKey: "navMore", icon: "⋯" },
];

export function AppShell() {
  const { t, lang, setLang, dark, setDark } = usePrefs();
  const { mode, activeTenant, principal, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col">
      {mode === "demo" && <DemoBanner />}
      <div className="flex flex-1">
        {/* Desktop sidebar (§17.3) */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-gray-200 bg-white dark:border-brand-800 dark:bg-brand-900 md:flex">
          <div className="border-b border-gray-200 p-4 dark:border-brand-800">
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-500 dark:text-brand-300">
              Pure Foodmart
            </p>
            <p className="text-lg font-bold">{t("appName")}</p>
          </div>
          <nav className="flex-1 space-y-1 p-3">
            {MAIN_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                    isActive
                      ? "bg-brand-500 text-white"
                      : "text-gray-600 hover:bg-brand-50 dark:text-gray-300 dark:hover:bg-brand-800"
                  }`
                }
              >
                <span aria-hidden>{item.icon}</span>
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-gray-200 p-3 text-xs text-gray-400 dark:border-brand-800">
            {t("tagline")}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2 dark:border-brand-800 dark:bg-brand-900">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {activeTenant?.tenantName ?? t("appName")}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {principal?.fullName} · {activeTenant?.role}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setLang(lang === "en" ? "bn" : "en")}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs font-semibold dark:border-brand-700"
                title={t("language")}
              >
                {lang === "en" ? "বাংলা" : "EN"}
              </button>
              <button
                onClick={() => setDark(!dark)}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs dark:border-brand-700"
                title={t("darkMode")}
              >
                {dark ? "☀" : "☾"}
              </button>
              <button
                onClick={() => void logout().then(() => navigate("/login"))}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs dark:border-brand-700"
              >
                {t("logout")}
              </button>
            </div>
          </header>

          <main className="flex-1 p-4 pb-20 md:pb-4">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Mobile bottom tabs (§17.3) */}
      <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-5 border-t border-gray-200 bg-white dark:border-brand-800 dark:bg-brand-900 md:hidden">
        {MOBILE_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex flex-col items-center py-2 text-[11px] ${
                isActive
                  ? "font-semibold text-brand-500 dark:text-brand-300"
                  : "text-gray-500 dark:text-gray-400"
              }`
            }
          >
            <span className="text-base leading-5" aria-hidden>
              {item.icon}
            </span>
            {t(item.labelKey)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
