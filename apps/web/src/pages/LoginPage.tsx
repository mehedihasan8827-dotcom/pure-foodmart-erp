import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { usePrefs } from "../lib/prefs";

export function LoginPage() {
  const { t, lang, setLang } = usePrefs();
  const { login, enterDemo } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await login(email, password, needsTotp ? totpCode : undefined);
    setBusy(false);
    if (result.outcome === "ok") navigate("/");
    else if (result.outcome === "totp-required") setNeedsTotp(true);
    else setError(result.message ?? "Login failed");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-950 p-6">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl bg-white p-8 shadow-2xl dark:bg-brand-900">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-brand-500 dark:text-brand-300">
                Pure Foodmart
              </p>
              <h1 className="text-2xl font-bold">{t("appName")}</h1>
            </div>
            <button
              onClick={() => setLang(lang === "en" ? "bn" : "en")}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs font-semibold dark:border-brand-700"
            >
              {lang === "en" ? "বাংলা" : "EN"}
            </button>
          </div>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <label className="block">
              <span className="text-sm font-medium">{t("email")}</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-brand-700 dark:bg-brand-950"
                autoComplete="username"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium">{t("password")}</span>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-brand-700 dark:bg-brand-950"
                autoComplete="current-password"
              />
            </label>
            {needsTotp && (
              <label className="block">
                <span className="text-sm font-medium">{t("totpCode")}</span>
                <input
                  inputMode="numeric"
                  pattern="\d{6}"
                  required
                  autoFocus
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="123456"
                  className="tnum mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-center text-lg tracking-[0.4em] dark:border-brand-700 dark:bg-brand-950"
                />
                <p className="mt-1 text-xs text-gray-500">{t("totpPrompt")}</p>
              </label>
            )}
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-brand-500 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60"
            >
              {busy ? t("signingIn") : t("signIn")}
            </button>
          </form>

          <div className="mt-6 border-t border-gray-200 pt-4 dark:border-brand-800">
            <button
              onClick={() => {
                enterDemo();
                navigate("/");
              }}
              className="w-full rounded-lg border-2 border-jaggery-400 py-2.5 text-sm font-semibold text-jaggery-600 hover:bg-jaggery-100 dark:text-jaggery-300 dark:hover:bg-brand-800"
            >
              {t("exploreDemo")}
            </button>
            <p className="mt-2 text-center text-xs text-gray-500">{t("demoNote")}</p>
          </div>
        </div>
        <p className="mt-4 text-center font-mono text-xs text-brand-300/60">
          ৳ {t("tagline")}
        </p>
      </div>
    </main>
  );
}
