import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { NativeAdapter } from "../src/integrations/native";
import type { RecordedAction, TargetDescriptor } from "../src/shared/types";

const binary = path.resolve("native/target/debug/relay-native");
const supported =
  process.platform === "linux" &&
  existsSync("/usr/bin/Xvfb") &&
  existsSync(binary);
describe.skipIf(!supported)(
  "native service on an isolated Xvfb desktop",
  () => {
    let xvfb: ChildProcess, fixture: ChildProcess, native: NativeAdapter;
    let env: NodeJS.ProcessEnv;
    const target: TargetDescriptor = {
      id: "fixture",
      name: "Fixture",
      kind: "desktop",
      windowTitle: "RelayFixture",
    };
    beforeAll(async () => {
      xvfb = spawn(
        "Xvfb",
        ["-displayfd", "3", "-screen", "0", "800x600x24", "-nolisten", "tcp"],
        { stdio: ["ignore", "ignore", "pipe", "pipe"] },
      );
      const pipe = xvfb.stdio[3]!;
      const [data] = await once(pipe, "data");
      env = {
        ...process.env,
        DISPLAY: `:${String(data).trim()}`,
        WAYLAND_DISPLAY: "",
        XDG_SESSION_TYPE: "x11",
      };
      fixture = spawn(
        "xmessage",
        [
          "-name",
          "RelayFixture",
          "-geometry",
          "300x180+50+60",
          "-buttons",
          "Done:0",
          "-default",
          "Done",
          "Relay isolated native capture fixture",
        ],
        { env, stdio: "ignore" },
      );
      native = new NativeAdapter({ binaryPath: binary, env });
      for (let attempt = 0; attempt < 30; attempt++) {
        if (
          (await native.listWindows()).some(
            (window) => window.title === "RelayFixture",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    afterAll(async () => {
      await native?.dispose();
      fixture?.kill();
      xvfb?.kill();
    });
    it("enumerates the real fixture and captures a valid PNG with its geometry", async () => {
      const caps = await native.capabilities();
      expect(caps.input).toBe(true);
      expect(caps.capture).toBe(true);
      const frame = await native.capture(target);
      expect(frame.width).toBe(300);
      expect(frame.height).toBe(180);
      expect(frame.bounds?.x).toBe(50);
      const data = Buffer.from(frame.dataUrl.split(",")[1]!, "base64");
      expect(data.subarray(1, 4).toString()).toBe("PNG");
      expect(data.length).toBeGreaterThan(200);
    });
    it("rejects stale capture coordinates after resizing a target", async () => {
      const frame = await native.capture(target);
      const window = (await native.listWindows()).find(
        (window) => window.title === "RelayFixture",
      )!;
      execFileSync("xdotool", ["windowsize", window.id, "320", "200"], { env });
      await expect(
        native.execute("click", { x: 20, y: 20, frameId: frame.id }, target),
      ).rejects.toThrow("geometry changed");
      execFileSync("xdotool", ["windowsize", window.id, "300", "180"], { env });
    });
    it("fails closed when the configured native target is ambiguous or missing", async () => {
      await expect(
        native.capture({
          ...target,
          id: "missing",
          windowTitle: "not-a-real-window",
        }),
      ).rejects.toThrow("not found");
      await expect(
        native.capture({
          ...target,
          id: "unconfigured",
          windowTitle: undefined,
        }),
      ).rejects.toThrow("Choose an application");
    });
    it("rejects native DOM selectors instead of silently clicking the origin", async () => {
      await expect(
        native.execute("click", { selector: "#submit" }, target),
      ).rejects.toThrow("accessibility selectors");
    });
    it("validates saved dimensions without invalidating a current detector frame", async () => {
      const frame = await native.capture(target);
      await expect(
        native.execute(
          "move",
          {
            x: 20,
            y: 20,
            frameId: frame.id,
            expectedWidth: 300,
            expectedHeight: 180,
          },
          target,
        ),
      ).resolves.toBe(true);
      await expect(
        native.execute(
          "move",
          { x: 20, y: 20, expectedWidth: 900, expectedHeight: 180 },
          target,
        ),
      ).rejects.toThrow("dimensions changed");
      await expect(
        native.capture({
          ...target,
          windowTitle: "Changed target must not reuse cached handle",
        }),
      ).rejects.toThrow("not found");
    });
    it("records actual X11 clicks with target and resize guards", async () => {
      const actions: RecordedAction[] = [];
      await native.startRecording(target, (action) => actions.push(action));
      await native.execute("focus", {}, target);
      await new Promise((resolve) => setTimeout(resolve, 200));
      execFileSync("xdotool", ["mousemove", "80", "90", "click", "1"], { env });
      for (
        let i = 0;
        i < 40 && !actions.some((action) => action.kind === "click");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      await native.stopRecording();
      expect(
        actions.find((action) => action.kind === "click")?.config,
      ).toMatchObject({
        targetId: target.id,
        expectedWidth: 300,
        expectedHeight: 180,
      });
    });
    it("waits for cancelled native work to release held keys before allowing new input", async () => {
      await native.execute("key", { key: "a", action: "down" }, target);
      const abort = new AbortController();
      const drag = native.execute(
        "drag",
        { x: 20, y: 20, toX: 80, toY: 40, durationMs: 2000 },
        target,
        abort.signal,
      );
      setTimeout(() => abort.abort(), 100);
      await expect(drag).rejects.toThrow("Cancelled");
      await native.releaseAll();
      const keyboard = execFileSync(
        "xinput",
        ["query-state", "Virtual core XTEST keyboard"],
        { env, encoding: "utf8" },
      );
      expect(keyboard).not.toMatch(/key\[\d+\]=down/);
      await expect(
        native.execute("move", { x: 30, y: 30 }, target),
      ).resolves.toBe(true);
    });
    it("sends a real key event to the selected window without touching the user desktop", async () => {
      const exit = once(fixture, "exit");
      await native.execute("key", { key: "Return" }, target);
      expect((await exit)[0]).toBe(0);
    });
    it("reports Wayland support honestly rather than falling through to XWayland input", async () => {
      const wayland = new NativeAdapter({
        binaryPath: binary,
        env: {
          ...env,
          WAYLAND_DISPLAY: "wayland-0",
          XDG_SESSION_TYPE: "wayland",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/relay-no-session-bus",
        },
      });
      try {
        const caps = await wayland.capabilities();
        expect(caps.input).toBe(false);
        expect(caps.capture).toBe(false);
        expect(caps.reasons.join(" ")).toContain("Wayland");
      } finally {
        await wayland.dispose();
      }
    });
  },
);
