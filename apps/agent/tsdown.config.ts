import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  clean: true,
  dts: false,
  sourcemap: false,
  deps: {
    alwaysBundle: ["@aialra-opencode/protocol"],
  },
  outExtensions: () => ({ js: ".js" }),
});
