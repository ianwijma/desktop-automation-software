(() => {
  if (window.__relayRecorderInstalled) return;
  window.__relayRecorderInstalled = true;
  function selector(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    if (element.dataset.testid)
      return `[data-testid="${CSS.escape(element.dataset.testid)}"]`;
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const parent = current.parentElement;
      const siblings = parent
        ? [...parent.children].filter(
            (child) => child.tagName === current.tagName,
          )
        : [];
      parts.unshift(
        current.tagName.toLowerCase() +
          (siblings.length > 1
            ? `:nth-of-type(${siblings.indexOf(current) + 1})`
            : ""),
      );
      if (parts.length === 7) break;
      current = parent;
    }
    return parts.join(" > ");
  }
  function send(kind, label, config) {
    if (window.__relayRecordingEnabled)
      chrome.runtime
        .sendMessage({
          type: "recorded",
          action: {
            id: crypto.randomUUID(),
            at: Date.now(),
            kind,
            label,
            config,
          },
        })
        .catch(() => {});
  }
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const element =
        event.target.closest(
          'button,a,input,select,textarea,[role="button"]',
        ) || event.target;
      send(
        "click",
        `Click ${(element.textContent || element.tagName).trim().slice(0, 40)}`,
        {
          selector: selector(element),
          x: event.clientX,
          y: event.clientY,
          button: "left",
        },
      );
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const element = event.target;
      if (element instanceof HTMLSelectElement)
        send("select", "Select option", {
          selector: selector(element),
          value: element.value,
        });
      else if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const secret = element.type === "password";
        send(
          "type",
          secret ? "Enter password (configure value)" : "Type text",
          {
            selector: selector(element),
            text: secret ? "" : element.value,
            ...(secret ? { secret: true } : {}),
          },
        );
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (["Enter", "Tab", "Escape"].includes(event.key))
        send("key", `Press ${event.key}`, { key: event.key });
    },
    true,
  );
})();
