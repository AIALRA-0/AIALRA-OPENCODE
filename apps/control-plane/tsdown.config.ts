import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  clean: true,
  dts: false,
  format: ["esm"],
  minify: false,
  sourcemap: true,
  target: "node24",
  deps: {
    alwaysBundle: ["@aialra-opencode/protocol"],
  },
  outExtensions: () => ({ js: ".js" }),
});
