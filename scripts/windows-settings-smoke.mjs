import assert from "node:assert/strict";

// Renderer acceptance with an isolated Windows API fixture; never sends desktop input.
export async function runWindowsSettingsSmoke({ browser, url }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    const fixture = await page.evaluate(async () =>
      (await import("/src/renderer/preview-api.ts")).previewAPI.bootstrap(),
    );
    fixture.capabilities.platform = "win32";
    fixture.desktop = true;
    fixture.targets = [
      { id: "legacy", name: "Legacy Windows target", kind: "desktop" },
    ];
    await page.addInitScript((fixture) => {
      const key = "relay.windows.settings.qa";
      const state =
        JSON.parse(sessionStorage.getItem(key) || "null") || fixture;
      const persist = () => sessionStorage.setItem(key, JSON.stringify(state));
      window.__windowsSettings = state;
      window.relay = {
        bootstrap: async () => structuredClone(state),
        onEvent: () => () => {},
        saveTarget: async (target) => {
          state.targets = [
            ...state.targets.filter((t) => t.id !== target.id),
            target,
          ];
          persist();
          return target;
        },
      };
    }, fixture);
    await page.reload();
    const applications = async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("button", { name: "Applications", exact: true })
        .click();
    };
    const method = () =>
      page.getByLabel("Windows capture method", { exact: true });
    const save = async () => {
      await page
        .getByRole("button", { name: "Save application", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    };
    await applications();
    await page
      .getByRole("button", { name: "Edit Legacy Windows target", exact: true })
      .click();
    assert.equal(
      await method().inputValue(),
      "",
      "Existing targets require an explicit choice",
    );
    await method().selectOption("printwindow");
    await save();
    await page.reload();
    await applications();
    await page
      .getByRole("button", { name: "Edit Legacy Windows target", exact: true })
      .click();
    assert.equal(await method().inputValue(), "printwindow");
    await page
      .getByLabel(/^Target type/)
      .selectOption("browser");
    assert.equal(await method().count(), 0);
    await save();
    assert.equal(
      await page.evaluate(
        () =>
          window.__windowsSettings.targets.find((t) => t.id === "legacy")
            .windowsCaptureBackend,
      ),
      undefined,
    );
    await page
      .getByRole("button", { name: "Add application", exact: true })
      .click();
    assert.equal(
      await method().inputValue(),
      "wgc",
      "New Windows targets default to visible WGC choice",
    );
    await page.getByLabel("Name", { exact: true }).fill("New Windows target");
    await save();
    await page.screenshot({
      path: "test-results/relay-windows-capture-settings.png",
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Windows capture method default, explicit legacy choice, persistence, and browser conversion.",
    );
  } finally {
    await context.close();
  }
}
