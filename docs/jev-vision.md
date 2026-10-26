# Jev image preparation and localization (A02)

Jev vision remains experimental and requires both enabled Vision and **Enable experimental vision** on the connection. Every request uses the selected model, with no automatic retry, repair, alternate model or provider fallback. A04 owns live model conformance; passing mocked tests does not establish real-world detection accuracy.

## Image preparation

The production Jev adapter accepts upright, still PNG/JPEG captures up to 32 MiB and 40 megapixels. Prepared uploads are capped at 16 MiB, and encoded requests at 32 MiB. A larger 4K source can be reduced before the provider upload limit is applied. It validates decoded dimensions against CaptureFrame metadata, rejects animation/corruption/invalid base64 and rejects non-upright EXIF orientation rather than returning incorrectly mapped capture coordinates. Screenshot capture sources already supply upright pixels.

Before HTTP, the adapter scales the longest side down to at most 1568 pixels, rounds actual output dimensions, and pads each short side to at least 280 pixels. Tiny images are centered without enlargement. Aspect ratio is retained apart from integer pixel rounding, and separate actual X/Y ratios make the mapping invertible. PNG output strips metadata and flattens alpha against white. Every request uses a fresh UUID asset reference in state, preventing prompt text from accidentally matching a fixed asset name. An image is included once; instructions refer to its state field.

These bounds follow the current [TypeSafe image contract](https://docs.typesafe.ai/images). Prepared coordinates are internal: workflow/runtime results remain in the original capture's pixel space, with the original runtime frame ID. Boxes in padding or beyond the source are rejected, rather than clipped into apparently usable coordinates.

## Presence and location

The `present` Noul probability and Box `confidence` describe separate things. A Box can exist even when the target is absent, so its existence never establishes a match. See the [Box contract](https://docs.typesafe.ai/primitives/box).

- `presenceConfidence` retains the Noul probability. The existing `confidence` alias remains for compatibility.
- `locationConfidence` retains valid returned Box confidence independently.
- The ordinary Confidence threshold (default 0.85) controls presence; Jev requires it above 0.5.
- **Jev location confidence** (default 0.85) controls location separately and must be greater than zero and at most one.

For localization, presence must first match. Absent/uncertain presence never exposes a box. Low location confidence produces **uncertain**, retaining both confidence values but no coordinates. Missing/invalid location confidence or malformed/out-of-range/padding boxes produce an error. Only a valid box passing both thresholds is inverse-mapped into the source crop. The runner then adds a configured search-region offset once, through a nonmutating restoration function, and retains the full capture's frame identity. Click/Move consumers continue to require a fresh matched box on the same target.

This does not introduce automatic cropping/tiling/repair requests, inflate confidence, or claim that resizing preserves small-target model accuracy. Presence-only decisions do not require a Box confidence value.

## Verification

The [A02 evidence](verification/a02-2026-10-27.md) separates actual image decoding/mapping and production adapter protocol tests from future live provider/model qualification.
