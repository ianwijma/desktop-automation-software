import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { targetSchema } from "../src/shared/validation";
import { NativeAdapter } from "../src/integrations/native";
import {
  nativeErrorSchema,
  nativeHandshakeSchema,
} from "../src/shared/native-protocol";
import type { TargetDescriptor } from "../src/shared/types";

const resources: { directory: string; adapter: NativeAdapter }[] = [];
afterEach(async () => {
  for (const { adapter, directory } of resources.splice(0)) {
    await adapter.dispose();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
});
async function mock(mode = "ok") {
  const directory = await mkdtemp(
    path.join(tmpdir(), "relay-native-contract-"),
  );
  const script = path.join(directory, "helper.cjs"),
    control = path.join(directory, "state.json"),
    log = path.join(directory, "requests");
  await writeFile(control, JSON.stringify({ mode, pid: 1 }));
  await writeFile(
    script,
    `
const fs=require('node:fs');const {randomUUID}=require('node:crypto');const instance=randomUUID();
const control=process.env.RELAY_PROTOCOL_CONTROL,log=process.env.RELAY_PROTOCOL_LOG;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),s=JSON.parse(fs.readFileSync(control,'utf8'));fs.appendFileSync(log,JSON.stringify({method:r.method,params:r.params})+'\\n');
 const info={protocolVersion:2,helperVersion:'mock',instanceId:instance,platform:process.platform,backend:s.mode==='windows'?'win32-wgc':s.mode==='macos'?'macos-screencapturekit':'fixture',coordinateSpace:s.mode==='windows'?'physical-pixels':'logical-points'};
 const window={id:'7',title:'Fixture',application:'test',applicationIdentity:{id:'test',kind:s.mode==='macos'?'bundle-id':'process-name',pid:s.pid},displayScale:s.displayScale??2,bounds:{x:-50,y:10,width:200,height:100},dpi:s.dpi??96};
 let result=true,error;
 if(r.method==='handshake') {if(s.mode==='hang')return;result={...info,...(s.mode==='bad-handshake'?{protocolVersion:3}:{})};}
 if(r.method==='capabilities')result={platform:process.platform,session:'fixture',capture:true,input:true,accessibility:false,directRecording:false,globalShortcuts:false,windows:[],reasons:[]};
 if(r.method==='listWindows')result=[window];
 if(r.method==='capture') {
  const cropped=s.mode==='crop';const backend=s.forceFallback?'win32-printwindow':r.params.captureBackend==='printwindow'?'win32-printwindow':info.backend;
  result={width:cropped?380:400,height:cropped?360:s.mode==='macos'?200:400,capturedAt:Date.now(),bounds:window.bounds,dataUrl:'data:image/png;base64,synthetic',native:{helperInstanceId:instance,backend,windowId:'7',geometry:{inputSpace:info.coordinateSpace,captureSpace:'pixels',boundsKind:'window',dpi:window.dpi,...(s.mode==='macos'?{displayScale:window.displayScale}:{}),...(cropped?{captureBounds:{x:-45,y:15,width:190,height:90}}:{}),pixelToInput:{scaleX:s.mode==='bad-scale'?2:0.5,scaleY:s.mode==='macos'?0.5:0.25,...(cropped?{offsetX:5,offsetY:5}:{})}}}};
 }

 if(r.method==='input')result=r.params;
 if(r.method==='focus')error={code:'PERMISSION_DENIED',message:'Input permission denied',operation:'focus',backend:'fixture',permission:'denied',retryable:false};
 process.stdout.write(s.mode==='malformed'?'null\\n':JSON.stringify({protocolVersion:2,id:r.id,...(error?{error}:{result})})+'\\n');
});`,
  );
  const adapter = new NativeAdapter({
    binaryPath: process.execPath,
    binaryArgs: [script],
    env: { RELAY_PROTOCOL_CONTROL: control, RELAY_PROTOCOL_LOG: log },
    timeoutMs: mode === "hang" ? 10000 : 2000,
  });
  resources.push({ directory, adapter });
  return { adapter, control, log };
}
const target: TargetDescriptor = {
  id: "fixture",
  name: "Fixture",
  kind: "desktop",
  windowTitle: "Fixture",
};
describe("native adapter protocol boundary", () => {
  it.each(["bad-handshake", "malformed"])(
    "rejects %s before sending desktop operations",
    async (mode) => {
      const { adapter, log } = await mock(mode);
      await expect(
        adapter.execute("click", { x: 20, y: 20 }, target),
      ).rejects.toThrow(/protocol|handshake|malformed/i);
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).method);
      expect(requests).not.toContain("input");
      expect(requests).not.toContain("listWindows");
    },
  );
  it("preserves permission diagnostics without confusing helper startup with capture success", async () => {
    const { adapter } = await mock();
    await expect(adapter.execute("focus", {}, target)).rejects.toMatchObject({
      details: {
        code: "PERMISSION_DENIED",
        operation: "focus",
        backend: "fixture",
        permission: "denied",
        retryable: false,
      },
    });
    const caps = await adapter.capabilities();
    expect(caps.native?.helper?.protocolVersion).toBe(2);
    expect(caps.native?.lastError?.code).toBe("PERMISSION_DENIED");
  });
  it("uses independent pixel-to-input scales and rejects a recycled handle's stale frame", async () => {
    const { adapter, control } = await mock();
    const frame = await adapter.capture(target);
    expect(frame.bounds?.x).toBe(-50);
    await expect(
      adapter.execute(
        "move",
        { x: 100, y: 100, toX: 200, toY: 200, frameId: frame.id },
        target,
      ),
    ).resolves.toMatchObject({ x: 50, y: 25, toX: 100, toY: 50 });
    await writeFile(control, JSON.stringify({ mode: "ok", pid: 2 }));
    await expect(
      adapter.execute("click", { x: 10, y: 10, frameId: frame.id }, target),
    ).rejects.toMatchObject({ details: { code: "STALE_CAPTURE" } });
  });
  it("rejects inconsistent transforms instead of producing usable coordinates", async () => {
    const { adapter } = await mock("bad-scale");
    await expect(adapter.capture(target)).rejects.toMatchObject({
      details: { code: "INVALID_REQUEST", operation: "capture" },
    });
  });
  it("applies visible-frame offsets once and preserves independent scales", async () => {
    const { adapter } = await mock("crop");
    const frame = await adapter.capture(target);
    await expect(
      adapter.execute(
        "move",
        { x: 100, y: 100, toX: 200, toY: 200, frameId: frame.id },
        target,
      ),
    ).resolves.toMatchObject({ x: 55, y: 30, toX: 105, toY: 55 });
  });
  it("requires an explicit Windows capture choice and rejects backend substitution", async () => {
    const { adapter, control, log } = await mock("windows");
    await expect(adapter.capture(target)).rejects.toThrow(
      "Choose a Windows capture method",
    );
    expect(await readFile(log, "utf8")).not.toContain('"method":"capture"');
    const configured = { ...target, windowsCaptureBackend: "wgc" as const };
    await adapter.capture(configured);
    await writeFile(
      control,
      JSON.stringify({ mode: "windows", pid: 1, forceFallback: true }),
    );
    await expect(adapter.capture(configured)).rejects.toMatchObject({
      details: { code: "INVALID_REQUEST" },
    });
    await expect(
      adapter.capture({ ...configured, windowsCaptureBackend: "printwindow" }),
    ).resolves.toMatchObject({ native: { backend: "win32-printwindow" } });
  });
  it("invalidates a frame when DPI or the selected capture method changes", async () => {
    const { adapter, control } = await mock("windows");
    const configured = { ...target, windowsCaptureBackend: "wgc" as const };
    const frame = await adapter.capture(configured);
    await writeFile(
      control,
      JSON.stringify({ mode: "windows", pid: 1, dpi: 144 }),
    );
    await expect(
      adapter.execute("click", { x: 20, y: 20, frameId: frame.id }, configured),
    ).rejects.toMatchObject({ details: { code: "STALE_CAPTURE" } });
    const next = await adapter.capture(configured);
    await expect(
      adapter.execute(
        "click",
        { x: 20, y: 20, frameId: next.id },
        { ...configured, windowsCaptureBackend: "printwindow" },
      ),
    ).rejects.toMatchObject({ details: { code: "STALE_CAPTURE" } });
  });
  it("does not release keyboard/mouse input after a passive capability probe", async () => {
    const { adapter, log } = await mock();
    await adapter.capabilities();
    await adapter.dispose();
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    expect(requests).toContain("releaseCapture");
    expect(requests).not.toContain("releaseKeys");
    expect(requests).not.toContain("releaseAll");
    expect(requests).not.toContain("input");
  });
  it("persists explicit Windows choices without choosing for existing targets", () => {
    expect(targetSchema.parse(target).windowsCaptureBackend).toBeUndefined();
    expect(
      targetSchema.parse({ ...target, windowsCaptureBackend: "printwindow" })
        .windowsCaptureBackend,
    ).toBe("printwindow");
    expect(() =>
      targetSchema.parse({ ...target, windowsCaptureBackend: "automatic" }),
    ).toThrow();
    expect(() =>
      targetSchema.parse({
        ...target,
        kind: "browser",
        windowsCaptureBackend: "wgc",
      }),
    ).toThrow();
  });
  it("maps Retina pixels to logical points and rejects a frame after a display-scale change", async () => {
    const { adapter, control } = await mock("macos");
    const frame = await adapter.capture(target);
    expect(frame.native?.application?.kind).toBe("bundle-id");
    expect(frame.native?.geometry.displayScale).toBe(2);
    await expect(
      adapter.execute("move", { x: 50, y: 30, frameId: frame.id }, target),
    ).resolves.toMatchObject({ x: 25, y: 15 });
    await writeFile(
      control,
      JSON.stringify({ mode: "macos", pid: 1, displayScale: 1 }),
    );
    await expect(
      adapter.execute("click", { x: 50, y: 30, frameId: frame.id }, target),
    ).rejects.toMatchObject({ details: { code: "STALE_CAPTURE" } });
  });
  it("cancels a stalled handshake without sending input", async () => {
    const { adapter, log } = await mock("hang");
    const abort = new AbortController();
    const rejected = expect(
      adapter.execute("click", { x: 10, y: 10 }, target, abort.signal),
    ).rejects.toThrow("Cancelled");
    try {
      // Wait for the actual stalled handshake rather than racing process startup.
      await expect
        .poll(() => readFile(log, "utf8").catch(() => ""), { timeout: 3000 })
        .toContain('"method":"handshake"');
    } finally {
      abort.abort();
      await rejected;
    }
    await adapter.releaseAll();
    const requests = await readFile(log, "utf8");
    expect(requests).not.toContain('"method":"input"');
  });
});

