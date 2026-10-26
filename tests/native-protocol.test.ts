import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
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
 const info={protocolVersion:1,helperVersion:'mock',instanceId:instance,platform:process.platform,backend:'fixture',coordinateSpace:'logical-points'};
 const window={id:'7',title:'Fixture',application:'test',applicationIdentity:{id:'test',kind:'process-name',pid:s.pid},bounds:{x:-50,y:10,width:200,height:100}};
 let result=true,error;
 if(r.method==='handshake') {if(s.mode==='hang')return;result={...info,...(s.mode==='bad-handshake'?{protocolVersion:2}:{})};}
 if(r.method==='capabilities')result={platform:process.platform,session:'fixture',capture:true,input:true,accessibility:false,directRecording:false,globalShortcuts:false,windows:[],reasons:[]};
 if(r.method==='listWindows')result=[window];
 if(r.method==='capture')result={width:400,height:400,capturedAt:Date.now(),bounds:window.bounds,dataUrl:'data:image/png;base64,synthetic',native:{helperInstanceId:instance,backend:'fixture',windowId:'7',geometry:{inputSpace:'logical-points',captureSpace:'pixels',boundsKind:'window',pixelToInput:{scaleX:s.mode==='bad-scale'?2:0.5,scaleY:0.25}}}};
 if(r.method==='input')result=r.params;
 if(r.method==='focus')error={code:'PERMISSION_DENIED',message:'Input permission denied',operation:'focus',backend:'fixture',permission:'denied',retryable:false};
 process.stdout.write(s.mode==='malformed'?'null\\n':JSON.stringify({protocolVersion:1,id:r.id,...(error?{error}:{result})})+'\\n');
});`,
  );
  const adapter = new NativeAdapter({
    binaryPath: process.execPath,
    binaryArgs: [script],
    env: { RELAY_PROTOCOL_CONTROL: control, RELAY_PROTOCOL_LOG: log },
    timeoutMs: 2000,
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
    expect(caps.native?.helper?.protocolVersion).toBe(1);
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
  it("cancels a stalled handshake without sending input", async () => {
    const { adapter, log } = await mock("hang");
    await expect(
      adapter.execute(
        "click",
        { x: 10, y: 10 },
        target,
        AbortSignal.timeout(100),
      ),
    ).rejects.toThrow("Cancelled");
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
        protocolVersion: 1,
        method: "input",
        params: { kind: "click", x: 10, y: 10 },
      },
      { id: "hello", protocolVersion: 1, method: "handshake", params: {} },
      {
        id: "legacy",
        method: "launch",
        params: { command: "must-not-launch" },
      },
      {
        id: "future",
        protocolVersion: 2,
        method: "launch",
        params: { command: "must-not-launch" },
      },
      {
        id: "unknown",
        protocolVersion: 1,
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
