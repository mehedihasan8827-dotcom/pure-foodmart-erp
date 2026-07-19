import { Card, FundStageBar, Money, PageHeader, StatusChip } from "../components/ui";
import { demoDashboard, demoFunds } from "../lib/demo-data";
import { usePrefs } from "../lib/prefs";

/** S4 — the three-stage courier fund board (§6.1). */
export function CourierFundsPage() {
  const { t } = usePrefs();
  const f = demoFunds;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader titleKey="navCourierFunds" />
      <FundStageBar
        waiting={demoDashboard.cash.courierWaiting}
        pending={demoDashboard.cash.courierPending}
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
                    {o.consignmentId} · {o.ageDays} {t("days")}
                  </p>
                </div>
                <Money amount={o.cod} tone="pending" />
              </li>
            ))}
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
                      {inv.orders} orders · exp. {inv.expected}
                    </p>
                  </div>
                  <Money amount={inv.gross} tone="pending" />
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
              {t("agingTitle")}
            </h2>
            <div className="space-y-1.5">
              {f.aging.map((b) => {
                const max = Math.max(...f.aging.map((x) => Number(x.amount)), 1);
                const pct = (Number(b.amount) / max) * 100;
                return (
                  <div key={b.bucket} className="flex items-center gap-2 text-xs">
                    <span className="w-12 text-gray-500">{b.bucket}</span>
                    <div className="h-3 flex-1 rounded bg-gray-100 dark:bg-brand-800">
                      <div
                        className="h-3 rounded bg-jaggery-400"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <Money amount={b.amount} className="w-24 text-right" />
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className={f.balanceCheck.ok ? "border-brand-300" : "border-red-400"}>
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400">
              {t("balanceCheck")}
            </h2>
            <p className="mt-1 flex items-center gap-2 text-sm">
              {f.balanceCheck.ok ? (
                <StatusChip state="settled" />
              ) : (
                <StatusChip state="exception" />
              )}
              <span>{t("balanceMatches")}</span>
              <Money amount={f.balanceCheck.ledger} className="ml-auto font-semibold" />
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
