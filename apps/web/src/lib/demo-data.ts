/**
 * Demo mode dataset (blueprint §18.1): realistic Pure Foodmart numbers so
 * every screen is fully clickable before any live API is connected.
 * Amounts are decimal strings, exactly as the real API serves them.
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

export const demoDashboard = {
  cash: {
    cashInHand: "12500.00",
    bank: "184200.00",
    bkash: "21350.00",
    courierWaiting: "46000.00",
    courierPending: "23000.00",
  },
  today: {
    revenue: "18400.00",
    cogs: "9870.00",
    ordersDelivered: 16,
    adSpend: "2500.00",
    netProfit: "5140.00",
  },
  week: {
    revenue: "112300.00",
    cogs: "60140.00",
    grossMarginPct: "46.4",
  },
  openExceptions: 2,
};

export const demoFunds = {
  waiting: [
    { orderRef: "NP-10241", consignmentId: "SF-88291", cod: "1150.00", ageDays: 2 },
    { orderRef: "NP-10238", consignmentId: "SF-88266", cod: "2300.00", ageDays: 4 },
    { orderRef: "NP-10232", consignmentId: "SF-88214", cod: "560.00", ageDays: 6 },
    { orderRef: "NP-10228", consignmentId: "SF-88190", cod: "3450.00", ageDays: 9 },
  ],
  pending: [
    { invoiceRef: "INV-88231", orders: 14, gross: "16100.00", expected: "2026-07-22" },
    { invoiceRef: "INV-88198", orders: 6, gross: "6900.00", expected: "2026-07-21" },
  ],
  settledThisMonth: "94300.00",
  aging: [
    { bucket: "0–7", amount: "31050.00" },
    { bucket: "8–14", amount: "11500.00" },
    { bucket: "15–30", amount: "3450.00" },
    { bucket: ">30", amount: "0.00" },
  ],
  balanceCheck: { ledger: "69000.00", reported: "69000.00", ok: true },
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
