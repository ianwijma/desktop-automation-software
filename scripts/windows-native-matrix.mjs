import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const enabled = process.argv.includes("--run");
const allowUnavailable = process.argv.includes("--allow-unavailable");
const root = path.resolve(
  process.env.RELAY_WINDOWS_REPORT_DIR ?? "test-results/native-windows",
);
await mkdir(root, { recursive: true });
const results = [];
if (!enabled || process.platform !== "win32") {
  results.push({
    name: "windows-desktop",
    status: "not-run",
    reason: !enabled
      ? "Use --run to enable synthetic fixture capture/input"
      : "Windows is required",
  });
} else {
  const cases = [
    ["electron-1", ["--fixture=electron", "--renderer-scale=1"]],
    ["electron-1.5", ["--fixture=electron", "--renderer-scale=1.5"]],
    ["win32-1", ["--fixture=win32", "--content-scale=1"]],
    ["win32-1.5", ["--fixture=win32", "--content-scale=1.5"]],
    ["printwindow-win32", ["--fixture=win32", "--capture-backend=printwindow"]],
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
        "--window-y=0",
        "--session-label=windows-matrix",
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
    if (code !== 0) break;
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
    "Software WebGL capture does not qualify a hardware GPU, secure/elevated desktops, or an installer.",
    "Unavailable desktop/graphics cases are incomplete, never passing native evidence.",
  ],
};
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (status === "fail") process.exitCode = 1;
