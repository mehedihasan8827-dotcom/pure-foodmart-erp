import type { ReactNode } from "react";
import { formatTaka } from "../lib/money";
import { usePrefs } from "../lib/prefs";
import type { MessageKey } from "../lib/i18n/en";

/** The ONLY way money is rendered (§17.2): ৳, tabular digits, () negatives. */
export function Money({
  amount,
  className = "",
  tone = "neutral",
}: {
  amount: string;
  className?: string;
  tone?: "neutral" | "in" | "out" | "pending";
}) {
  const { grouping } = usePrefs();
  const negative = amount.startsWith("-");
  const toneClass =
    negative || tone === "out"
      ? "text-moneyout"
      : tone === "in"
        ? "text-moneyin"
        : tone === "pending"
          ? "text-pending"
          : "";
  return (
    <span className={`tnum ${toneClass} ${className}`}>
      {formatTaka(amount, grouping)}
    </span>
  );
}

export function StatCard({
  labelKey,
  amount,
  sub,
  tone,
}: {
  labelKey: MessageKey;
  amount?: string;
  sub?: ReactNode;
  tone?: "neutral" | "in" | "out" | "pending";
}) {
  const { t } = usePrefs();
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-brand-800 dark:bg-brand-900">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t(labelKey)}
      </p>
      {amount !== undefined && (
        <p className="mt-1 text-xl font-semibold">
          <Money amount={amount} tone={tone} />
        </p>
      )}
      {sub && <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{sub}</div>}
    </div>
  );
}

const STATE_STYLES: Record<string, { key: MessageKey; cls: string }> = {
  posted: { key: "posted", cls: "bg-brand-100 text-brand-700 dark:bg-brand-800 dark:text-brand-100" },
  paymentPending: { key: "paymentPending", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200" },
  settled: { key: "settled", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200" },
  needsBom: { key: "needsBom", cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200" },
  exception: { key: "exception", cls: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200" },
  synced: { key: "synced", cls: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
  returned: { key: "returned", cls: "bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-200" },
  closed: { key: "closed", cls: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" },
};

export function StatusChip({ state }: { state: string }) {
  const { t } = usePrefs();
  const style = STATE_STYLES[state] ?? STATE_STYLES.synced!;
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${style.cls}`}>
      {t(style.key)}
    </span>
  );
}

/** Visual 1110 → 1115 → bank pipeline (§17.2 FundStageBar). */
export function FundStageBar({
  waiting,
  pending,
  settled,
}: {
  waiting: string;
  pending: string;
  settled: string;
}) {
  const { t } = usePrefs();
  const stages = [
    { key: "stageWaiting" as MessageKey, amount: waiting, cls: "bg-amber-400/80" },
    { key: "stagePending" as MessageKey, amount: pending, cls: "bg-jaggery-400" },
    { key: "stageSettled" as MessageKey, amount: settled, cls: "bg-brand-400" },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {stages.map((s, i) => (
        <div
          key={s.key}
          className="relative rounded-lg border border-gray-200 bg-white p-3 dark:border-brand-800 dark:bg-brand-900"
        >
          <div className={`absolute inset-x-0 top-0 h-1 rounded-t-lg ${s.cls}`} />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {i + 1}. {t(s.key)}
          </p>
          <p className="mt-1 font-semibold">
            <Money amount={s.amount} />
          </p>
        </div>
      ))}
    </div>
  );
}

export function PageHeader({ titleKey, children }: { titleKey: MessageKey; children?: ReactNode }) {
  const { t } = usePrefs();
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-xl font-bold">{t(titleKey)}</h1>
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-brand-800 dark:bg-brand-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function DemoBanner() {
  const { t } = usePrefs();
  return (
    <div className="bg-jaggery-400/90 px-4 py-1 text-center text-xs font-semibold text-brand-950">
      {t("demoBadge")}
    </div>
  );
}
