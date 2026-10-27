/** Explicit opt-in only. No app keyring or application state is read. */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const help =
  "Usage: npm run test:ai:live -- --config <local.json> [--output <report.json>] [--run]\nLive requests require BOTH --run and RELAY_AI_LIVE=1. Default: offline plan only.";
const values = {};
let run = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log(help);
    process.exit(0);
  }
  if (args[i] === "--run") {
    run = true;
    continue;
  }
  if (
    !["--config", "--output"].includes(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  ) {
    console.error(help);
    process.exit(2);
  }
  values[args[i]] = args[++i];
}
if (!values["--config"]) {
  console.error(help);
  process.exit(2);
}
const output = path.resolve(
  values["--output"] ??
    path.join(root, "test-results/ai-conformance/report.json"),
);
let temporary;
const controller = new AbortController(),
  onInterrupt = () => controller.abort();
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);
try {
  const configFile = await readFile(values["--config"]);
  if (configFile.length > 128 * 1024) throw new Error("invalid-config");
  const input = JSON.parse(configFile.toString("utf8"));
  const cache = path.join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  temporary = await mkdtemp(path.join(cache, "relay-ai-conformance-"));
  const bundled = path.join(temporary, "harness.cjs");
  await build({
    entryPoints: [path.join(root, "src/verification/ai-conformance.ts")],
    outfile: bundled,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["sharp"],
    logLevel: "silent",
  });
  globalThis.AI_SDK_LOG_WARNINGS = false;
  const { runAIConformance } = createRequire(import.meta.url)(bundled);
  const report = await runAIConformance(input, {
    enabled: run && process.env.RELAY_AI_LIVE === "1",
    env: process.env,
    signal: controller.signal,
  });
  const require = createRequire(import.meta.url);
  const version = (name) =>
    JSON.parse(
      require("node:fs").readFileSync(
        require.resolve(`${name}/package.json`),
        "utf8",
      ),
    ).version;
  let commit = "unavailable",
    sourceDirty = true;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    sourceDirty = Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {}
  report.environment = {
    node: process.versions.node,
    platform: process.platform,
    osRelease: release(),
    architecture: arch(),
    aiSDK: version("ai"),
    sharp: require("sharp").versions.sharp,
    commit,
    sourceDirty,
    adapterSha256: createHash("sha256")
      .update(await readFile(bundled))
      .digest("hex"),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      live: report.live,
      requests: report.requests,
      report: output,
    }),
  );
  if (report.status === "fail") process.exitCode = 1;
  else if (report.status === "incomplete" && report.live) process.exitCode = 2;
} catch {
  // Do not print config values, environment, SDK errors, prompts or response bodies.
  console.error(
    "AI conformance could not run. Check the config schema, explicit model/runtime identifiers, file paths and installed dependencies. No raw error data is printed.",
  );
  process.exitCode = 2;
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
