import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, release, arch, platform } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import sharp from "sharp";

const args = new Set(process.argv.slice(2));
const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const fixtureKind = option("fixture", "electron");
const captureBackend = option("capture-backend", "wgc");
const contentScale = Number(option("content-scale", "1"));
const rendererScale = Number(option("renderer-scale", "1"));
const position = {
  x: Number(option("window-x", "80")),
  y: Number(option("window-y", "80")),
};
assert.ok(
  Object.values(position).every(
    (value) => Number.isSafeInteger(value) && Math.abs(value) < 100000,
  ),
  "Invalid fixture position",
);
assert.ok(["electron", "win32"].includes(fixtureKind), "Unknown fixture");
assert.ok(
  ["wgc", "printwindow"].includes(captureBackend),
  "Unknown capture backend",
);
assert.ok(
  [contentScale, rendererScale].every(
    (value) => Number.isFinite(value) && value >= 0.5 && value <= 3,
  ),
  "Fixture scales must be between 0.5 and 3",
);
const output = path.resolve(
  process.env.RELAY_NATIVE_REPORT_DIR ?? "test-results/native-harness",
);
await mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  environment: {
    platform: platform(),
    osRelease: release(),
    architecture: arch(),
    session: process.env.XDG_SESSION_TYPE ?? platform(),
    desktopHint: process.env.XDG_CURRENT_DESKTOP ?? null,
    sessionLabel:
      process.argv
        .find((a) => a.startsWith("--session-label="))
        ?.split("=")[1] ?? "unspecified",
    node: process.versions.node,
    softwareGpuRequested: args.has("--software-gpu"),
    fixture: fixtureKind,
    contentScale,
    rendererScale,
    captureBackend: process.platform === "win32" ? captureBackend : undefined,
  },
  artifact: {},
  checks: [],
  limitations: [
    "Electron fixture; native toolkit and hardware GPU qualification remain separate.",
    "Only the selected session, display scale and backend are tested. Missing permissions or unsupported operations are not passing results.",
  ],
};
const finish = async () => {
  report.completedAt = new Date().toISOString();
  report.status = report.checks.some((c) => c.status === "fail")
    ? "fail"
    : report.checks.some(
          (c) => c.status === "not-run" || c.status === "unsupported",
        )
      ? "incomplete"
      : "pass";
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        report: path.join(output, "report.json"),
        checks: report.checks,
      },
      null,
      2,
    ),
  );
  if (report.status === "fail") process.exitCode = 1;
};
if (!args.has("--run")) {
  report.checks.push({
    name: "desktop-capture-and-input",
    status: "not-run",
    reason:
      "Run with --run in a disposable desktop session to explicitly enable fixture input.",
  });
  await finish();
} else {
  const temporary = await mkdtemp(path.join(tmpdir(), "relay-native-harness-"));
  let adapter,
    port,
    token = randomUUID(),
    launched = false;
  const check = async (name, operation) => {
    const started = Date.now();
    try {
      const evidence = await operation();
      report.checks.push({
        name,
        status: "pass",
        durationMs: Date.now() - started,
        ...(evidence ? { evidence } : {}),
      });
      return true;
    } catch (error) {
      report.checks.push({
        name,
        status: "fail",
        durationMs: Date.now() - started,
        reason: error.message,
        ...(error.details ? { diagnostic: error.details } : {}),
      });
      return false;
    }
  };
  const poll = async (operation, predicate, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await operation();
      if (predicate(result)) return result;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Fixture observation timed out");
  };
  const control = async (route = "/state", method = "GET") => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.ok, true, "Fixture control request failed");
    return response.json();
  };
  try {
    const bundled = path.join(temporary, "adapter.mjs");
    await build({
      entryPoints: ["src/integrations/native.ts"],
      outfile: bundled,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    const { NativeAdapter } = await import(pathToFileURL(bundled).href);
    adapter = new NativeAdapter({
      binaryPath: process.env.RELAY_NATIVE_BINARY,
      env: { ELECTRON_RUN_AS_NODE: undefined },
    });
    const binary = await readFile(adapter.binaryPath);
    if (fixtureKind === "win32")
      assert.equal(
        process.platform,
        "win32",
        "The native control fixture requires Windows",
      );
    const fixture =
      fixtureKind === "win32"
        ? path.resolve(
            path.dirname(adapter.binaryPath),
            "relay-native-fixture.exe",
          )
        : path.resolve("tests/fixtures/native-desktop/main.cjs");
    const fixtureHash = createHash("sha256");
    if (fixtureKind === "win32") fixtureHash.update(await readFile(fixture));
    else
      for (const name of ["main.cjs", "preload.cjs", "index.html"])
        fixtureHash.update(
          await readFile(path.join(path.dirname(fixture), name)),
        );
    let commit = "unknown",
      sourceDirty = true;
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {}
    try {
      sourceDirty = Boolean(
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim(),
      );
    } catch {}
    report.artifact = {
      commit,
      sourceDirty,
      adapterSha256: createHash("sha256")
        .update(await readFile(bundled))
        .digest("hex"),
      helperFilename: path.basename(adapter.binaryPath),
      helperSha256: createHash("sha256").update(binary).digest("hex"),
      fixtureSha256: fixtureHash.digest("hex"),
      installation: "source-harness",
    };
    const capabilities = await adapter.capabilities();
    // Do not include the enumerated desktop window list in the report.
    report.native = capabilities.native;
    report.environment.session = capabilities.session;
    assert.ok(
      capabilities.native?.helper,
      "Native handshake must succeed independently of desktop readiness",
    );
    const unavailableWindows =
      capabilities.native?.helper?.backend === "win32-wgc" &&
      (!capabilities.native.windows?.interactiveDesktop ||
        !capabilities.native.windows?.perMonitorV2 ||
        (captureBackend === "wgc" && !capabilities.capture));
    if (unavailableWindows && args.has("--allow-unavailable")) {
      report.checks.push({
        name: "desktop-capture-and-input",
        status: "not-run",
        reason:
          "The host does not expose the required interactive desktop/graphics device. No fixture input was attempted.",
      });
    } else if (capabilities.session === "wayland") {
      report.checks.push({
        name: "desktop-capture-and-input",
        status: "not-run",
        reason:
          "Portal chooser/source ownership requires N04 qualification; no automatic chooser or input is attempted.",
      });
    } else {
      const title = `RelayNativeFixture-${randomUUID()}`;
      const configFile = path.join(temporary, "fixture.json"),
        controlFile = path.join(temporary, "control.json");
      await writeFile(
        configFile,
        JSON.stringify({
          title,
          contentScale,
          position,
          token,
          controlFile,
          profile: path.join(temporary, "profile"),
        }),
      );
      const target = {
        id: randomUUID(),
        name: "Native harness fixture",
        kind: "desktop",
        windowTitle: title,
        ...(process.platform === "win32"
          ? { windowsCaptureBackend: captureBackend }
          : {}),
        launch: {
          [process.platform]: {
            command:
              fixtureKind === "win32"
                ? fixture
                : createRequire(import.meta.url)("electron"),
            args:
              fixtureKind === "win32"
                ? [configFile]
                : [
                    "--no-sandbox",
                    `--force-device-scale-factor=${rendererScale}`,
                    ...(args.has("--software-gpu")
                      ? [
                          "--use-gl=angle",
                          "--use-angle=swiftshader",
                          "--enable-unsafe-swiftshader",
                          ...(process.platform === "win32"
                            ? ["--disable-gpu-compositing"]
                            : []),
                        ]
                      : []),
                    fixture,
                    configFile,
                  ],
          },
        },
      };
      launched = await check("launch-attach-focus", async () => {
        await adapter.execute("launch", { timeoutMs: 30000 }, target);
        const connection = await poll(async () => {
          try {
            return JSON.parse(await readFile(controlFile, "utf8"));
          } catch {
            return null;
          }
        }, Boolean);
        port = connection.port;
        await adapter.execute("attach", {}, target);
        await adapter.execute("focus", {}, target);
        const state = await poll(control, (s) => s.focused && s.targets);
        report.environment.displays = state.displays;
        report.environment.fixtureVersions = state.versions;
        report.environment.observedDevicePixelRatio = state.devicePixelRatio;
        return { startup: true, focused: true };
      });
      if (launched) {
        let frame;
        const point = async (id, dx = 0, dy = 0) => {
          const state = await control(),
            r = state.targets[id];
          let x = r.x + r.width / 2 + dx,
            y = r.y + r.height / 2 + dy;
          if (state.coordinateSpace !== "window-input") {
            const content = state.contentBounds ?? state.bounds;
            const viewport = state.viewport ?? state.bounds;
            x =
              content.x - frame.bounds.x + (x * content.width) / viewport.width;
            y =
              content.y -
              frame.bounds.y +
              (y * content.height) / viewport.height;
          }
          const transform = frame.native.geometry.pixelToInput;
          return {
            x: (x - (transform.offsetX ?? 0)) / transform.scaleX,
            y: (y - (transform.offsetY ?? 0)) / transform.scaleY,
          };
        };
        const captured = await check(
          "capture-content-and-transform",
          async () => {
            let matched = false;
            const deadline = Date.now() + 5000;
            // App load/DOM readiness can precede its first compositor paint.
            // Read-only captures may wait for known fixture pixels; input never retries.
            do {
              frame = await adapter.capture(target);
              assert.equal(
                frame.native.helperInstanceId,
                capabilities.native.helper.instanceId,
              );
              const marker = await point("marker");
              const png = Buffer.from(frame.dataUrl.split(",")[1], "base64");
              const { data } = await sharp(png)
                .extract({
                  left: Math.round(marker.x),
                  top: Math.round(marker.y),
                  width: 1,
                  height: 1,
                })
                .removeAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
              report.startupCapture = {
                width: frame.width,
                height: frame.height,
                bounds: frame.bounds,
                native: frame.native,
                marker: { point: marker, rgb: [...data] },
              };
              // Keep failed pre-input captures too: only this synthetic fixture is captured.
              await writeFile(path.join(output, "fixture.png"), png);
              matched =
                Math.abs(data[0] - 232) < 12 &&
                Math.abs(data[1] - 56) < 12 &&
                Math.abs(data[2] - 100) < 12;
              if (!matched)
                await new Promise((resolve) => setTimeout(resolve, 100));
            } while (!matched && Date.now() < deadline);
            assert.ok(
              matched,
              `Capture must contain the fixture marker, not a blank/incorrect window (sample ${report.startupCapture.marker.rgb})`,
            );
            return {
              width: frame.width,
              height: frame.height,
              bounds: frame.bounds,
              native: frame.native,
            };
          },
        );
        const sampleText =
          process.platform === "win32"
            ? "Relay fixture 日本語 😀42"
            : "Relay fixture text 42";
        if (captured) {
          await check("click-type-secure-field-scroll-drag", async () => {
            await adapter.execute(
              "click",
              { ...(await point("action")), frameId: frame.id },
              target,
            );
            await poll(control, (s) => s.clicks === 1);
            await adapter.execute("click", await point("text"), target);
            await adapter.execute("type", { text: sampleText }, target);
            await poll(control, (s) => s.text === sampleText);
            await adapter.execute("click", await point("secure"), target);
            await adapter.execute("type", { text: "synthetic-only" }, target);
            await poll(control, (s) => s.secureHasValue);
            await adapter.execute(
              "scroll",
              { ...(await point("scroll")), deltaY: 300 },
              target,
            );
            await poll(control, (s) => s.scrollTop > 0);
            const from = await point("drag", -70),
              to = await point("drag", 70);
            await adapter.execute(
              "drag",
              { ...from, toX: to.x, toY: to.y, durationMs: 500 },
              target,
            );
            await poll(control, (s) => s.drags === 1 && s.buttons === 0);
            return {
              clicks: 1,
              textMatched: true,
              secureValueOmitted: true,
              scrollObserved: true,
              dragObserved: true,
            };
          });
          await check("animated-graphics-capture", async () => {
            const initial = await control();
            assert.ok(
              initial.gpu || initial.renderSurface === "native-gdi",
              "Graphics surface unavailable",
            );
            const gpu = await point("gpu");
            const region = {
              left: Math.round(gpu.x),
              top: Math.round(gpu.y),
              width: 8,
              height: 8,
            };
            const pixels = async () => {
              const f = await adapter.capture(target);
              return sharp(Buffer.from(f.dataUrl.split(",")[1], "base64"))
                .extract(region)
                .raw()
                .toBuffer();
            };
            const first = await pixels();
            await poll(pixels, (p) => !p.equals(first));
            assert.ok(
              (await control()).animationFrames > initial.animationFrames,
            );
            return {
              surface: initial.renderSurface ?? "webgl",
              webgl: Boolean(initial.gpu),
              capturedPixelsChanged: true,
              hardwareGpuQualified: false,
            };
          });
          await check("resize-rejects-stale-capture", async () => {
            const old = await adapter.capture(target);
            await control("/resize", "POST");
            await poll(
              control,
              (s) =>
                Math.abs(s.bounds.width - (s.resizeExpectedWidth ?? 640)) <= 1,
            );
            await assert.rejects(
              adapter.execute(
                "click",
                { x: 30, y: 30, frameId: old.id },
                target,
              ),
              /geometry changed/i,
            );
            frame = await adapter.capture(target);
            assert.notEqual(frame.bounds.width, old.bounds.width);
          });
          if (process.platform === "win32")
            await check("capture-loss-and-explicit-recovery", async () => {
              await control("/minimize", "POST");
              await poll(control, (s) => s.minimized);
              await assert.rejects(adapter.capture(target), (error) =>
                ["CAPTURE_LOST", "CAPTURE_UNAVAILABLE"].includes(
                  error.details?.code,
                ),
              );
              await control("/restore", "POST");
              await poll(control, (s) => !s.minimized && s.focused);
              frame = await adapter.capture(target);
              assert.equal(
                frame.native.backend,
                captureBackend === "wgc" ? "win32-wgc" : "win32-printwindow",
              );
            });
          await check("held-input-cancellation-and-release", async () => {
            await adapter.execute(
              "key",
              { key: "Shift", action: "down" },
              target,
            );
            await poll(control, (s) => s.held.includes("Shift"));
            const abort = new AbortController(),
              from = await point("drag", -70),
              to = await point("drag", 70);
            const work = adapter.execute(
              "drag",
              { ...from, toX: to.x, toY: to.y, durationMs: 10000 },
              target,
              abort.signal,
            );
            const rejection = assert.rejects(work, /Cancelled/);
            try {
              await poll(control, (s) => s.buttons === 1);
            } finally {
              abort.abort();
            }
            await rejection;
            await adapter.releaseAll();
            await poll(control, (s) => s.buttons === 0 && s.held.length === 0);
          });
          await check("helper-restart-invalidates-capture", async () => {
            const old = await adapter.capture(target),
              info = await adapter.restart();
            assert.notEqual(info.instanceId, old.native.helperInstanceId);
            await assert.rejects(
              adapter.execute(
                "click",
                { x: 30, y: 30, frameId: old.id },
                target,
              ),
              /geometry changed/i,
            );
            frame = await adapter.capture(target);
            await adapter.execute("click", await point("action"), target);
            await poll(control, (s) => s.clicks === 2);
            return {
              newHelperInstance: true,
              staleFrameRejected: true,
              inputResumed: true,
            };
          });
        } else
          report.checks.push({
            name: "coordinate-input-and-graphics",
            status: "not-run",
            reason:
              "Capture/transform prerequisite failed; no coordinate input attempted.",
          });
        await check("duplicate-window-targeting", async () => {
          await control("/duplicate", "POST");
          await poll(
            () => adapter.listWindows(),
            (windows) => windows.filter((w) => w.title === title).length === 2,
          );
          await assert.rejects(
            adapter.execute("attach", {}, { ...target, id: randomUUID() }),
            /Multiple windows/,
          );
          await control("/close-duplicate", "POST");
          await poll(
            () => adapter.listWindows(),
            (windows) => windows.filter((w) => w.title === title).length === 1,
          );
        });
      }
    }
  } catch (error) {
    report.checks.push({
      name: "harness-initialization",
      status: "fail",
      reason: error.message,
    });
  } finally {
    if (!port) {
      try {
        port = JSON.parse(
          await readFile(path.join(temporary, "control.json"), "utf8"),
        ).port;
      } catch {}
    }
    if (port) await control("/quit", "POST").catch(() => {});
    if (adapter)
      await adapter.dispose().catch((error) =>
        report.checks.push({
          name: "cleanup",
          status: "fail",
          reason: error.message,
        }),
      );
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch((error) =>
      report.checks.push({
        name: "temporary-cleanup",
        status: "fail",
        reason: error.message,
      }),
    );
    await finish();
  }
}
