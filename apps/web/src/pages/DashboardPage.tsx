import { Link } from "react-router-dom";
import { RevenueNetChart } from "../components/charts";
import { Card, FundStageBar, Money, PageHeader, StatCard } from "../components/ui";
import { useDailySeries, useDashboard, useFunds } from "../lib/data";
import { usePrefs } from "../lib/prefs";

/** S1 — served from the real ledger in live mode, refreshed by SSE. */
export function DashboardPage() {
  const { t } = usePrefs();
  const { data: d, error, live } = useDashboard();
  const { data: series } = useDailySeries();
  const { data: funds } = useFunds();

  if (error) {
    return (
      <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
        {error}
      </p>
    );
  }
  if (!d) return <p className="text-sm text-gray-500">{t("loading")}</p>;

  const marginPct =
    Number(d.thisWeek.revenue) > 0
      ? (
          ((Number(d.thisWeek.revenue) - Number(d.thisWeek.cogs)) /
            Number(d.thisWeek.revenue)) *
          100
        ).toFixed(1)
      : "0.0";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader titleKey="cashPosition">
        <div className="flex items-center gap-2">
          {live && (
            <span className="flex items-center gap-1.5 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-800 dark:text-brand-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-moneyin" />
              {t("liveDot")}
            </span>
          )}
          <Link
            to="/funds"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              d.openExceptions > 0
                ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-200"
                : "bg-brand-100 text-brand-700 dark:bg-brand-800 dark:text-brand-200"
            }`}
          >
            {d.openExceptions > 0
              ? `${t("exceptions")}: ${t("openItems", { n: d.openExceptions })}`
              : t("allClear")}
          </Link>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard labelKey="cashInHand" amount={d.cash.cashInHand} />
        <StatCard labelKey="bank" amount={d.cash.bank} />
        <StatCard labelKey="bkash" amount={d.cash.bkash} />
        <StatCard labelKey="courierWaiting" amount={d.cash.courierWaiting} tone="pending" />
        <StatCard labelKey="courierPending" amount={d.cash.courierPending} tone="pending" />
        <StatCard labelKey="totalLiquid" amount={d.cash.totalLiquid} tone="in" />
      </div>

      {series && series.length > 0 && (
        <Card>
          <RevenueNetChart series={series} />
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400">
          {t("fundPipeline")}
        </h2>
        <FundStageBar
          waiting={d.cash.courierWaiting}
          pending={d.cash.courierPending}
          settled={funds?.settledThisMonth ?? "0.00"}
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
              <Money amount={negate(d.today.cogs)} />
            </Row>
            <Row label={t("opexLabel")}>
              <Money amount={negate(d.today.opex)} />
            </Row>
            <Row label={t("ordersDelivered")}>
              <span className="tnum font-semibold">{d.today.ordersDelivered}</span>
            </Row>
            <div className="border-t border-gray-200 pt-2 dark:border-brand-800">
              <Row label={t("netProfit")}>
                <Money
                  amount={d.today.netProfit}
                  tone={d.today.netProfit.startsWith("-") ? "out" : "in"}
                  className="font-bold"
                />
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
              <Money amount={d.thisWeek.revenue} tone="in" />
            </Row>
            <Row label={t("cogs")}>
              <Money amount={negate(d.thisWeek.cogs)} />
            </Row>
            <Row label={t("opexLabel")}>
              <Money amount={negate(d.thisWeek.opex)} />
            </Row>
            <Row label={t("grossMargin")}>
              <span className="tnum font-semibold">{marginPct}%</span>
            </Row>
            <div className="border-t border-gray-200 pt-2 dark:border-brand-800">
              <Row label={t("netProfit")}>
                <Money
                  amount={d.thisWeek.netProfit}
                  tone={d.thisWeek.netProfit.startsWith("-") ? "out" : "in"}
                  className="font-bold"
                />
              </Row>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function negate(v: string): string {
  if (v === "0.00" || v === "0") return v;
  return v.startsWith("-") ? v.slice(1) : `-${v}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-600 dark:text-gray-300">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
