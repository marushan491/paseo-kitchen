import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "react-native": fileURLToPath(
        new URL("./node_modules/react-native-web/dist/index.js", import.meta.url),
      ),
    },
  },
  test: { include: ["server/**/*.test.ts", "client/**/*.test.ts", "shared/**/*.test.ts"] },
});
