import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const enabled = process.argv.includes("--run");
const allowUnavailable = process.argv.includes("--allow-unavailable");
const root = path.resolve(
  process.env.RELAY_MACOS_REPORT_DIR ?? "test-results/native-macos",
);
await mkdir(root, { recursive: true });
const results = [];
if (!enabled || process.platform !== "darwin") {
  results.push({
    name: "macos-desktop",
    status: "not-run",
    reason: !enabled
      ? "Use --run to enable synthetic fixture capture/input"
      : "macOS is required",
  });
} else {
  const cases = [
    ["electron-1", ["--fixture=electron", "--renderer-scale=1"]],
    ["electron-1.5", ["--fixture=electron", "--renderer-scale=1.5"]],
    ["appkit-1", ["--fixture=appkit", "--content-scale=1"]],
    ["appkit-1.5", ["--fixture=appkit", "--content-scale=1.5"]],
  ];
  for (const [name, flags] of cases) {
    const directory = path.join(root, name);
    const child = spawn(
      process.execPath,
      [
        "scripts/native-harness.mjs",
        "--run",
        "--software-gpu",
        "--window-x=0",
        "--window-y=60",
        "--session-label=macos-matrix",
        ...(allowUnavailable ? ["--allow-unavailable"] : []),
        ...flags,
      ],
      {
        stdio: "inherit",
        env: { ...process.env, RELAY_NATIVE_REPORT_DIR: directory },
      },
    );
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    let report;
    try {
      report = JSON.parse(
        await readFile(path.join(directory, "report.json"), "utf8"),
      );
    } catch {}
    results.push({
      name,
      status: code === 0 && report ? report.status : "fail",
      report: path.relative(root, path.join(directory, "report.json")),
    });
  }
}
const status = results.some((r) => r.status === "fail")
  ? "fail"
  : results.every((r) => r.status === "pass")
    ? "pass"
    : "incomplete";
const summary = {
  schemaVersion: 1,
  status,
  results,
  limits: [
    "Renderer/content scaling is synthetic and does not qualify mixed OS DPI or secondary displays.",
    "Software WebGL and an available Metal surface are separate observations; missing Metal is not hardware GPU qualification.",
    "Missing Screen Recording/Accessibility or an inactive user session is incomplete, never passing native evidence. No permission prompt is opened.",
  ],
};
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (status === "fail") process.exitCode = 1;
