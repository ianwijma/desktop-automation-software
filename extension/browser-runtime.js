/** Shared, self-contained DOM runtime. Serialized unchanged into either browser. */
export function browserRuntime(request) {
  const normalize = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const rootElements = (root) => {
    const result = [];
    for (const element of root.querySelectorAll("*")) {
      result.push(element);
      if (element.shadowRoot) result.push(...rootElements(element.shadowRoot));
    }
    return result;
  };
  const text = (element) => {
    if (!element) return "";
    const copy = element.cloneNode(true);
    for (const child of copy.querySelectorAll(
      'script,style,template,[aria-hidden="true"],input,textarea,select',
    ))
      child.remove();
    return normalize(copy.textContent);
  };
  const role = (element) => {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === "input")
      return (
        {
          checkbox: "checkbox",
          radio: "radio",
          range: "slider",
          number: "spinbutton",
          search: "searchbox",
          button: "button",
          submit: "button",
          reset: "button",
          hidden: "",
          password: "",
        }[element.type] ?? "textbox"
      );
    if (tag === "select")
      return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (tag === "a") return element.hasAttribute("href") ? "link" : "";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return (
      {
        button: "button",
        textarea: "textbox",
        img: "img",
        option: "option",
        table: "table",
        tr: "row",
        th: "columnheader",
        td: "cell",
        ul: "list",
        ol: "list",
        li: "listitem",
        progress: "progressbar",
        dialog: "dialog",
      }[tag] ?? ""
    );
  };
  const name = (element) => {
    const root = element.getRootNode();
    const labelled = element.getAttribute("aria-labelledby");
    if (labelled) {
      const value = normalize(
        labelled
          .trim()
          .split(/\s+/)
          .map((id) => text(root.getElementById?.(id)))
          .join(" "),
      );
      if (value) return value;
    }
    if (element.hasAttribute("aria-label"))
      return normalize(element.getAttribute("aria-label"));
    if (element.labels?.length)
      return normalize([...element.labels].map(text).join(" "));
    if (element.localName === "img")
      return normalize(element.getAttribute("alt"));
    if (
      element.localName === "input" &&
      ["button", "submit", "reset"].includes(element.type)
    )
      return normalize(
        element.value || { submit: "Submit", reset: "Reset" }[element.type],
      );
    if (
      [
        "button",
        "link",
        "heading",
        "option",
        "tab",
        "menuitem",
        "checkbox",
        "radio",
        "tooltip",
      ].includes(role(element))
    )
      return text(element) || normalize(element.getAttribute("title"));
    return normalize(element.getAttribute("title"));
  };
  const query = (root, selector) => {
    if (!selector || typeof selector !== "object")
      throw new Error("A browser selector is required");
    const all = rootElements(root);
    if (selector.kind === "css") {
      const roots = [
        root,
        ...all
          .filter((element) => element.shadowRoot)
          .map((element) => element.shadowRoot),
      ];
      try {
        return [
          ...new Set(
            roots.flatMap((scope) => [
              ...scope.querySelectorAll(selector.value),
            ]),
          ),
        ];
      } catch {
        throw new Error("The CSS selector is invalid");
      }
    }
    if (selector.kind === "id")
      return all.filter((element) => element.id === selector.value);
    if (selector.kind === "testId")
      return all.filter(
        (element) =>
          element.getAttribute(selector.attribute || "data-testid") ===
          selector.value,
      );
    if (selector.kind === "role")
      return all.filter(
        (element) =>
          role(element) === selector.role &&
          (selector.name === undefined ||
            name(element) === normalize(selector.name)),
      );
    if (selector.kind === "label")
      return all.filter((element) => {
        if (
          ![
            "input",
            "textarea",
            "select",
            "button",
            "meter",
            "output",
            "progress",
          ].includes(element.localName)
        )
          return false;
        const labels = [...(element.labels ?? [])].map(text);
        return (
          labels.some((label) => label === normalize(selector.value)) ||
          ((element.hasAttribute("aria-label") ||
            element.hasAttribute("aria-labelledby")) &&
            name(element) === normalize(selector.value))
        );
      });
    throw new Error("Unsupported browser selector strategy");
  };
  const only = (matches) => {
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Browser locator is ambiguous: ${matches.length} elements match`
          : "Browser locator is missing: no element matches",
      );
    return matches[0];
  };
  const scopeFor = (locator) => {
    let root = document;
    for (const step of locator.path ?? []) {
      const element = only(query(root, step.selector));
      if (step.kind === "shadow") {
        if (!element.shadowRoot)
          throw new Error("The selected shadow root is unavailable or closed");
        root = element.shadowRoot;
      } else if (step.kind === "frame") {
        if (!["iframe", "frame"].includes(element.localName))
          throw new Error("The frame path must identify an iframe");
        if (!element.contentDocument)
          throw new Error("The frame document is unavailable or cross-origin");
        root = element.contentDocument;
      } else throw new Error("Unsupported browser scope");
    }
    return root;
  };
  const selectorFor = (element, root) => {
    const candidates = [];
    for (const attribute of ["data-testid", "data-test", "data-qa", "data-cy"])
      if (element.getAttribute(attribute))
        candidates.push({
          kind: "testId",
          attribute,
          value: element.getAttribute(attribute),
        });
    const elementRole = role(element),
      elementName = name(element);
    if (elementRole && elementName)
      candidates.push({ kind: "role", role: elementRole, name: elementName });
    if (
      element.labels?.length ||
      element.hasAttribute("aria-label") ||
      element.hasAttribute("aria-labelledby")
    )
      candidates.push({ kind: "label", value: elementName });
    if (element.id) candidates.push({ kind: "id", value: element.id });
    for (const candidate of candidates) {
      const matches = query(root, candidate);
      if (matches.length === 1 && matches[0] === element) return candidate;
    }
    const parts = [];
    let current = element;
    while (current && current !== root) {
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (child) => child.localName === current.localName,
          )
        : [...root.children].filter(
            (child) => child.localName === current.localName,
          );
      parts.unshift(
        `${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`,
      );
      const value = parts.join(" > ");
      const candidate = { kind: "css", value };
      if (
        query(root, candidate).length === 1 &&
        query(root, candidate)[0] === element
      )
        return candidate;
      current = current.parentElement;
    }
    throw new Error(
      "A unique locator could not be generated; configure this step manually",
    );
  };
  const describe = (element, parentPath = []) => {
    const path = [...parentPath];
    const shadows = [];
    let root = element.getRootNode();
    while (root.host) {
      shadows.unshift({
        kind: "shadow",
        selector: selectorFor(root.host, root.host.getRootNode()),
      });
      root = root.host.getRootNode();
    }
    path.push(...shadows);
    return {
      version: 1,
      selector: selectorFor(element, element.getRootNode()),
      ...(path.length ? { path } : {}),
    };
  };
  const visible = (element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return Boolean(
      element.getClientRects().length &&
      style.display !== "none" &&
      !["hidden", "collapse"].includes(style.visibility),
    );
  };
  const verifyPoint = (element, x, y) => {
    let hit = element.ownerDocument.elementFromPoint(x, y);
    while (hit?.shadowRoot?.elementFromPoint(x, y)) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (inner === hit) break;
      hit = inner;
    }
    let current = hit;
    while (current) {
      if (current === element || element.contains(current)) return true;
      current = current.getRootNode()?.host;
    }
    throw new Error("The matched element is obscured; no input was sent");
  };
  const point = (element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    if (!visible(element))
      throw new Error("The matched element is not visible");
    const rect = element.getBoundingClientRect();
    let x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    verifyPoint(element, x, y);
    let view = element.ownerDocument.defaultView;
    while (view !== window) {
      const frame = view.frameElement;
      if (!frame)
        throw new Error("The frame coordinate mapping is unavailable");
      const bounds = frame.getBoundingClientRect();
      const sx = bounds.width / frame.offsetWidth,
        sy = bounds.height / frame.offsetHeight;
      x = bounds.x + (frame.clientLeft + x) * sx;
      y = bounds.y + (frame.clientTop + y) * sy;
      view = frame.ownerDocument.defaultView;
    }
    return { x, y };
  };
  if (request.operation === "record") {
    const previous = window.__relayRecorder;
    if (
      !request.recordingId &&
      request.expectedRecordingId &&
      previous &&
      previous.recordingId !== request.expectedRecordingId
    )
      throw new Error("Recording session has changed in the target tab");
    previous?.stop();
    delete window.__relayRecorder;
    if (!request.recordingId) return true;
    const listeners = new AbortController(),
      documents = new WeakSet(),
      roots = new WeakSet(),
      frames = new WeakSet(),
      handled = new WeakSet(),
      observers = [];
    const send = (kind, label, config) => {
      if (listeners.signal.aborted) return;
      const action = {
        id: crypto.randomUUID(),
        at: Date.now(),
        kind,
        label: label.slice(0, 200),
        config,
      };
      if (request.transport === "binding")
        window.relayBrowserRecord(
          JSON.stringify({ recordingId: request.recordingId, action }),
        );
      else if (request.transport === "extension")
        chrome.runtime
          .sendMessage({
            type: "recorded",
            recordingId: request.recordingId,
            action,
          })
          .catch(() => {});
      else
        void window.relayRecordEvent?.({
          ...action,
          recordingId: request.recordingId,
        });
    };
    const install = (doc, path) => {
      const attach = (root) => {
        if (roots.has(root)) return;
        roots.add(root);
        const handler = (event) => {
          if (!event.isTrusted || handled.has(event)) return;
          handled.add(event);
          let element = event.composedPath()[0];
          if (element?.nodeType !== 1) return;
          element =
            element.closest('button,a,input,select,textarea,[role="button"]') ??
            element;
          if (event.type === "keydown") {
            if (["Enter", "Tab", "Escape"].includes(event.key))
              send("key", `Press ${event.key}`, {
                key: event.key,
                locator: describe(element, path),
              });
          } else if (event.type === "click")
            send(
              "click",
              `Click ${(name(element) || element.localName).slice(0, 40)}`,
              { locator: describe(element, path), button: "left" },
            );
          else if (element.localName === "select")
            send("select", "Select option", {
              locator: describe(element, path),
              value: element.value,
            });
          else if (["input", "textarea"].includes(element.localName)) {
            if (["checkbox", "radio", "hidden"].includes(element.type)) return;
            const secret = element.type === "password";
            send(
              "type",
              secret ? "Enter password (configure value)" : "Type text",
              {
                locator: describe(element, path),
                text: secret ? "" : element.value,
                ...(secret ? { secret: true } : {}),
              },
            );
          }
        };
        for (const type of ["click", "change", "keydown"])
          root.addEventListener(type, handler, {
            capture: true,
            signal: listeners.signal,
          });
        const observer = new MutationObserver(() => scan(doc, path));
        observer.observe(root, { childList: true, subtree: true });
        observers.push(observer);
      };
      if (!documents.has(doc)) {
        documents.add(doc);
        attach(doc);
      }
      for (const element of rootElements(doc)) {
        if (element.shadowRoot) attach(element.shadowRoot);
        if (
          !request.singleDocument &&
          ["iframe", "frame"].includes(element.localName)
        ) {
          const childPath = [
            ...path,
            ...(describe(element).path ?? []),
            {
              kind: "frame",
              selector: selectorFor(element, element.getRootNode()),
            },
          ];
          if (!frames.has(element)) {
            frames.add(element);
            element.addEventListener("load", () => scan(doc, path), {
              signal: listeners.signal,
            });
          }
          if (element.contentDocument)
            install(element.contentDocument, childPath);
        }
      }
    };
    const scan = (doc, path) => {
      if (!listeners.signal.aborted) install(doc, path);
    };
    scan(document, request.basePath ?? []);
    const timer = setInterval(
      () => scan(document, request.basePath ?? []),
      500,
    );
    window.__relayRecorder = {
      recordingId: request.recordingId,
      stop: () => {
        listeners.abort();
        clearInterval(timer);
        observers.forEach((observer) => observer.disconnect());
      },
    };
    return true;
  }
  const locator = request.locator ?? {
    version: 1,
    selector: { kind: "css", value: request.selector || "body" },
  };
  const root = scopeFor(locator),
    matches = request.element
      ? [request.element]
      : query(root, locator.selector);
  if (request.operation === "inspect") {
    const element = matches.length === 1 ? matches[0] : undefined;
    const lastFrame = (locator.path ?? []).findLastIndex(
      (step) => step.kind === "frame",
    );
    return {
      status:
        matches.length === 1
          ? "unique"
          : matches.length
            ? "ambiguous"
            : "missing",
      count: matches.length,
      ...(element
        ? {
            visible: visible(element),
            element: {
              tag: element.localName,
              role: role(element),
              name: name(element).slice(0, 200),
              id: element.id,
              locator: describe(
                element,
                (locator.path ?? []).slice(0, lastFrame + 1),
              ),
            },
          }
        : {}),
    };
  }
  if (request.operation === "detect") {
    if (matches.length > 1)
      return {
        outcome: "uncertain",
        evidence: `${matches.length} elements match; use a more specific locator`,
      };
    const element = matches[0],
      present = element && visible(element),
      value = present ? (element.innerText ?? element.textContent ?? "") : "";
    return {
      outcome:
        present &&
        (typeof request.text !== "string" || value.includes(request.text))
          ? "match"
          : "no-match",
      confidence: 1,
      value,
      evidence: present ? "Element is visible" : "No visible element matches",
    };
  }
  const element = only(matches);
  if (request.operation === "describe") return describe(element);
  if (request.operation === "visibility") return visible(element);
  if (request.operation === "verifyPoint")
    return verifyPoint(element, request.x, request.y);
  if (request.operation === "resolve") return element;
  if (request.operation === "frameGeometry") {
    element.scrollIntoView({ block: "center", inline: "center" });
    if (!visible(element)) throw new Error("The frame is not visible");
    const view = element.ownerDocument.defaultView,
      transform = view.getComputedStyle(element).transform;
    if (transform !== "none") {
      const matrix = new view.DOMMatrixReadOnly(transform);
      if (
        matrix.b ||
        matrix.c ||
        !matrix.is2D ||
        matrix.a <= 0 ||
        matrix.d <= 0
      )
        throw new Error(
          "Rotated or mirrored frame coordinates are unsupported",
        );
    }
    const bounds = element.getBoundingClientRect();
    const scaleX = bounds.width / element.offsetWidth,
      scaleY = bounds.height / element.offsetHeight;
    if (
      !Number.isFinite(scaleX) ||
      !Number.isFinite(scaleY) ||
      scaleX <= 0 ||
      scaleY <= 0
    )
      throw new Error("Frame geometry is unavailable");
    return {
      x: bounds.x + element.clientLeft * scaleX,
      y: bounds.y + element.clientTop * scaleY,
      scaleX,
      scaleY,
    };
  }
  if (request.operation === "point") return point(element);
  if (request.operation === "read")
    return element.innerText ?? element.textContent ?? "";
  if (request.operation === "focus") {
    if (!visible(element) || element.matches(":disabled"))
      throw new Error("The matched element cannot receive focus");
    element.focus();
    const active = element.getRootNode().activeElement;
    if (active !== element && !element.contains(active))
      throw new Error("The matched element cannot receive focus");
    return true;
  }
  if (request.operation === "type") {
    if (!visible(element) || element.matches(":disabled") || element.readOnly)
      throw new Error("The matched element is not editable");
    const view = element.ownerDocument.defaultView;
    if (element.isContentEditable) {
      element.focus();
      element.textContent = String(request.text ?? "");
    } else {
      const prototype =
        element.localName === "textarea"
          ? view.HTMLTextAreaElement.prototype
          : element.localName === "input"
            ? view.HTMLInputElement.prototype
            : null;
      const setter =
        prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new Error("The matched element is not a text input");
      element.focus();
      setter.call(element, String(request.text ?? ""));
    }
    element.dispatchEvent(
      new view.Event("input", { bubbles: true, composed: true }),
    );
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    return true;
  }
  if (request.operation === "select") {
    if (element.localName !== "select")
      throw new Error("The matched element is not a select");
    if (!visible(element) || element.matches(":disabled"))
      throw new Error("The matched select is not editable");
    const value = String(request.value ?? "");
    if (![...element.options].some((option) => option.value === value))
      throw new Error("The requested option does not exist");
    element.value = value;
    const view = element.ownerDocument.defaultView;
    element.dispatchEvent(new view.Event("input", { bubbles: true }));
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    return [value];
  }
  throw new Error("Unsupported browser DOM operation");
}
