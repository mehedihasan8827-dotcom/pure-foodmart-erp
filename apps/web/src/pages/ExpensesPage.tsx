import { useState, type FormEvent } from "react";
import { Card, Money, PageHeader } from "../components/ui";
import { useAuth } from "../lib/auth";
import { demoExpenses, type DemoExpense } from "../lib/demo-data";
import type { MessageKey } from "../lib/i18n/en";
import { usePrefs } from "../lib/prefs";

const CATEGORIES: { key: MessageKey; account: string }[] = [
  { key: "marketing", account: "6020" },
  { key: "electricity", account: "6120" },
  { key: "labor", account: "6110" },
  { key: "courierCharges", account: "6010" },
  { key: "officeMisc", account: "6140" },
];

const PAID_FROM = [
  { label: "Cash", account: "1010" },
  { label: "Bank", account: "1020" },
  { label: "bKash", account: "1030" },
];

/**
 * S11 — the ≤3-tap expense flow (§17.5): category chip → amount → save.
 * Demo mode appends locally; live mode posts to /portal/expenses.
 */
export function ExpensesPage() {
  const { t } = usePrefs();
  const { mode, api } = useAuth();
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [paidFrom, setPaidFrom] = useState(PAID_FROM[0]!);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [list, setList] = useState<DemoExpense[]>(demoExpenses);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const today = new Date().toISOString().slice(0, 10);
    const desc = description.trim() || t(category.key);
    if (mode === "live") {
      try {
        await api("/portal/expenses", {
          method: "POST",
          body: JSON.stringify({
            expenseDate: today,
            expenseAccountCode: category.account,
            paidFromAccountCode: paidFrom.account,
            amount,
            description: desc,
          }),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setList((prev) => [
      {
        id: (prev[0]?.id ?? 0) + 1,
        date: today,
        categoryKey: category.key as DemoExpense["categoryKey"],
        amount: Number(amount).toFixed(2),
        paidFrom: paidFrom.label,
        description: desc,
      },
      ...prev,
    ]);
    setAmount("");
    setDescription("");
    setFlash(t("saved"));
    setTimeout(() => setFlash(null), 1500);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader titleKey="quickExpense" />
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">{t("category")}</p>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                    category.key === c.key
                      ? "bg-brand-500 text-white"
                      : "bg-gray-100 text-gray-700 dark:bg-brand-800 dark:text-gray-200"
                  }`}
                >
                  {t(c.key)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-medium">{t("amount")}</span>
              <input
                required
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="tnum mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-lg dark:border-brand-700 dark:bg-brand-950"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium">{t("paidFrom")}</span>
              <select
                value={paidFrom.account}
                onChange={(e) =>
                  setPaidFrom(PAID_FROM.find((p) => p.account === e.target.value)!)
                }
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm dark:border-brand-700 dark:bg-brand-950"
              >
                {PAID_FROM.map((p) => (
                  <option key={p.account} value={p.account}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium">{t("description")}</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-brand-700 dark:bg-brand-950"
            />
          </label>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600"
          >
            {flash ?? t("save")}
          </button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-gray-500 dark:text-gray-400">
          {t("recentExpenses")}
        </h2>
        <ul className="divide-y divide-gray-100 text-sm dark:divide-brand-800">
          {list.map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2">
              <div>
                <p className="font-medium">{t(e.categoryKey)}</p>
                <p className="text-xs text-gray-500">
                  {e.date} · {e.paidFrom} · {e.description}
                </p>
              </div>
              <Money amount={`-${e.amount}`} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
