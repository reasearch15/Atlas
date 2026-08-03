import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@atlas/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@atlas/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts")
    }
  }
});
