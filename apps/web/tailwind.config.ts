import type { Config } from "tailwindcss";

/**
 * "Pure Ledger" theme foundations (blueprint §17.2).
 * Semantic money colors: green = in, red = out, amber = stuck/pending,
 * purple = equity. Full token set lands with the design system in B8.
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
          500: "#1f7a4d",
          600: "#175f3c",
          700: "#124b30",
          900: "#0a2e1e",
        },
        jaggery: {
          100: "#fdf0dc",
          400: "#e0a958",
          500: "#c98a3b",
        },
      },
      fontFamily: {
        sans: ["Inter", "Noto Sans Bengali", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
