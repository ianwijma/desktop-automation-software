import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  spawn,
  spawnSync,
  execFileSync,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeAdapter } from "../src/integrations/native";
import type { RecordedAction, TargetDescriptor } from "../src/shared/types";

describe.skipIf(process.platform === "win32")("native cleanup protocol", () => {
  it("retains held keys and blocks further input until failed emergency cleanup is explicitly retried", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "relay-native-cleanup-"));
    const helper = path.join(directory, "service.cjs");
    const modePath = path.join(directory, "mode");
    const logPath = path.join(directory, "requests");
    writeFileSync(modePath, "fail");
    writeFileSync(
      helper,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.RELAY_NATIVE_MOCK_DIRECTORY;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(root, 'requests'), line + '\\n');
  if(request.method === 'input' && request.params.kind === 'drag') return;
  let result = true;
  if(request.method === 'handshake') result = {protocolVersion:2,helperVersion:'test',instanceId:'mock',platform:'linux',backend:'mock',coordinateSpace:'physical-pixels'};
  if(request.method === 'capabilities') result = {platform:'linux',session:'x11',capture:true,input:true,accessibility:false,directRecording:false,globalShortcuts:false,windows:[],reasons:[]};
  if(request.method === 'listWindows') result = [{id:'1',title:'Fixture',bounds:{x:0,y:0,width:100,height:100}}];
  const error = request.id === 'cleanup-keys' && fs.readFileSync(path.join(root,'mode'),'utf8') === 'fail' ? {code:'BACKEND_FAILURE',message:'Mock key release failed',operation:'releaseKeys',backend:'mock',permission:'unknown',retryable:false} : undefined;
  process.stdout.write(JSON.stringify({protocolVersion:2,id:request.id,...(error?{error}:{result})}) + '\\n');
});
`,
      { mode: 0o700 },
    );
    const adapter = new NativeAdapter({
      binaryPath: helper,
      env: { RELAY_NATIVE_MOCK_DIRECTORY: directory },
    });
    const target: TargetDescriptor = {
      id: "mock",
      name: "Fixture",
      kind: "desktop",
      windowTitle: "Fixture",
    };
    try {
      await adapter.execute("key", { key: "Shift", action: "down" }, target);
      const signal = AbortSignal.timeout(100);
      await expect(
        adapter.execute("drag", { x: 1, y: 1, toX: 2, toY: 2 }, target, signal),
      ).rejects.toThrow("Cancelled");
      await expect(adapter.releaseAll()).rejects.toThrow(
        "Mock key release failed",
      );
      await expect(
        adapter.execute("move", { x: 1, y: 1 }, target),
      ).rejects.toThrow("Mock key release failed");
      writeFileSync(modePath, "ok");
      await adapter.stopRecording();
      await adapter.releaseAll();
      await expect(
        adapter.execute("move", { x: 1, y: 1 }, target),
      ).resolves.toBe(true);
      const releases = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { id: string; params: { keys?: string[] } },
        )
        .filter((request) => request.id === "cleanup-keys");
      expect(releases.length).toBeGreaterThanOrEqual(2);
      expect(
        releases.every((request) => request.params.keys?.includes("Shift")),
      ).toBe(true);
    } finally {
      writeFileSync(modePath, "ok");
      await adapter.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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
      native = new NativeAdapter({ binaryPath: binary, env, timeoutMs: 5000 });
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
      await expect
        .poll(() => actions.some((action) => action.kind === "click"), {
          timeout: 5000,
        })
        .toBe(true);
      await native.stopRecording();
      const pid = (native as unknown as { child: ChildProcess }).child.pid!;
      expect(
        spawnSync("ps", ["--ppid", String(pid), "-o", "comm="], {
          encoding: "utf8",
        }).stdout,
      ).not.toMatch(/xinput|stdbuf/);
      expect(
        actions.find((action) => action.kind === "click")?.config,
      ).toMatchObject({
        targetId: target.id,
        expectedWidth: 300,
        expectedHeight: 180,
      });
    }, 10000);
    it("joins each recorder before restarting and never appends stopped-session actions", async () => {
      const prior: RecordedAction[] = [],
        current: RecordedAction[] = [];
      await native.startRecording(target, (action) => prior.push(action));
      await native.execute("focus", {}, target);
      await new Promise((resolve) => setTimeout(resolve, 100));
      execFileSync("xdotool", ["mousemove", "80", "90", "click", "1"], { env });
      await native.stopRecording();
      const oldCount = prior.length;
      await native.startRecording(target, (action) => current.push(action));
      await new Promise((resolve) => setTimeout(resolve, 100));
      execFileSync("xdotool", ["mousemove", "80", "90", "click", "1"], { env });
      await expect
        .poll(() => current.some((action) => action.kind === "click"), {
          timeout: 5000,
        })
        .toBe(true);
      await native.stopRecording();
      expect(current.filter((action) => action.kind === "click")).toHaveLength(
        1,
      );
      expect(prior).toHaveLength(oldCount);
      const count = current.length;
      execFileSync("xdotool", ["mousemove", "80", "90", "click", "1"], { env });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(current).toHaveLength(count);
    }, 10000);
    it("waits for cancelled native work to release held keys before allowing new input", async ({
      onTestFailed,
    }) => {
      let phase = "hold key";
      onTestFailed(() =>
        console.error(`Isolated native cleanup phase: ${phase}`),
      );
      await native.execute("key", { key: "a", action: "down" }, target);
      const abort = new AbortController();
      phase = "cancel drag";
      const drag = native.execute(
        "drag",
        { x: 20, y: 20, toX: 80, toY: 40, durationMs: 2000 },
        target,
        abort.signal,
      );
      setTimeout(() => abort.abort(), 100);
      await expect(drag).rejects.toThrow("Cancelled");
      phase = "release barrier";
      await native.releaseAll();
      phase = "query held keys";
      const keyboard = execFileSync(
        "xinput",
        ["query-state", "Virtual core XTEST keyboard"],
        { env, encoding: "utf8" },
      );
      expect(keyboard).not.toMatch(/key\[\d+\]=down/);
      phase = "resume pointer";
      await expect(
        native.execute("move", { x: 30, y: 30 }, target),
      ).resolves.toBe(true);
    });
    it("acknowledges repeated movement to the same point without waiting for unrelated motion", async () => {
      await expect(
        native.execute("move", { x: 40, y: 50 }, target),
      ).resolves.toBe(true);
      await expect(
        native.execute("move", { x: 40, y: 50 }, target),
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
