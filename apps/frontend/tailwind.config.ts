import baseConfig from "@atlas/config/tailwind";
import type { Config } from "tailwindcss";

const config = {
  ...baseConfig,
  content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"]
} satisfies Config;

export default config;
