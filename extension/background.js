import { browserRuntime } from "./browser-runtime.js";
let running = false;
let recording;
let activeSignal;
const targets = new Map();
const attached = new Set();
const frameSessions = new Map();
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (
    method === "Runtime.bindingCalled" &&
    params.name === "relayBrowserRecord"
  ) {
    try {
      const message = JSON.parse(params.payload);
      if (
        recording?.active &&
        source.tabId === recording.tabId &&
        message.recordingId === recording.id
      )
        void call("/result", {
          action: message.action,
          recordingId: message.recordingId,
        }).catch(() => {});
    } catch {}
  }

  if (
    method === "Target.attachedToTarget" &&
    params.targetInfo.type === "iframe"
  ) {
    const sessions = frameSessions.get(source.tabId) ?? new Set();
    sessions.add(params.sessionId);
    frameSessions.set(source.tabId, sessions);
    void chrome.debugger
      .sendCommand(
        { tabId: source.tabId, sessionId: params.sessionId },
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      )
      .catch(() => {});
  } else if (method === "Target.detachedFromTarget")
    frameSessions.get(source.tabId)?.delete(params.sessionId);
});
const pressedKeys = new Map();
function modifierMask(tabId) {
  return [...(pressedKeys.get(tabId) || [])].reduce(
    (mask, key) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[key] || 0),
    0,
  );
}
chrome.debugger.onDetach.addListener((source) => {
  attached.delete(source.tabId);
  frameSessions.delete(source.tabId);
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settings() {
  return chrome.storage.local.get(["port", "token"]);
}
async function call(route, data, config) {
  const { port, token } = config || (await settings());
  if (!port || !token) throw new Error("Pair with Relay first");
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: data ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) throw new Error(`Relay bridge returned ${response.status}`);
  return response.json();
}
async function tabFor(target, create = false) {
  const bound = targets.get(target.id);
  if (bound) {
    try {
      return await chrome.tabs.get(bound);
    } catch {
      targets.delete(target.id);
    }
  }
  const tabs = (await chrome.tabs.query({})).filter((tab) =>
    /^https?:|^file:/.test(tab.url || ""),
  );
  let matches = tabs;
  if (target.url)
    matches = matches.filter((tab) => tab.url?.startsWith(target.url));
  if (target.windowTitle)
    matches = matches.filter((tab) => tab.title?.includes(target.windowTitle));
  if (!matches.length && create) {
    const tab = await chrome.tabs.create({ url: target.url || "about:blank" });
    targets.set(target.id, tab.id);
    return tab;
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "More than one tab matches; configure a URL or title"
        : "No browser tab matches the target",
    );
  targets.set(target.id, matches[0].id);
  return matches[0];
}
async function cdp(tabId, method, params = {}, sessionId) {
  if (
    activeSignal?.aborted &&
    !(method === "Input.dispatchKeyEvent" && params.type === "keyUp") &&
    !(method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")
  )
    throw new Error("Cancelled");
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      // A suspended worker can lose local bookkeeping while its debugger remains attached.
      try {
        await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
      } catch {
        throw error;
      }
      await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    }
    attached.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }
  if (method === "Input.dispatchMouseEvent" && params.modifiers === undefined)
    params = { ...params, modifiers: modifierMask(tabId) };
  return chrome.debugger.sendCommand(
    { tabId, ...(sessionId ? { sessionId } : {}) },
    method,
    params,
  );
}
async function evaluate(tabId, fn, args = []) {
  const response = await cdp(tabId, "Runtime.evaluate", {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text,
    );
  return response.result?.value;
}
async function frameContext(tabId, frameId) {
  let problem;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const sessionId of [undefined, ...(frameSessions.get(tabId) ?? [])]) {
      try {
        const world = await cdp(
          tabId,
          "Page.createIsolatedWorld",
          { frameId, worldName: "Relay locator inspection" },
          sessionId,
        );
        return { sessionId, contextId: world.executionContextId };
      } catch (error) {
        problem = error;
      }
    }
    await pause(25);
  }
  throw new Error(
    `The frame document is unavailable: ${problem?.message ?? "no execution context"}`,
  );
}
async function inContext(tabId, context, request, byValue = true) {
  const result = await cdp(
    tabId,
    "Runtime.evaluate",
    {
      expression: `(${browserRuntime.toString()})(${JSON.stringify(request)})`,
      contextId: context.contextId,
      returnByValue: byValue,
      awaitPromise: true,
    },
    context.sessionId,
  );
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  return byValue ? result.result?.value : result.result;
}
async function dom(tabId, operation, config = {}) {
  const tree = await cdp(tabId, "Page.getFrameTree");
  let context = await frameContext(tabId, tree.frameTree.frame.id),
    shadow = [],
    prefix = [];
  const owners = [];
  try {
    for (const [index, step] of (config.locator?.path ?? []).entries()) {
      if (step.kind === "shadow") {
        shadow.push(step);
        continue;
      }
      const remote = await inContext(
        tabId,
        context,
        {
          operation: "resolve",
          locator: { version: 1, selector: step.selector, path: shadow },
        },
        false,
      );
      if (!remote?.objectId)
        throw new Error("Frame locator did not identify an element");
      owners.push({ context, objectId: remote.objectId });
      const { node } = await cdp(
        tabId,
        "DOM.describeNode",
        { objectId: remote.objectId },
        context.sessionId,
      );
      if (!node.frameId)
        throw new Error("The frame path must identify an available iframe");
      context = await frameContext(tabId, node.frameId);
      prefix = config.locator.path.slice(0, index + 1);
      shadow = [];
    }
    const locator = config.locator
      ? { ...config.locator, path: shadow }
      : undefined;
    const result = await inContext(tabId, context, {
      operation,
      locator,
      selector: config.selector,
      text: config.text,
      value: config.value,
    });
    if (operation === "inspect" && result.element && prefix.length)
      result.element.locator.path = [
        ...prefix,
        ...(result.element.locator.path ?? []),
      ];
    if (operation === "inspect" && result.visible)
      for (const owner of owners) {
        const response = await cdp(
          tabId,
          "Runtime.callFunctionOn",
          {
            objectId: owner.objectId,
            functionDeclaration: `function(){return (${browserRuntime.toString()})({ operation: "visibility", element: this });}`,
            returnByValue: true,
          },
          owner.context.sessionId,
        );
        if (response.exceptionDetails)
          throw new Error(
            response.exceptionDetails.exception?.description ??
              response.exceptionDetails.text,
          );
        result.visible = result.visible && response.result.value;
      }
    if (operation === "point") {
      for (const owner of [...owners].reverse()) {
        const response = await cdp(
          tabId,
          "Runtime.callFunctionOn",
          {
            objectId: owner.objectId,
            functionDeclaration: `function(){ return (${browserRuntime.toString()})({ operation: "frameGeometry", element: this }); }`,
            returnByValue: true,
          },
          owner.context.sessionId,
        );
        if (response.exceptionDetails)
          throw new Error(
            response.exceptionDetails.exception?.description ??
              response.exceptionDetails.text,
          );
        const geometry = response.result.value;
        result.x = geometry.x + result.x * geometry.scaleX;
        result.y = geometry.y + result.y * geometry.scaleY;
        const verified = await cdp(
          tabId,
          "Runtime.callFunctionOn",
          {
            objectId: owner.objectId,
            functionDeclaration: `function(){return (${browserRuntime.toString()})({ operation: "verifyPoint", element: this, x: ${result.x}, y: ${result.y} });}`,
            returnByValue: true,
          },
          owner.context.sessionId,
        );
        if (verified.exceptionDetails)
          throw new Error(
            verified.exceptionDetails.exception?.description ??
              verified.exceptionDetails.text,
          );
      }
    }
    return result;
  } finally {
    await Promise.all(
      owners.map((owner) =>
        cdp(
          tabId,
          "Runtime.releaseObject",
          { objectId: owner.objectId },
          owner.context.sessionId,
        ).catch(() => {}),
      ),
    );
  }
}
async function point(tabId, config) {
  if (!config.selector && !config.locator)
    return { x: Number(config.x || 0), y: Number(config.y || 0) };
  return dom(tabId, "point", config);
}
async function key(tabId, config) {
  const aliases = {
    ctrl: "Control",
    control: "Control",
    command: "Meta",
    meta: "Meta",
    super: "Meta",
    alt: "Alt",
    shift: "Shift",
    return: "Enter",
    enter: "Enter",
    escape: "Escape",
    esc: "Escape",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    space: "Space",
  };
  const names = String(config.key || "")
    .split("+")
    .map((value) => aliases[value.toLowerCase()] || value);
  const codes = {
    Control: 17,
    Shift: 16,
    Alt: 18,
    Meta: 91,
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  };
  const keys = names.map((name) => {
    const vk =
      codes[name] ||
      (/^F([1-9]|1[0-2])$/.test(name)
        ? 111 + Number(name.slice(1))
        : name.length === 1
          ? name.toUpperCase().charCodeAt(0)
          : undefined);
    if (!vk) throw new Error(`Unsupported key: ${name}`);
    return { name, vk };
  });
  let held = pressedKeys.get(tabId);
  if (!held) {
    held = new Set();
    pressedKeys.set(tabId, held);
  }
  try {
    if (config.action !== "up")
      for (const { name, vk } of keys) {
        held.add(name);
        const modifiers = modifierMask(tabId);
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: name,
          windowsVirtualKeyCode: vk,
          modifiers,
          ...(name.length === 1 && !modifiers ? { text: name } : {}),
        });
      }
    if (
      config.action !== "down" &&
      config.action !== "up" &&
      Number(config.durationMs) > 0
    ) {
      const deadline = Date.now() + Math.min(120000, Number(config.durationMs));
      while (Date.now() < deadline) {
        if (activeSignal?.aborted) throw new Error("Cancelled");
        await pause(Math.min(25, deadline - Date.now()));
      }
    }
  } finally {
    if (config.action !== "down" || activeSignal?.aborted)
      for (const { name, vk } of keys.reverse()) {
        held.delete(name);
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: name,
          windowsVirtualKeyCode: vk,
          modifiers: modifierMask(tabId),
        });
      }
  }
}
async function allFrames(tabId) {
  const frames = new Map();
  const visit = (tree, parentId) => {
    const prior = frames.get(tree.frame.id);
    frames.set(tree.frame.id, {
      id: tree.frame.id,
      parentId: tree.frame.parentId ?? parentId ?? prior?.parentId,
    });
    for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
  };
  visit((await cdp(tabId, "Page.getFrameTree")).frameTree);
  for (const sessionId of frameSessions.get(tabId) ?? []) {
    try {
      visit((await cdp(tabId, "Page.getFrameTree", {}, sessionId)).frameTree);
    } catch {}
  }
  return frames;
}
async function ownerPath(tabId, frame, frames) {
  if (!frame.parentId) return [];
  const parent = frames.get(frame.parentId);
  if (!parent) throw new Error("The parent frame is unavailable");
  const context = await frameContext(tabId, parent.id);
  const owner = await cdp(
    tabId,
    "DOM.getFrameOwner",
    { frameId: frame.id },
    context.sessionId,
  );
  const { object } = await cdp(
    tabId,
    "DOM.resolveNode",
    {
      backendNodeId: owner.backendNodeId,
      executionContextId: context.contextId,
    },
    context.sessionId,
  );
  try {
    const response = await cdp(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function(){return (${browserRuntime.toString()})({ operation: "describe", element: this });}`,
        returnByValue: true,
      },
      context.sessionId,
    );
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    const locator = response.result.value;
    return [
      ...(await ownerPath(tabId, parent, frames)),
      ...(locator.path ?? []),
      { kind: "frame", selector: locator.selector },
    ];
  } finally {
    await cdp(
      tabId,
      "Runtime.releaseObject",
      { objectId: object.objectId },
      context.sessionId,
    ).catch(() => {});
  }
}
async function record(tabId, recordingId, expectedRecordingId) {
  const frames = await allFrames(tabId);
  for (const frame of frames.values()) {
    const context = await frameContext(tabId, frame.id);
    if (recordingId)
      await cdp(
        tabId,
        "Runtime.addBinding",
        { name: "relayBrowserRecord", executionContextId: context.contextId },
        context.sessionId,
      );
    const basePath = recordingId ? await ownerPath(tabId, frame, frames) : [];
    await inContext(tabId, context, {
      operation: "record",
      recordingId,
      expectedRecordingId,
      transport: "binding",
      basePath,
      singleDocument: true,
    });
  }
}
async function installRecording(current) {
  if (recording !== current || !current.active) return;
  const operation = (async () => {
    await record(current.tabId, current.id);
    if (recording !== current || !current.active)
      await record(current.tabId, null);
  })();
  current.pending.add(operation);
  try {
    await operation;
  } finally {
    current.pending.delete(operation);
  }
}
async function stopRecording(recordingId) {
  let current = recording;
  if (!current) {
    const { relayRecording } =
      await chrome.storage.session.get("relayRecording");
    if (!relayRecording) {
      if (recordingId)
        throw new Error(
          "The recorded tab could not be established for cleanup",
        );
      return true;
    }
    if (recordingId && relayRecording.id !== recordingId)
      throw new Error("Recording session has changed");
    if (relayRecording.stopped) return true;
    // The service worker can restart while an isolated-world listener survives.
    // Resume only its cleanup ownership; capture never restarts implicitly.
    current = recording = {
      ...relayRecording,
      active: false,
      pending: new Set(),
    };
  }
  if (recordingId && current.id !== recordingId)
    throw new Error("Recording session has changed");
  current.active = false;
  await Promise.allSettled([...current.pending]);
  const tab = await chrome.tabs.get(current.tabId).catch(() => null);
  if (tab) await record(current.tabId, null, current.id);
  await chrome.storage.session.set({
    relayRecording: { id: current.id, tabId: current.tabId, stopped: true },
  });
  if (recording === current) recording = undefined;
  return true;
}
async function command(command) {
  const { method, target, kind, config = {} } = command;
  if (method === "recordStop") return stopRecording(config.recordingId);
  const tab = await tabFor(target, kind === "launch");
  const tabId = tab.id;
  if (method === "inspectLocator") return dom(tabId, "inspect", config);
  if (method === "releaseInputs") {
    for (const name of config.keys || [])
      await key(tabId, { key: name, action: "up" });
    return true;
  }
  if (method === "recordStart") {
    if (typeof config.recordingId !== "string" || !config.recordingId)
      throw new Error("Recording session token is required");
    await stopRecording();
    const current = {
      id: config.recordingId,
      tabId,
      active: true,
      pending: new Set(),
    };
    recording = current;
    try {
      // Save the exact owner before installing any listener. URL matching is
      // insufficient after navigation or a service-worker restart.
      await chrome.storage.session.set({
        relayRecording: { id: current.id, tabId, stopped: false },
      });
      await installRecording(current);
      return true;
    } catch (error) {
      current.active = false;
      await stopRecording(current.id);
      throw error;
    }
  }
  if (method === "capture" || kind === "screenshot") {
    const result = await cdp(tabId, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Uint8Array.from(atob(result.data.slice(0, 40)), (character) =>
      character.charCodeAt(0),
    );
    const view = new DataView(bytes.buffer);
    const viewport = await evaluate(tabId, () => ({
      width: innerWidth,
      height: innerHeight,
    }));
    return {
      id: crypto.randomUUID(),
      targetId: target.id,
      capturedAt: Date.now(),
      width: view.getUint32(16),
      height: view.getUint32(20),
      scale: view.getUint32(16) / viewport.width,
      dataUrl: `data:image/png;base64,${result.data}`,
    };
  }
  switch (kind) {
    case "launch":
    case "navigate":
      await chrome.tabs.update(tabId, {
        url: String(config.url || target.url || "about:blank"),
      });
      return true;
    case "attach":
      return { tabId, url: tab.url, title: tab.title };
    case "focus":
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return true;
    case "close":
      await chrome.tabs.remove(tabId);
      targets.delete(target.id);
      return true;
    case "click":
    case "move":
    case "drag": {
      const start = await point(tabId, config);
      const button = config.button || "left";
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...start,
      });
      if (kind === "move") return true;
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...start,
        button,
        clickCount: Number(config.clickCount || 1),
      });
      let end = start;
      try {
        if (kind === "drag") {
          end = { x: Number(config.toX), y: Number(config.toY) };
          await cdp(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...end,
            button,
            buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
          });
        }
      } finally {
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...end,
          button,
          clickCount: Number(config.clickCount || 1),
        });
      }
      return true;
    }
    case "scroll": {
      const position = await point(tabId, config);
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...position,
        deltaX: Number(config.deltaX || 0),
        deltaY: Number(config.deltaY || 0),
      });
      return true;
    }
    case "type":
      if (!config.selector && !config.locator) {
        await cdp(tabId, "Input.insertText", {
          text: String(config.text ?? ""),
        });
        return true;
      }
      return dom(tabId, "type", config);
    case "key":
      if (config.selector || config.locator) await dom(tabId, "focus", config);
      await key(tabId, config);
      return true;
    case "read":
      return dom(tabId, "read", config);
    case "detect":
      if (!config.selector && !config.locator)
        throw new Error("Element detection requires a browser locator");
      return dom(tabId, "detect", {
        ...config,
        text: config.text ?? config.prompt,
      });
    case "select": {
      const values = await dom(tabId, "select", config);
      return config.locator ? values : values[0];
    }
    case "tab":
      if (config.action === "new") {
        const next = await chrome.tabs.create({
          url: String(config.url || "about:blank"),
        });
        targets.set(target.id, next.id);
        return { tabId: next.id };
      }
      if (config.action === "close") {
        await chrome.tabs.remove(tabId);
        targets.delete(target.id);
        return true;
      }
      targets.delete(target.id);
      return {
        tabId: (await tabFor({ ...target, url: config.url || target.url })).id,
      };
    default:
      throw new Error(`Unsupported browser action: ${kind}`);
  }
}
async function executeCommand(value, config) {
  const abort = new AbortController();
  activeSignal = abort.signal;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (
        (
          await call(
            `/cancelled?id=${encodeURIComponent(value.id)}`,
            undefined,
            config,
          )
        ).cancelled
      )
        abort.abort();
    } catch {
      abort.abort();
    } finally {
      checking = false;
    }
  }, 100);
  try {
    return await command(value);
  } finally {
    clearInterval(timer);
    activeSignal = undefined;
  }
}
async function poll() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const config = await settings();
      if (!config.port || !config.token) break;
      try {
        const response = await call("/next", undefined, config);
        await chrome.storage.local.set({ status: "Connected" });
        if (response.command) {
          try {
            await call(
              "/result",
              {
                id: response.command.id,
                result: await executeCommand(response.command, config),
              },
              config,
            );
          } catch (error) {
            await call(
              "/result",
              { id: response.command.id, error: error.message },
              config,
            );
          }
        }
      } catch (error) {
        await chrome.storage.local.set({ status: error.message });
        await pause(3000);
      }
    }
  } finally {
    running = false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "pair") {
    void poll();
    respond({ ok: true });
  }
  if (
    message.type === "recorded" &&
    recording?.active &&
    sender.tab?.id === recording.tabId &&
    message.recordingId === recording.id
  ) {
    void call("/result", {
      action: message.action,
      recordingId: message.recordingId,
    }).catch(() => {});
    respond({ ok: true });
  }
});
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  const current = recording;
  if (current?.active && tabId === current.tabId)
    void installRecording(current).catch(() => {});
});
chrome.alarms.create("relay-connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  void poll();
});
void poll();
