import { build } from "esbuild";
await build({
  entryPoints: {
    index: "src/main/index.ts",
    preload: "src/main/preload.ts",
    runner: "src/main/runner.ts",
  },
  outdir: "dist/main",
  bundle: true,
  platform: "node",
  target: "node24",
  define: { "import.meta.url": "__filename" },
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "playwright", "sharp", "@techstark/opencv-js"],
  sourcemap: true,
});