const binary = path.resolve(
  "native/target/debug",
  process.platform === "win32" ? "relay-native.exe" : "relay-native",
);
it.skipIf(!existsSync(binary))(
  "real helper rejects missing/future protocol versions and returns structured errors without desktop input",
  () => {
    const requests = [
      {
        id: "unnegotiated",
        protocolVersion: 2,
        method: "input",
        params: { kind: "click", x: 10, y: 10 },
      },
      { id: "hello", protocolVersion: 2, method: "handshake", params: {} },
      {
        id: "legacy",
        method: "launch",
        params: { command: "must-not-launch" },
      },
      {
        id: "future",
        protocolVersion: 3,
        method: "launch",
        params: { command: "must-not-launch" },
      },
      {
        id: "unknown",
        protocolVersion: 2,
        method: "unknown",
        params: { text: "must-not-leak" },
      },
    ];
    const result = spawnSync(binary, [], {
      input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.status).toBe(0);
    const replies = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      nativeHandshakeSchema.parse(replies[1].result).instanceId,
    ).toBeTruthy();
    expect(
      [replies[0], ...replies.slice(2, 4)].map(
        (r) => nativeErrorSchema.parse(r.error).code,
      ),
    ).toEqual(["PROTOCOL_MISMATCH", "PROTOCOL_MISMATCH", "PROTOCOL_MISMATCH"]);
    expect(nativeErrorSchema.parse(replies[4].error)).toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      operation: "unknown",
    });
    expect(result.stdout).not.toContain("must-not-leak");
  },
  30000,
);
