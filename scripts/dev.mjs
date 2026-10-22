import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createServer } from "vite";
import electron from "electron";
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
const server = await createServer();
await server.listen();
const env = { ...process.env, RELAY_DEV_URL: "http://127.0.0.1:5173" };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ["."], { stdio: "inherit", env });
app.once("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.once("SIGINT", () => app.kill("SIGTERM"));
