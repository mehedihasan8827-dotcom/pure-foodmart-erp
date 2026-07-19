import { Card, Money, PageHeader } from "../components/ui";
import { demoInventory } from "../lib/demo-data";
import { usePrefs } from "../lib/prefs";

/** S6 — on-hand stock, valuation, days of cover. */
export function InventoryPage() {
  const { t } = usePrefs();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader titleKey="navInventory" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {demoInventory.map((i) => (
          <Card key={i.sku} className={i.low ? "border-amber-400" : ""}>
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold">{i.name}</p>
                <p className="font-mono text-xs text-gray-500">{i.sku}</p>
              </div>
              {i.low && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">
                  {t("lowStock")}
                </span>
              )}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-gray-500">{t("onHand")}</dt>
              <dd className="tnum text-right font-medium">
                {i.onHand} {i.uom}
              </dd>
              <dt className="text-gray-500">{t("avgCost")}</dt>
              <dd className="text-right">
                <Money amount={i.avgCost} />
              </dd>
              <dt className="text-gray-500">{t("value")}</dt>
              <dd className="text-right font-medium">
                <Money amount={i.value} />
              </dd>
              <dt className="text-gray-500">{t("daysCover")}</dt>
              <dd className={`tnum text-right ${i.low ? "font-semibold text-amber-600" : ""}`}>
                {i.daysCover} {t("days")}
              </dd>
            </dl>
          </Card>
        ))}
      </div>
    </div>
  );
}
