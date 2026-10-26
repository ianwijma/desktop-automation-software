import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, release, arch } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";

const enabled = process.argv.includes("--run");
const output = path.resolve(
  process.env.RELAY_WAYLAND_REPORT_DIR ?? "test-results/native-wayland",
);
await mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1,
  environment: {
    platform: process.platform,
    osRelease: release(),
    architecture: arch(),
    desktop: process.env.XDG_CURRENT_DESKTOP ?? "unknown",
    session: process.env.XDG_SESSION_TYPE ?? "unknown",
  },
  checks: [],
  limits: [
    "Only this explicitly granted source, compositor and display configuration are exercised.",
    "Chooser cancellation, revocation while idle/held, source closure, monitor hotplug, compositor restart and portal Stop/Pause shortcut delivery require separate manual observations.",
    "Universal window enumeration/focus and passive global recording are unsupported. Synthetic tests do not qualify GNOME/KDE or installed-app permissions.",
    "No full desktop images, secure field contents or restore tokens are saved in this report.",
  ],
};
const finish = async () => {
  report.status = report.checks.some((c) => c.status === "fail")
    ? "fail"
    : report.checks.every((c) => c.status === "pass")
      ? "pass"
      : "incomplete";
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
if (
  !enabled ||
  process.platform !== "linux" ||
  !process.env.WAYLAND_DISPLAY ||
  process.env.XDG_SESSION_TYPE === "x11"
) {
  report.checks.push({
    name: "wayland-granted-desktop",
    status: "not-run",
    reason: !enabled
      ? "Use --run in a disposable GNOME/KDE Wayland session to enable real portal selection and fixture input."
      : "An actual Wayland session is required.",
  });
  await finish();
} else {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "relay-wayland-harness-"),
  );
  let adapter, port, fixturePid;
  const token = randomUUID();
  const check = async (name, operation) => {
    try {
      const evidence = await operation();
      report.checks.push({
        name,
        status: "pass",
        ...(evidence ? { evidence } : {}),
      });
    } catch (error) {
      report.checks.push({ name, status: "fail", reason: error.message });
      throw error;
    }
  };
  const poll = async (operation, predicate, timeout = 10000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await operation();
      if (predicate(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Synthetic fixture observation timed out");
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
  // Locate a solid, uniquely sized known marker. No window position API or
  // compositor-specific enumeration is used to guess where input should land.
  const marker = async (frame) => {
    const { data, info } = await sharp(
      Buffer.from(frame.dataUrl.split(",")[1], "base64"),
    )
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const same = (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return (
        Math.abs(data[i] - 232) <= 2 &&
        Math.abs(data[i + 1] - 56) <= 2 &&
        Math.abs(data[i + 2] - 100) <= 2
      );
    };
    const found = [];
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        if (
          !same(x, y) ||
          (x > 0 && same(x - 1, y)) ||
          (y > 0 && same(x, y - 1))
        )
          continue;
        let w = 0;
        while (x + w < info.width && same(x + w, y)) w++;
        if (w < 20 || w > 180) continue;
        let h = 0;
        while (y + h < info.height && same(x, y + h) && same(x + w - 1, y + h))
          h++;
        if (h < 20 || h > 180 || Math.abs(w / h - 1) > 0.08) continue;
        if (
          !Array.from({ length: h }, (_, dy) =>
            Array.from({ length: w }, (_, dx) => same(x + dx, y + dy)).every(
              Boolean,
            ),
          ).every(Boolean)
        )
          continue;
        found.push({ x, y, width: w, height: h });
      }
    assert.equal(
      found.length,
      1,
      "A unique complete synthetic marker must be visible in the selected source",
    );
    return found[0];
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
    const capabilities = await adapter.capabilities();
    report.native = capabilities.native;
    if (
      capabilities.session !== "wayland" ||
      !capabilities.capture ||
      !capabilities.input ||
      !capabilities.native?.wayland?.mediaAvailable
    ) {
      report.checks.push({
        name: "wayland-granted-desktop",
        status: "not-run",
        reason: capabilities.reasons.join(" "),
      });
    } else {
      const fixtureHash = createHash("sha256");
      for (const name of ["main.cjs", "preload.cjs", "index.html"])
        fixtureHash.update(
          await readFile(path.join("tests/fixtures/native-desktop", name)),
        );
      report.artifact = {
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        sourceDirty: Boolean(
          execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
          }).trim(),
        ),
        helperSha256: createHash("sha256")
          .update(await readFile(adapter.binaryPath))
          .digest("hex"),
        adapterSha256: createHash("sha256")
          .update(await readFile(bundled))
          .digest("hex"),
        fixtureSha256: fixtureHash.digest("hex"),
        installation: "source-harness",
      };
      const configFile = path.join(temporary, "fixture.json"),
        controlFile = path.join(temporary, "control.json");
      await writeFile(
        configFile,
        JSON.stringify({
          title: `RelayWaylandFixture-${randomUUID()}`,
          token,
          controlFile,
          profile: path.join(temporary, "profile"),
        }),
      );
      const target = {
        id: randomUUID(),
        name: "Wayland synthetic fixture",
        kind: "desktop",
        launch: {
          linux: {
            command: createRequire(import.meta.url)("electron"),
            args: [
              "--no-sandbox",
              "--ozone-platform=wayland",
              path.resolve("tests/fixtures/native-desktop/main.cjs"),
              configFile,
            ],
          },
        },
      };
      await check("launch-synthetic-wayland-window", async () => {
        const result = await adapter.execute("launch", {}, target);
        fixturePid = result.pid;
        const connection = await poll(async () => {
          try {
            return JSON.parse(await readFile(controlFile, "utf8"));
          } catch {
            return null;
          }
        }, Boolean);
        port = connection.port;
        const state = await poll(control, (s) => Boolean(s.targets));
        report.environment.fixtureVersions = state.versions;
        report.environment.displays = state.displays;
        report.environment.observedDevicePixelRatio = state.devicePixelRatio;
      });
      console.log(
        "Select the source containing only the synthetic Relay fixture in the portal chooser. Then focus that fixture. This run sends real fixture input.",
      );
      let first;
      await check("explicit-grant-persistent-capture-and-mapping", async () => {
        first = await adapter.capture(target);
        await marker(first);
        assert.ok(first.native.sourceToken);
        const second = await adapter.capture(target);
        assert.equal(second.native.sourceToken, first.native.sourceToken);
        const live = await adapter.capabilities();
        report.native = live.native;
        assert.equal(live.native.permissions.capture, "granted");
        return {
          bounds: first.bounds,
          pixels: { width: first.width, height: first.height },
          pixelToInput: first.native.geometry.pixelToInput,
          inputTransport: live.native.wayland.inputTransport,
        };
      });
      const point = async (id, dx = 0, dy = 0) => {
        const state = await control();
        const frame = await adapter.capture(target);
        const box = await marker(frame),
          anchor = state.targets.marker,
          r = state.targets[id];
        const x =
            box.x +
            ((r.x + r.width / 2 + dx - anchor.x) * box.width) / anchor.width,
          y =
            box.y +
            ((r.y + r.height / 2 + dy - anchor.y) * box.height) / anchor.height;
        assert.ok(
          x >= 0 && y >= 0 && x < frame.width && y < frame.height,
          "Synthetic point must be inside the granted frame",
        );
        return { x, y, frameId: frame.id };
      };
      await poll(control, (s) => s.focused, 30000);
      await check("observed-click-type-secure-scroll-drag", async () => {
        await adapter.execute("click", await point("action"), target);
        await poll(control, (s) => s.clicks === 1);
        await adapter.execute("click", await point("text"), target);
        await adapter.execute("type", { text: "Relay Wayland" }, target);
        await poll(control, (s) => s.text === "Relay Wayland");
        await adapter.execute("click", await point("secure"), target);
        await adapter.execute("type", { text: "synthetic-only" }, target);
        const secure = await poll(control, (s) => s.secureHasValue);
        assert.equal("secureValue" in secure, false);
        await adapter.execute(
          "scroll",
          { ...(await point("scroll")), deltaY: 220, deltaX: 0 },
          target,
        );
        await poll(control, (s) => s.scrollTop > 0);
        const from = await point("drag", -60),
          to = await point("drag", 60);
        await adapter.execute(
          "drag",
          {
            ...from,
            frameId: to.frameId,
            toX: to.x,
            toY: to.y,
            durationMs: 500,
          },
          target,
        );
        await poll(control, (s) => s.drags > 0);
        return {
          clicks: 1,
          textMatched: true,
          secureValueOmitted: true,
          scrollObserved: true,
          dragObserved: true,
        };
      });
      await check("animated-webgl-capture", async () => {
        const state = await control();
        assert.equal(
          state.gpu,
          true,
          "WebGL must be available for this graphics observation",
        );
        const rect = state.targets.gpu;
        const pixels = async () => {
          const frame = await adapter.capture(target),
            box = await marker(frame),
            anchor = (await control()).targets.marker;
          const x = Math.round(
              box.x + ((rect.x + 10 - anchor.x) * box.width) / anchor.width,
            ),
            y = Math.round(
              box.y + ((rect.y + 10 - anchor.y) * box.height) / anchor.height,
            );
          return sharp(Buffer.from(frame.dataUrl.split(",")[1], "base64"))
            .extract({ left: x, top: y, width: 8, height: 8 })
            .raw()
            .toBuffer();
        };
        const before = await pixels();
        await poll(pixels, (value) => !value.equals(before));
        return { capturedPixelsChanged: true, hardwareGpuQualified: false };
      });
      await check("cancel-held-input-and-close-owned-grant", async () => {
        const abort = new AbortController();
        let work;
        try {
          await adapter.execute(
            "key",
            { key: "Shift", action: "down" },
            target,
          );
          await adapter.execute("move", await point("drag"), target);
          await poll(control, (s) => s.held.includes("Shift"));
          const from = await point("drag", -60),
            to = await point("drag", 60);
          work = adapter
            .execute(
              "drag",
              {
                ...from,
                frameId: to.frameId,
                toX: to.x,
                toY: to.y,
                durationMs: 10000,
              },
              target,
              abort.signal,
            )
            .catch((error) => error);
          await poll(control, (s) => s.buttons === 1);
          abort.abort();
          assert.match((await work).message, /Cancelled/);
        } finally {
          abort.abort();
          if (work) await work;
          await adapter.releaseAll();
        }
        return { cleanupAcknowledged: true, noImplicitRegrant: true };
      });
      console.log(
        "Explicitly select the synthetic source again to verify recovery. Cancellation itself did not reopen the chooser.",
      );
      await check(
        "explicit-regrant-rejects-old-frame-and-observes-release",
        async () => {
          await adapter.capture(target);
          await expectStale();
          await adapter.execute("move", await point("drag"), target);
          await poll(control, (s) => s.buttons === 0 && s.held.length === 0);
          return {
            staleFrameRejected: true,
            buttonsReleased: true,
            modifiersReleased: true,
          };
        },
      );
      async function expectStale() {
        await assert.rejects(
          adapter.execute("click", { x: 10, y: 10, frameId: first.id }, target),
          /geometry changed/i,
        );
      }
    }
  } catch (error) {
    if (!report.checks.some((c) => c.status === "fail"))
      report.checks.push({
        name: "wayland-harness",
        status: "fail",
        reason: error.message,
      });
  } finally {
    try {
      await adapter?.dispose();
    } catch (error) {
      report.checks.push({
        name: "cleanup",
        status: "fail",
        reason: error.message,
      });
    }
    if (port) await control("/quit", "POST").catch(() => {});
    else if (fixturePid)
      try {
        process.kill(fixturePid, "SIGTERM");
      } catch {}
    await rm(temporary, { recursive: true, force: true });
    await finish();
  }
}
