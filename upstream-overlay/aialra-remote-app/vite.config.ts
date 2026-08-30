import { defineConfig } from "vite";
import opencodeAppPlugins from "@opencode-ai/app/vite";

export default defineConfig({
  plugins: opencodeAppPlugins as never,
  publicDir: "../app/public",
  build: {
    target: "esnext",
    sourcemap: false,
  },
});
