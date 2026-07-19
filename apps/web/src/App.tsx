import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./layouts/AppShell";
import { useAuth } from "./lib/auth";
import { CourierFundsPage } from "./pages/CourierFundsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { InventoryPage } from "./pages/InventoryPage";
import { LoginPage } from "./pages/LoginPage";
import { MorePage } from "./pages/MorePage";
import { OrdersPage } from "./pages/OrdersPage";

export function App() {
  const { mode } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {mode === null ? (
        <Route path="*" element={<Navigate to="/login" replace />} />
      ) : (
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="funds" element={<CourierFundsPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="more" element={<MorePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}
