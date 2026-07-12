import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component/unit tests run under jsdom via Vitest (the Vite-native runner, so it
// shares the app's exact module resolution — including the `.ts`/`.tsx` import
// extensions the source uses). Kept separate from vite.config.ts so the dev-server
// proxy config stays out of the test run.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    clearMocks: true,
  },
});
