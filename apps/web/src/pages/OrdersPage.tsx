import { Card, Money, PageHeader, StatusChip } from "../components/ui";
import { demoOrders } from "../lib/demo-data";
import { usePrefs } from "../lib/prefs";

/** S2 — synced orders with financial states. */
export function OrdersPage() {
  const { t } = usePrefs();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader titleKey="navOrders" />
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-brand-800">
              <th className="px-4 py-2.5">{t("orderRef")}</th>
              <th className="px-4 py-2.5">{t("finState")}</th>
              <th className="hidden px-4 py-2.5 sm:table-cell">{t("status")}</th>
              <th className="px-4 py-2.5 text-right">{t("amount")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-brand-800">
            {demoOrders.map((o) => (
              <tr key={o.orderRef} className="hover:bg-gray-50 dark:hover:bg-brand-800/50">
                <td className="px-4 py-2.5">
                  <p className="font-medium">{o.orderRef}</p>
                  <p className="text-xs text-gray-500">{o.date}</p>
                </td>
                <td className="px-4 py-2.5">
                  <StatusChip state={o.state} />
                </td>
                <td className="hidden px-4 py-2.5 text-gray-500 sm:table-cell">{o.payment}</td>
                <td className="px-4 py-2.5 text-right">
                  <Money amount={o.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
