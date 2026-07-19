/**
 * Demo mode dataset (blueprint §18.1) — shaped EXACTLY like the live
 * reporting API (@pfm/reports types), so pages cannot tell the modes
 * apart. Amounts are decimal strings, as the real API serves them.
 */

export const demoPrincipal = {
  userId: 0,
  email: "demo@purefoodmart.example",
  fullName: "Demo Owner",
  isSuperAdmin: false,
  totpEnabled: true,
  memberships: [
    {
      tenantId: 0,
      tenantName: "Pure Foodmart (Demo)",
      tenantStatus: "ACTIVE",
      role: "TENANT_ADMIN" as const,
    },
  ],
};

export interface DashboardData {
  asOf: string;
  cash: {
    cashInHand: string;
    bank: string;
    bkash: string;
    nagad: string;
    courierWaiting: string;
    courierPending: string;
    totalLiquid: string;
  };
  today: PlAggregate;
  thisWeek: PlAggregate;
  openExceptions: number;
}

export interface PlAggregate {
  revenue: string;
  cogs: string;
  opex: string;
  netProfit: string;
  ordersDelivered: number;
}

export interface DailyPl {
  date: string;
  revenue: string;
  cogs: string;
  opex: string;
  net: string;
}

export interface FundsData {
  waiting: { orderRef: string; consignmentId: string | null; cod: string; ageDays: number }[];
  pending: { invoiceRef: string; statementDate: string; orders: number; gross: string }[];
  settledThisMonth: string;
  aging: { bucket: string; amount: string }[];
  ledger: { waiting1110: string; pending1115: string; matchesOrders: boolean };
}

export const demoDashboard: DashboardData = {
  asOf: new Date().toISOString(),
  cash: {
    cashInHand: "12500.00",
    bank: "184200.00",
    bkash: "21350.00",
    nagad: "0.00",
    courierWaiting: "46000.00",
    courierPending: "23000.00",
    totalLiquid: "287050.00",
  },
  today: {
    revenue: "18400.00", cogs: "9870.00", opex: "3390.00",
    netProfit: "5140.00", ordersDelivered: 16,
  },
  thisWeek: {
    revenue: "112300.00", cogs: "60140.00", opex: "21400.00",
    netProfit: "30760.00", ordersDelivered: 97,
  },
  openExceptions: 2,
};

/** 14 plausible days ending today (weekend dips, one ad-heavy day). */
export const demoDailySeries: DailyPl[] = (() => {
  const rev = [14100, 15900, 12400, 9800, 16600, 18900, 17300, 13800, 11200, 15400, 19800, 16100, 14900, 18400];
  const out: DailyPl[] = [];
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(Date.now() - (13 - i) * 86_400_000);
    const revenue = rev[i]!;
    const cogs = Math.round(revenue * 0.53);
    const opex = i === 10 ? 5200 : 2600 + (i % 3) * 420;
    out.push({
      date: d.toISOString().slice(0, 10),
      revenue: revenue.toFixed(2),
      cogs: cogs.toFixed(2),
      opex: opex.toFixed(2),
      net: (revenue - cogs - opex).toFixed(2),
    });
  }
  return out;
})();

export const demoFunds: FundsData = {
  waiting: [
    { orderRef: "NP-10241", consignmentId: "SF-88291", cod: "1150.00", ageDays: 2 },
    { orderRef: "NP-10238", consignmentId: "SF-88266", cod: "2300.00", ageDays: 4 },
    { orderRef: "NP-10232", consignmentId: "SF-88214", cod: "560.00", ageDays: 6 },
    { orderRef: "NP-10228", consignmentId: "SF-88190", cod: "3450.00", ageDays: 9 },
  ],
  pending: [
    { invoiceRef: "INV-88231", statementDate: "2026-07-20", orders: 14, gross: "16100.00" },
    { invoiceRef: "INV-88198", statementDate: "2026-07-21", orders: 6, gross: "6900.00" },
  ],
  settledThisMonth: "94300.00",
  aging: [
    { bucket: "0–7", amount: "31050.00" },
    { bucket: "8–14", amount: "11500.00" },
    { bucket: "15–30", amount: "3450.00" },
    { bucket: ">30", amount: "0.00" },
  ],
  ledger: { waiting1110: "46000.00", pending1115: "23000.00", matchesOrders: true },
};

export const demoOrders = [
  { orderRef: "NP-10241", state: "posted", payment: "COD", amount: "1150.00", date: "2026-07-19" },
  { orderRef: "NP-10240", state: "paymentPending", payment: "COD", amount: "2300.00", date: "2026-07-19" },
  { orderRef: "NP-10239", state: "settled", payment: "COD", amount: "1150.00", date: "2026-07-18" },
  { orderRef: "NP-10238", state: "posted", payment: "bKash", amount: "560.00", date: "2026-07-18" },
  { orderRef: "NP-10237", state: "needsBom", payment: "COD", amount: "1710.00", date: "2026-07-18" },
  { orderRef: "NP-10236", state: "returned", payment: "COD", amount: "1150.00", date: "2026-07-17" },
  { orderRef: "NP-10235", state: "synced", payment: "COD", amount: "3450.00", date: "2026-07-17" },
  { orderRef: "NP-10234", state: "settled", payment: "COD", amount: "1150.00", date: "2026-07-16" },
];

export const demoInventory = [
  { sku: "RAW-JAG", name: "Raw Jaggery", onHand: "168.500", uom: "KG", avgCost: "118.40", value: "19951.40", daysCover: 11, low: false },
  { sku: "RAW-AAM", name: "Aamsotto", onHand: "6.250", uom: "KG", avgCost: "302.00", value: "1887.50", daysCover: 4, low: true },
  { sku: "CTN-5KG", name: "Carton 5KG", onHand: "412.000", uom: "PCS", avgCost: "22.00", value: "9064.00", daysCover: 26, low: false },
  { sku: "CTN-2KG", name: "Carton 2KG", onHand: "58.000", uom: "PCS", avgCost: "15.00", value: "870.00", daysCover: 6, low: true },
  { sku: "CTN-1KG", name: "Carton 1KG", onHand: "91.000", uom: "PCS", avgCost: "10.00", value: "910.00", daysCover: 13, low: false },
];

export interface DemoExpense {
  id: number;
  date: string;
  categoryKey: "electricity" | "labor" | "marketing" | "courierCharges" | "officeMisc";
  amount: string;
  paidFrom: string;
  description: string;
}

export const demoExpenses: DemoExpense[] = [
  { id: 3, date: "2026-07-19", categoryKey: "marketing", amount: "2500.00", paidFrom: "bKash", description: "Boosting — jaggery campaign" },
  { id: 2, date: "2026-07-18", categoryKey: "electricity", amount: "1800.00", paidFrom: "Cash", description: "July bill" },
  { id: 1, date: "2026-07-18", categoryKey: "labor", amount: "3200.00", paidFrom: "Cash", description: "Packing day-labor" },
];
