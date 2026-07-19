import { Link } from "react-router-dom";
import { Card, FundStageBar, Money, PageHeader, StatCard } from "../components/ui";
import { demoDashboard, demoFunds } from "../lib/demo-data";
import { usePrefs } from "../lib/prefs";

/** S1 — live wiring to the reports API arrives in B9; demo data until then. */
export function DashboardPage() {
  const { t } = usePrefs();
  const d = demoDashboard;
  const total = (
    Number(d.cash.cashInHand) +
    Number(d.cash.bank) +
    Number(d.cash.bkash) +
    Number(d.cash.courierWaiting) +
    Number(d.cash.courierPending)
  ).toFixed(2);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader titleKey="cashPosition">
        <Link
          to="/funds"
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            d.openExceptions > 0
              ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-200"
              : "bg-brand-100 text-brand-700"
          }`}
        >
          {d.openExceptions > 0
            ? `${t("exceptions")}: ${t("openItems", { n: d.openExceptions })}`
            : t("allClear")}
        </Link>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard labelKey="cashInHand" amount={d.cash.cashInHand} />
        <StatCard labelKey="bank" amount={d.cash.bank} />
        <StatCard labelKey="bkash" amount={d.cash.bkash} />
        <StatCard labelKey="courierWaiting" amount={d.cash.courierWaiting} tone="pending" />
        <StatCard labelKey="courierPending" amount={d.cash.courierPending} tone="pending" />
        <StatCard labelKey="totalLiquid" amount={total} tone="in" />
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
          {t("fundPipeline")}
        </h2>
        <FundStageBar
          waiting={d.cash.courierWaiting}
          pending={d.cash.courierPending}
          settled={demoFunds.settledThisMonth}
        />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
            {t("today")}
          </h2>
          <dl className="space-y-2 text-sm">
            <Row label={t("revenue")}>
              <Money amount={d.today.revenue} tone="in" />
            </Row>
            <Row label={t("cogs")}>
              <Money amount={`-${d.today.cogs}`} />
            </Row>
            <Row label={t("adSpend")}>
              <Money amount={`-${d.today.adSpend}`} />
            </Row>
            <Row label={t("ordersDelivered")}>
              <span className="tnum font-semibold">{d.today.ordersDelivered}</span>
            </Row>
            <div className="border-t border-gray-200 pt-2 dark:border-brand-800">
              <Row label={t("netProfit")}>
                <Money amount={d.today.netProfit} tone="in" className="font-bold" />
              </Row>
            </div>
          </dl>
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
            {t("thisWeek")}
          </h2>
          <dl className="space-y-2 text-sm">
            <Row label={t("revenue")}>
              <Money amount={d.week.revenue} tone="in" />
            </Row>
            <Row label={t("cogs")}>
              <Money amount={`-${d.week.cogs}`} />
            </Row>
            <Row label={t("grossMargin")}>
              <span className="tnum font-semibold">{d.week.grossMarginPct}%</span>
            </Row>
          </dl>
          <p className="mt-4 text-xs text-gray-400">
            {t("comingSoon")}: charts (B9)
          </p>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-600 dark:text-gray-300">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
