let running = false;
let recording;
let activeSignal;
const targets = new Map();
const attached = new Set();
const pressedKeys = new Map();
function modifierMask(tabId) {
  return [...(pressedKeys.get(tabId) || [])].reduce(
    (mask, key) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[key] || 0),
    0,
  );
}
chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));
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
async function cdp(tabId, method, params = {}) {
  if (
    activeSignal?.aborted &&
    !(method === "Input.dispatchKeyEvent" && params.type === "keyUp") &&
    !(method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")
  )
    throw new Error("Cancelled");
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.add(tabId);
  }
  if (method === "Input.dispatchMouseEvent" && params.modifiers === undefined)
    params = { ...params, modifiers: modifierMask(tabId) };
  return chrome.debugger.sendCommand({ tabId }, method, params);
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
async function point(tabId, config) {
  if (!config.selector)
    return { x: Number(config.x || 0), y: Number(config.y || 0) };
  return evaluate(
    tabId,
    (selector) => {
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1)
        throw new Error(`Selector matched ${matches.length} elements`);
      const element = matches[0];
      element.scrollIntoView({ block: "center", inline: "center" });
      const r = element.getBoundingClientRect();
      if (!r.width || !r.height) throw new Error("Element is not visible");
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    [config.selector],
  );
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
async function record(tabId, recordingId, expectedRecordingId) {
  if (recordingId)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["recorder.js"],
    });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (value, expected) => {
      if (
        !value &&
        expected &&
        window.__relayRecorder &&
        window.__relayRecorder.recordingId !== expected
      )
        throw new Error("Recording session has changed in the target tab");
      window.__relaySetRecording?.(value);
    },
    args: [recordingId, expectedRecordingId ?? null],
  });
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
    case "scroll":
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number(config.x || 0),
        y: Number(config.y || 0),
        deltaX: Number(config.deltaX || 0),
        deltaY: Number(config.deltaY || 0),
      });
      return true;
    case "type":
      if (!config.selector) {
        await cdp(tabId, "Input.insertText", {
          text: String(config.text || ""),
        });
        return true;
      }
      return evaluate(
        tabId,
        (selector, text) => {
          const matches = document.querySelectorAll(selector);
          if (matches.length !== 1)
            throw new Error("Input selector is missing or ambiguous");
          const element = matches[0];
          element.focus();
          const prototype =
            element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(
            prototype,
            "value",
          )?.set;
          if (!setter) throw new Error("Element is not a text input");
          setter.call(element, text);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        [config.selector, String(config.text || "")],
      );
    case "key":
      if (config.selector)
        await evaluate(
          tabId,
          (selector) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error("Element not found");
            element.focus();
          },
          [config.selector],
        );
      await key(tabId, config);
      return true;
    case "read":
      return evaluate(
        tabId,
        (selector) => {
          const element = document.querySelector(selector || "body");
          if (!element) throw new Error("Element not found");
          return element.innerText;
        },
        [config.selector],
      );
    case "detect": {
      if (!config.selector)
        throw new Error("Element detection requires a selector");
      return evaluate(
        tabId,
        (selector, text) => {
          const matches = document.querySelectorAll(selector);
          if (matches.length > 1)
            return {
              outcome: "uncertain",
              evidence: `${matches.length} elements match; use a more specific selector`,
            };
          const element = matches[0],
            rect = element?.getBoundingClientRect(),
            style = element && getComputedStyle(element);
          const present = Boolean(
            element &&
            rect.width &&
            rect.height &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse",
          );
          const value = present ? element.innerText || "" : "";
          return {
            outcome:
              present && (typeof text !== "string" || value.includes(text))
                ? "match"
                : "no-match",
            confidence: 1,
            value,
            evidence: present
              ? "Element is visible"
              : "No visible element matches",
          };
        },
        [config.selector, config.text ?? config.prompt],
      );
    }
    case "select":
      return evaluate(
        tabId,
        (selector, value) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLSelectElement))
            throw new Error("Select element not found");
          element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return element.value;
        },
        [config.selector, config.value],
      );
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
  if (frameId === 0 && current?.active && tabId === current.tabId)
    void installRecording(current).catch(() => {});
});
chrome.alarms.create("relay-connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  void poll();
});
void poll();
