import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { bn } from "./i18n/bn";
import { en, type MessageKey } from "./i18n/en";

export type Lang = "en" | "bn";
export type Grouping = "western" | "lakh";

interface Prefs {
  lang: Lang;
  dark: boolean;
  grouping: Grouping;
  setLang: (l: Lang) => void;
  setDark: (d: boolean) => void;
  setGrouping: (g: Grouping) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const PrefsContext = createContext<Prefs | null>(null);

function stored<T extends string>(key: string, fallback: T): T {
  return (localStorage.getItem(key) as T) ?? fallback;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => stored("pfm.lang", "en"));
  const [dark, setDarkState] = useState<boolean>(() => {
    const saved = localStorage.getItem("pfm.dark");
    if (saved !== null) return saved === "1";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [grouping, setGroupingState] = useState<Grouping>(() =>
    stored("pfm.grouping", "lakh"),
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const value = useMemo<Prefs>(() => {
    const catalog = lang === "bn" ? bn : en;
    return {
      lang,
      dark,
      grouping,
      setLang: (l) => {
        localStorage.setItem("pfm.lang", l);
        setLangState(l);
      },
      setDark: (d) => {
        localStorage.setItem("pfm.dark", d ? "1" : "0");
        setDarkState(d);
      },
      setGrouping: (g) => {
        localStorage.setItem("pfm.grouping", g);
        setGroupingState(g);
      },
      t: (key, vars) => {
        let msg: string = catalog[key] ?? en[key] ?? key;
        for (const [k, v] of Object.entries(vars ?? {})) {
          msg = msg.replaceAll(`{${k}}`, String(v));
        }
        return msg;
      },
    };
  }, [lang, dark, grouping]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs outside PrefsProvider");
  return ctx;
}
