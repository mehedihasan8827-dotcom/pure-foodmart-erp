const upcoming = [
  { batch: "B1–B2", label: "Double-entry ledger core" },
  { batch: "B3", label: "BOM inventory & COGS engine" },
  { batch: "B4", label: "Nuport sales pipeline" },
  { batch: "B5", label: "Steadfast courier funds pipeline" },
  { batch: "B8+", label: "Dashboards, portals & reports" },
];

export function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-900 p-6">
      <section className="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-widest text-brand-500">
          Pure Foodmart
        </p>
        <h1 className="mt-1 text-3xl font-bold text-brand-900">
          Financial ERP
        </h1>
        <p className="mt-3 text-sm leading-6 text-gray-600">
          Cloud cash-flow control for the Nuport + Steadfast dual pipeline.
          Scaffold <span className="font-semibold">B0</span> is live — the
          modules below arrive batch by batch.
        </p>
        <ul className="mt-6 space-y-2">
          {upcoming.map((item) => (
            <li
              key={item.batch}
              className="flex items-center justify-between rounded-lg bg-brand-50 px-4 py-2 text-sm"
            >
              <span className="text-brand-900">{item.label}</span>
              <span className="font-mono text-xs font-semibold text-brand-500">
                {item.batch}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-center font-mono text-xs text-gray-400">
          ৳ every poisha accounted for
        </p>
      </section>
    </main>
  );
}
