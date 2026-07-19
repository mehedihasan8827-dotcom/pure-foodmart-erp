import { Card, FundStageBar, Money, PageHeader, StatusChip } from "../components/ui";
import { useFunds } from "../lib/data";
import { usePrefs } from "../lib/prefs";

/** S4 — the three-stage courier fund board, served from the ledger (§6.1). */
export function CourierFundsPage() {
  const { t } = usePrefs();
  const { data: f, error, live } = useFunds();

  if (error) {
    return (
      <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
        {error}
      </p>
    );
  }
  if (!f) return <p className="text-sm text-gray-500">{t("loading")}</p>;

  const maxAging = Math.max(...f.aging.map((x) => Number(x.amount)), 1);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader titleKey="navCourierFunds">
        {live && (
          <span className="flex items-center gap-1.5 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-800 dark:text-brand-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-moneyin" />
            {t("liveDot")}
          </span>
        )}
      </PageHeader>
      <FundStageBar
        waiting={f.ledger.waiting1110}
        pending={f.ledger.pending1115}
        settled={f.settledThisMonth}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
            1. {t("stageWaiting")} · 1110
          </h2>
          <ul className="divide-y divide-gray-100 text-sm dark:divide-brand-800">
            {f.waiting.map((o) => (
              <li key={o.orderRef} className="flex items-center justify-between py-2">
                <div>
                  <p className="font-medium">{o.orderRef}</p>
                  <p className="text-xs text-gray-500">
                    {o.consignmentId ?? "—"} · {o.ageDays} {t("days")}
                  </p>
                </div>
                <Money amount={o.cod} tone="pending" />
              </li>
            ))}
            {f.waiting.length === 0 && (
              <li className="py-2 text-xs text-gray-400">{t("allClear")}</li>
            )}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
              2. {t("stagePending")} · 1115
            </h2>
            <ul className="divide-y divide-gray-100 text-sm dark:divide-brand-800">
              {f.pending.map((inv) => (
                <li key={inv.invoiceRef} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium">{inv.invoiceRef}</p>
                    <p className="text-xs text-gray-500">
                      {inv.orders} orders · {inv.statementDate}
                    </p>
                  </div>
                  <Money amount={inv.gross} tone="pending" />
                </li>
              ))}
              {f.pending.length === 0 && (
                <li className="py-2 text-xs text-gray-400">{t("allClear")}</li>
              )}
            </ul>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
              {t("agingTitle")}
            </h2>
            <div className="space-y-1.5">
              {f.aging.map((b) => (
                <div key={b.bucket} className="flex items-center gap-2 text-xs">
                  <span className="w-12 text-gray-500">{b.bucket}</span>
                  <div className="h-3 flex-1 rounded bg-gray-100 dark:bg-brand-800">
                    <div
                      className="h-3 rounded bg-jaggery-400"
                      style={{ width: `${(Number(b.amount) / maxAging) * 100}%` }}
                    />
                  </div>
                  <Money amount={b.amount} className="w-24 text-right" />
                </div>
              ))}
            </div>
          </Card>

          <Card className={f.ledger.matchesOrders ? "border-brand-300" : "border-red-400"}>
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400">
              {t("balanceCheck")}
            </h2>
            <p className="mt-1 flex items-center gap-2 text-sm">
              <StatusChip state={f.ledger.matchesOrders ? "settled" : "exception"} />
              <span>{t("balanceMatches")}</span>
              <Money amount={f.ledger.waiting1110} className="ml-auto font-semibold" />
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
