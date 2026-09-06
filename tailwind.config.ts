import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#20201e",
        paper: "#f7f6f2",
        line: "#deddd6"
      },
      fontFamily: {
        display: ["Georgia", "serif"],
        sans: ["Arial", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
