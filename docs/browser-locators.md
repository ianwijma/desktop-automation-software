# Browser locators

Browser actions can address elements by test attribute, role and name, associated label, element ID, or CSS. Managed Chromium and the companion extension use the same locator generator, matcher, and basic recording event extractor.

## Author and inspect a locator

1. Select a browser target on an action node, or edit a browser step in recording review.
2. Under **Browser targeting**, keep **CSS selector** for an existing selector or choose **Structured locator**.
3. Choose a strategy and enter its values. Test attributes accept `data-*` names; recording prefers `data-testid`, `data-test`, `data-qa`, and `data-cy`. Role names use lowercase values such as `button`. Name matching can require an exact name, including an empty name, or accept any name.
4. For nested content, add frame and open shadow-root scopes in outer-to-inner order. Each scope identifies one frame owner or shadow host using its own strategy.
5. Select **Test match**. Relay reports a unique, missing, or ambiguous match. A unique result includes its tag, role, name, and visibility; **Use inspected locator** adopts the generated locator. Save the flow or review step normally.

Test match does not click, type, focus, scroll, or start a workflow. It can open the configured managed browser or attach the extension debugger to the selected tab. It requires the Electron app and cannot run during workflow execution. Unresolved references disable testing; they still resolve normally during a run. Changing the target or locator invalidates any pending inspection response.

Actions require exactly one element at every scope and at the leaf. Missing and ambiguous matches fail explicitly; Relay never picks the first match or silently falls back to coordinates. An element detector returns `no-match` when the leaf is absent and `uncertain` when multiple leaf elements match. Missing or ambiguous frame/shadow owners are resolution errors. Invalid CSS and unavailable documents also produce errors.

## Matching and recording

Locators search the selected document or scope, including its open shadow roots. Frames require explicit scope entries. Both same-origin and cross-origin frame documents are addressed through their exact owner element, including when several frames load the same URL. Closed shadow roots are unavailable.

Names use normalized whitespace and common HTML sources: `aria-labelledby`, `aria-label`, associated labels, image alternate text, button values, supported role content, and titles. Matching is exact and case-sensitive. This is a shared DOM implementation, not a complete implementation of the Accessible Name specification or the browser accessibility tree. Complex custom widgets, slots, generated content, and unusual ARIA combinations may need a test attribute or CSS locator.

Recording tries unique test attributes, role/name, labels, IDs, then a unique CSS path. It stores explicit frame and shadow scopes. A test attribute or meaningful label remains stable when CSS classes change; a generated positional CSS path can break when the DOM structure changes. Review the locator and test it before running the flow. Password text is omitted and must be configured separately.

B02 extends the shared extractor with coalesced text/paste/composition, stateful controls, click variants, shortcuts, scrolls, ordinary pointer drags, main-document navigation, and owned popup tabs. See [browser recording coverage](browser-recording.md) for supported interactions and limits. Guided preview coordinates remain coordinate actions.

## Stored representation and compatibility

A node uses `config.locator` instead of `config.selector`. For example:

```json
{
  "targetId": "browser-target",
  "locator": {
    "version": 1,
    "path": [
      { "kind": "frame", "selector": { "kind": "id", "value": "workspace" } },
      { "kind": "shadow", "selector": { "kind": "id", "value": "toolbar" } }
    ],
    "selector": {
      "kind": "testId",
      "attribute": "data-testid",
      "value": "save"
    }
  }
}
```

The descriptor permits up to 12 frame/shadow scopes. Values are limited to 4,000 characters. Selectors and descriptors are validated at IPC/preflight and again after workflow references resolve. A locator cannot be combined with a nonempty legacy selector or a detected-coordinate result. Native targets reject browser locators. Unknown descriptor versions remain visible in Advanced configuration and fail validation until explicitly replaced.

Workflow and database schema versions remain 2. Existing `config.selector` CSS workflows are retained without migration. New structured Select actions return an array of selected values in both modes. Existing CSS Select actions retain their previous result shape: an array in managed Chromium and a string in the extension. Imports/exports retain locator JSON alongside other node configuration.

Pointer actions scroll the selected element into view and use normal actionability or hit checks. Extension frame coordinate mapping supports axis-aligned frames; rotated or mirrored frames are rejected. Key targeting must actually focus the selected element before keys are sent. Type/select operations remain subject to the adapter's supported HTML control behavior. A missing locator fails immediately; use an element Wait node when the page needs time to create the target.

The extension requires a browser supporting Chrome's flat debugger child sessions (Chrome/Chromium 125+). Restricted pages, browser chrome, native dialogs, closed shadow roots, and extension-store publication remain outside this feature. Local Chromium checks do not establish Windows/macOS, every Chrome/Edge release, or installer qualification. See [B01 verification](verification/b01-2026-10-25.md).
