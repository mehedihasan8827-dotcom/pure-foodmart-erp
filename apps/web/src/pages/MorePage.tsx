import { Card, PageHeader } from "../components/ui";
import type { MessageKey } from "../lib/i18n/en";
import { usePrefs } from "../lib/prefs";

const SECTIONS: { key: MessageKey; batch: string }[] = [
  { key: "partners", batch: "B10" },
  { key: "fixedAssets", batch: "B10" },
  { key: "reports", batch: "B11" },
  { key: "periodClose", batch: "B11" },
];

export function MorePage() {
  const { t, lang, setLang, dark, setDark, grouping, setGrouping } = usePrefs();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader titleKey="navMore" />
      <div className="grid grid-cols-2 gap-3">
        {SECTIONS.map((s) => (
          <Card key={s.key} className="opacity-70">
            <p className="font-semibold">{t(s.key)}</p>
            <p className="mt-1 text-xs text-gray-500">
              {t("comingSoon")} ({s.batch})
            </p>
          </Card>
        ))}
      </div>
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
          {t("settings")}
        </h2>
        <div className="space-y-3 text-sm">
          <SettingRow label={t("language")}>
            <Toggle
              options={[
                { value: "en", label: "English" },
                { value: "bn", label: "বাংলা" },
              ]}
              value={lang}
              onChange={(v) => setLang(v as "en" | "bn")}
            />
          </SettingRow>
          <SettingRow label={t("darkMode")}>
            <Toggle
              options={[
                { value: "0", label: "☀" },
                { value: "1", label: "☾" },
              ]}
              value={dark ? "1" : "0"}
              onChange={(v) => setDark(v === "1")}
            />
          </SettingRow>
          <SettingRow label={t("digitGrouping")}>
            <Toggle
              options={[
                { value: "lakh", label: "১২,৩৪,৫৬৭" },
                { value: "western", label: "1,234,567" },
              ]}
              value={grouping}
              onChange={(v) => setGrouping(v as "lakh" | "western")}
            />
          </SettingRow>
        </div>
      </Card>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg border border-gray-200 p-0.5 dark:border-brand-700">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-xs font-medium ${
            value === o.value
              ? "bg-brand-500 text-white"
              : "text-gray-600 dark:text-gray-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
