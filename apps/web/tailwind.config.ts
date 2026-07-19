import type { Config } from "tailwindcss";

/**
 * "Pure Ledger" theme (blueprint §17.2).
 * Semantic money colors: in = green, out = red, stuck/pending = amber,
 * equity = purple. Never encode meaning with color alone — pair with
 * labels/icons (§17.6).
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#effaf3",
          100: "#d8f3e1",
          200: "#b2e6c6",
          300: "#7ed3a3",
          400: "#48b97c",
          500: "#1f7a4d",
          600: "#176240",
          700: "#124e34",
          800: "#0e3e2a",
          900: "#0a2e1f",
          950: "#051a11",
        },
        jaggery: {
          100: "#fdf0dc",
          300: "#f0c98a",
          400: "#e0a958",
          500: "#c98a3b",
          600: "#a86e2a",
        },
        moneyin: "#16a34a",
        moneyout: "#dc2626",
        pending: "#d97706",
        equity: "#7c3aed",
      },
      fontFamily: {
        sans: [
          "Inter",
          "Noto Sans Bengali",
          "Hind Siliguri",
          "system-ui",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
