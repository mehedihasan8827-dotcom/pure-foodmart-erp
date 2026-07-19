import { useMemo, useState } from "react";
import type { DailyPl } from "../lib/demo-data";
import { formatTaka } from "../lib/money";
import { usePrefs } from "../lib/prefs";

/**
 * 14-day revenue (bars) + net profit (line) — one axis, both in BDT.
 * Palette validated with the dataviz six-checks validator:
 *   light surface #ffffff → #1f7a4d / #c98a3b  (contrast WARN on amber →
 *     mandatory relief shipped: direct labels + the table view below)
 *   dark surface #0a2e1f  → #2ea36b / #b8802f  (CVD ΔE 7.4 floor band →
 *     legal with secondary encoding: bar-vs-line marks, legend, labels)
 */
const PALETTE = {
  light: { revenue: "#1f7a4d", net: "#c98a3b", grid: "#e5e7eb", ink: "#6b7280" },
  dark: { revenue: "#2ea36b", net: "#b8802f", grid: "#1c4a36", ink: "#9ca3af" },
};

const W = 640;
const H = 200;
const M = { top: 12, right: 8, bottom: 22, left: 46 };

export function RevenueNetChart({ series }: { series: DailyPl[] }) {
  const { t, dark, grouping } = usePrefs();
  const [hover, setHover] = useState<number | null>(null);
  const c = dark ? PALETTE.dark : PALETTE.light;

  const model = useMemo(() => {
    const revs = series.map((d) => Number(d.revenue));
    const nets = series.map((d) => Number(d.net));
    const yMax = Math.max(...revs, ...nets, 1);
    const yMin = Math.min(0, ...nets);
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;
    const slot = plotW / series.length;
    const barW = Math.max(4, slot - 4); // ≥2px gap each side
    const y = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    const x = (i: number) => M.left + i * slot + slot / 2;
    const peak = revs.indexOf(Math.max(...revs));
    return { revs, nets, yMax, yMin, slot, barW, y, x, plotH, peak };
  }, [series]);

  if (series.length === 0) return null;
  const { revs, nets, yMax, yMin, slot, barW, y, x, peak } = model;
  const ticks = [yMax, (yMax + yMin) / 2, yMin === 0 ? 0 : yMin];
  const linePath = nets
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const short = (v: number) =>
    Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(Math.round(v));

  return (
    <div>
      {/* legend — 2 series, always present */}
      <div className="mb-2 flex items-center gap-4 text-xs text-gray-600 dark:text-gray-300">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c.revenue }} />
          {t("revenue")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: c.net }} />
          {t("netProfitShort")}
        </span>
        <span className="ml-auto text-gray-400">{t("last14days")}</span>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t("last14days")}>
          {/* recessive grid + axis labels */}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke={c.grid} strokeWidth={1} />
              <text x={M.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill={c.ink} className="tnum">
                {short(v)}
              </text>
            </g>
          ))}
          {/* revenue bars: rounded data-end at the top, anchored to baseline */}
          {revs.map((v, i) => {
            const top = y(v);
            const base = y(Math.max(0, yMin));
            const h = Math.max(1, base - top);
            const bx = x(i) - barW / 2;
            const r = Math.min(4, barW / 2, h);
            return (
              <path
                key={i}
                d={`M${bx},${base} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + barW - r} Q${bx + barW},${top} ${bx + barW},${top + r} V${base} Z`}
                fill={c.revenue}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
            );
          })}
          {/* net profit line, 2px */}
          <path d={linePath} fill="none" stroke={c.net} strokeWidth={2} strokeLinejoin="round" />
          {nets.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4 : 2.5} fill={c.net} />
          ))}
          {/* selective direct labels: peak revenue + last net */}
          <text x={x(peak)} y={y(revs[peak]!) - 5} textAnchor="middle" fontSize={10} className="tnum" fill={c.ink}>
            {short(revs[peak]!)}
          </text>
          <text x={x(nets.length - 1) + 2} y={y(nets[nets.length - 1]!) - 7} textAnchor="end" fontSize={10} className="tnum" fill={c.ink}>
            {short(nets[nets.length - 1]!)}
          </text>
          {/* hover targets: full-height, wider than the mark */}
          {series.map((_, i) => (
            <rect
              key={i}
              x={M.left + i * slot}
              y={M.top}
              width={slot}
              height={H - M.top - M.bottom}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
          {/* x labels: first / middle / last */}
          {[0, Math.floor(series.length / 2), series.length - 1].map((i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill={c.ink}>
              {series[i]!.date.slice(5)}
            </text>
          ))}
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-brand-700 dark:bg-brand-950"
            style={{
              left: `${Math.min(78, Math.max(2, (x(hover) / W) * 100))}%`,
              transform: "translateX(-50%)",
            }}
          >
            <p className="font-semibold">{series[hover]!.date}</p>
            <p>
              {t("revenue")}:{" "}
              <span className="tnum">{formatTaka(series[hover]!.revenue, grouping)}</span>
            </p>
            <p>
              {t("cogs")}: <span className="tnum">{formatTaka(series[hover]!.cogs, grouping)}</span>
            </p>
            <p>
              {t("opexLabel")}:{" "}
              <span className="tnum">{formatTaka(series[hover]!.opex, grouping)}</span>
            </p>
            <p className="font-semibold">
              {t("netProfitShort")}:{" "}
              <span className="tnum">{formatTaka(series[hover]!.net, grouping)}</span>
            </p>
          </div>
        )}
      </div>

      {/* table view — mandated relief for the sub-3:1 contrast WARN */}
      <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        <summary className="cursor-pointer select-none">{t("tableView")}</summary>
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className="pr-3 font-medium">{t("dateLabel")}</th>
                <th className="pr-3 font-medium">{t("revenue")}</th>
                <th className="pr-3 font-medium">{t("cogs")}</th>
                <th className="pr-3 font-medium">{t("opexLabel")}</th>
                <th className="font-medium">{t("netProfitShort")}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((d) => (
                <tr key={d.date}>
                  <td className="pr-3">{d.date}</td>
                  <td className="tnum pr-3">{formatTaka(d.revenue, grouping)}</td>
                  <td className="tnum pr-3">{formatTaka(d.cogs, grouping)}</td>
                  <td className="tnum pr-3">{formatTaka(d.opex, grouping)}</td>
                  <td className="tnum">{formatTaka(d.net, grouping)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
