# tactistl

Check a 3D model's orientation by touch, before you slice and print it.

Load an STL, set its rotation, and sweep a cross-section through the model. Each
cross-section is rasterized to a dot grid and pushed to a [Dot Pad](https://dotincorp.com)
tactile braille display over USB serial or Bluetooth, so a blind user can feel
the shape and confirm which way up the model is without looking at it. A
scrubber moves the cutting plane through the model so the shape can be read end
to end.

**What this is not:** a slicer preview. It draws the outline — or, optionally,
the filled area — where a plane cuts the mesh. There is no infill, no supports,
and no G-code-accurate layering. Nothing here tells you what your slicer will
do; it tells you which way the model is pointing.

A secondary goal shapes the architecture. The "render a raster to a tactile
device" layer is deliberately separable, so it can later be retargeted to an
NVDA-side tactile output path. The geometry core emits a device-agnostic
bitmap, and everything Dot Pad-specific sits behind a single `TactileSink`
interface.

## Browser support

Connecting to a device needs **Chrome or Edge** — or another Chromium browser.
Both connection paths depend on APIs that Firefox and Safari do not implement:

| Transport | Browser API | Chromium | Firefox | Safari |
|---|---|---|---|---|
| USB serial | Web Serial | yes | no | no |
| Bluetooth | Web Bluetooth | yes | no | no |

Everything else works in any modern browser: loading and parsing STLs (ASCII
and binary), rotating, slicing, rasterizing, the whole UI, and the on-screen
dot-grid preview of exactly what a connected display would be showing. In a
browser with neither API the connection section says so plainly instead of
offering a button that fails on click.

The two APIs are feature-detected independently, so a browser with only one of
them still gets that one. USB is the faster link, so it is listed first when
both are available.

## Requirements

- Rust with the `wasm32-unknown-unknown` target
- `wasm-pack`
- Node.js — Vite 8 requires `^20.19.0 || >=22.12.0`, so Node 20.19 or newer

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

## Running

```bash
cd web
npm install
npm run dev      # or: npm run build
```

Both `npm run dev` and `npm run build` run `npm run build:wasm` first, which
invokes `wasm-pack` on `crates/wasm` and writes the generated module into
`web/src/lib/wasm/` (gitignored, regenerated on every build). You do not need a
separate WASM step.

## Tests

```bash
cargo test          # the geometry core, in crates/
cd web
npm test            # the TypeScript side, via vitest
npm run check       # the type-check gate
```

`npm run check` is the type-check gate: it runs `svelte-check` against
`tsconfig.app.json` (which covers `.svelte`, `.ts` and `.js` under `web/src/`)
and then `tsc -p tsconfig.node.json`.

**Do not use `npx tsc --noEmit` to type-check this project.** `web/tsconfig.json`
is a solution-style config — `"files": []` plus project references — so a bare
`tsc --noEmit` type-checks *nothing* and exits 0 unconditionally. It looks like
a clean run and is not one. This cost real time; use `npm run check`.

## Layout

| Path | What it is |
|---|---|
| `crates/core` | All the geometry: STL parsing, rotation, slicing, scanline fill, rasterizing. Pure Rust — no WASM, no DOM, no I/O — so it is testable on its own with `cargo test`. |
| `crates/wasm` | A thin `wasm-bindgen` wrapper over the core. Holds the parsed mesh on the WASM heap and hands back a flat byte-per-dot buffer. |
| `web/src/lib/geometry` | `worker.ts` owns the WASM module and the loaded mesh; `client.ts` is the promise-based main-thread API over it. Parsing a large STL never blocks the page. |
| `web/src/lib/tactile` | The device-agnostic seam: `TactileSink`, the `Bitmap` contract, and `CanvasPreviewSink`, which draws the same frame onto a `<canvas>`. Nothing here may know a Dot Pad exists. |
| `web/src/lib/dotpad` | Everything device-specific: the vendored SDK, graphic-cell packing, the braille text-line renderer, transport selection and the connection lifecycle. |
| `web/src/lib/store.ts` | The single reactive store. Every input source — rotation fields, view selector, scrubber, hardware keys — writes only here. |
| `web/src/lib/pipeline.ts` | The one subscription that reads the store and runs slice → rasterize → sinks. |
| `web/src/App.svelte` | The only place that orchestrates: all async work, all store writes, the whole device lifecycle. |

The seam that matters is `web/src/lib/tactile/` versus `web/src/lib/dotpad/`.
Everything above the sink deals in a plain row-major bitmap; only `dotpad/`
imports the vendored SDK or knows about cells, transports or braille. That is
what makes a future NVDA-side backend a matter of constructing a different
sink.

## Notes on the device

The Dot Pad A320's graphic area is **60 x 40 dots**: 300 braille cells at 30
columns by 10 rows, each cell 2 dots wide and 4 tall. The app uses that as a
fallback while nothing is attached, and adopts whatever cell counts a connected
device reports, so it adapts to other models without a code change.

The graphic area packs dots into a cell byte as **left column top-to-bottom in
bits 0–3, right column top-to-bottom in bits 4–7**. This is *not* the 8-dot
braille numbering (dot N in bit N−1) used for the 20-cell text line. The two
tables live in `packing.ts` and `braille.ts` respectively and are commented as
such; mixing them silently scrambles the output rather than failing.

The text line shows the slice position as `12.4 of 40.0 mm` — the position
within the current sweep, and the sweep's full extent. It deliberately does not
name an axis. An axis letter would name the *view's* sweep axis rather than the
model's, and after any user rotation it would read as a coordinate you could
cross-check in a slicer while not being one. Front and Side sweeps also run in
the opposite direction to the model's own axis, so the letter would be actively
misleading. A position within the sweep is true under every rotation and view.

### Why the display keeps moving after a write

Watch a Dot Pad take a frame and the pins carry on re-actuating for several
seconds afterwards. That is not a bug in this app and not a stuck write. The
SDK's `displayGraphicData` ends by scheduling `graphicRefresh()`, which makes
up to six deferred re-actuation passes at 500 ms intervals (lines 1-3, then
lines 4-10) to counter the pins drooping out of position. There is no way to
turn it off in 3.0.2: the `isAutoRefresh` field is initialised to `false` and
never read anywhere in the file.

The consequence is that a graphic write is never free, even when it carries no
new data. `setDotPadLineCommand` *does* diff per line and queues no payload for
an unchanged one, but `displayGraphicData` sets the refresh mode and sends
unconditionally, so a call with data identical to what is already displayed
restarts the whole re-actuation cycle under the reader's fingers.

So `DotPadSink` suppresses a frame whose packed cell hex matches the last frame
the device took. The scrubber has 100 steps across 40 dot rows, so most ticks
rasterize to a bitmap byte-identical to the one before, and without the check
each of those would restart several seconds of pin movement for no change. The
comparison is on the packed hex — the exact payload — rather than on the render
parameters, so it catches every case where different parameters happen to
produce the same dots. It is cleared on connect and on disconnect, because what
the pins hold across a reconnect is unknowable and the first frame of a session
must always go out. The text line is deduped the same way, on the rendered
braille hex: `displayTextData` restarts a 1500 ms refresh cadence on every
call. It fires far less often than the frame check, because the position label
genuinely changes on nearly every scrubber step — it is there for the case
where it does not, such as holding against a clamped end of the sweep.

### What the SDK decides for itself

Two things that look like they want app-side handling are already handled
inside the vendored SDK, and adding our own would be duplication at best.

**Packet strategy is chosen from the device NAME, not by us.**
`BufferMode.fromDeviceName` returns `ALL_PARTIAL` for a name containing
`DotPad320C`, `DotPad320X` or `DotPad300A`, and `SINGLE_LINE` for everything
else. On the `ALL_PARTIAL` models the SDK therefore writes several regions in
one packet automatically; on the others it writes a line at a time. There is no
public API to override the choice, and the app does not try to. Note this is a
*different* lookup from `DeviceCellType.fromDeviceName`, which picks the D2/D3
cell type from an overlapping but not identical model list.

To check which strategy a given unit gets, connect it: the connection section
carries a "Device details" disclosure, collapsed by default, holding the name
the device reported and the resulting strategy, e.g.
"Device: DotPad320X — sends several display regions per packet". It is
diagnostic, so it stays out of the main flow and out of the live region — the
connection announcement already fires — but a native `<details>` keeps it one
keystroke away for a screen-reader user. The SDK asks
for the name during its own connection handshake, so the sink reads it out of
the message callback rather than requesting it again. The strategy shown is
**derived** by re-running the SDK's own substring rule (`expectedBufferModeForName`
in `web/src/lib/dotpad/sink.ts`), because `BufferMode` exposes neither its
choice nor an override. That mirrors SDK internals, so it must be re-checked if
the vendored SDK is ever updated — `vendor/version-pin.test.ts` is the tripwire
that will fail first.

**Flow control is ack-gated inside the SDK.** The send loop gates on
`dotCommandSendReady` and advances on `ResponseDisplayLineAck` /
`notificateDisplayComplete`. The app must not add pacing, chunking or retry
logic of its own on top of it; doing so would interleave with the SDK's own
queue rather than replace it.

## Known limitations

This section is the honest part. Several of these are invisible to the user the
tool is built for, which is exactly why they are written down.

**No delivery confirmation for anything sent to the display.** Neither the dot
frames nor the text line are acknowledged. `displayGraphicData` is a
synchronous, fire-and-forget void call; `displayTextData` returns a promise,
but with `needsTranslation=false` — the only mode this app uses, because `true`
dynamically imports liblouis, which is not shipped — it resolves as soon as the
data is handed on, without waiting for the device. So the app cannot tell
whether a frame *or* a position line actually reached the hardware. If a write
fails silently inside the SDK, the display simply holds the previous layer —
and for a blind user a stale frame is indistinguishable from geometry that
genuinely did not change. The sink latches and reports the write errors it
*can* see (a throw, or a write that does not settle within five seconds), but a
silent failure below that is invisible. The SDK does emit
`ResponseDisplayLineAck`, `ResponseDisplayLineNonAck` and
`ResponseDisplayLineComplete` data codes through the message callback the sink
already wires up for disconnects. Subscribing to those is the highest-value
follow-up in this file.

**A failed final frame is not retried.** `LatestWinsQueue` coalesces
submissions so a slider drag does not queue one render per pixel of travel, but
it does not retry a send that rejects. The last frame of a drag is the one the
user is waiting to feel, and if it fails the device is left one position stale.
The failure is surfaced once through the live region, but the app cannot say
which frame is actually on the pins.

**`boundsChanged` vs `viewChanged` is a silent invariant.** The two store
methods take the same argument and differ only in what they do to the reading
position: `boundsChanged` preserves the position as a fraction of the extent
(so nudging the rotation a degree does not throw away the plane you were
reading), while `viewChanged` re-centres (because a fraction through the
model's Z means nothing along its Y). There is no type distinction, so calling
the wrong one produces no error at all — just a scrubber that jumps when it
should hold, or holds when it should jump. It is contained to two call sites in
`App.svelte` today, one per method. The durable fix is for the store to own the
distinction by comparing the view the bounds were fetched under, rather than
trusting the caller.

**The canvas preview is fixed at 60x40.** `CanvasPreviewSink` takes its grid at
construction and has no setter, so if a connected device reports different
dimensions the preview crops to 60x40 rather than re-laying-out. The page says
so on screen. The device itself is unaffected — the pipeline rasterizes at the
device's own grid, because the real sink is first in the sink list.

**Reloading the same file announces nothing.** The live region is a single
polite `role="status"` paragraph; loading the same file twice produces an
identical string, the DOM does not mutate, and so nothing is announced. The
load itself works — the file input clears its value so re-picking the same path
still fires — but the confirmation is silent.

**Front and Side views scrub in reverse.** Increasing the slider walks the
model's Y (Front) or X (Side) from its maximum toward its minimum; only Top
sweeps in the model's own positive direction. This is deliberate: the view
presets are chosen so the model renders the right way up, and correcting the
sweep direction would render it upside down instead. The on-screen and braille
labels report distance through the sweep rather than a coordinate precisely so
this cannot mislead.

**Non-watertight meshes lose their fill on open rows.** The scanline fill
skips any row where the crossing count comes out odd, because an open contour
has no answer to "which side is inside", and pairing an odd list anyway does
not just lose one crossing — it inverts the fill for every span to its right. A
missing region reads as absence under the fingers; an inverted one reads as
real geometry, which is worse. The outline is unioned over the fill in filled
mode, so the boundary still comes through on those rows.

**`PIN_ASPECT` is assumed to be 1.0 and has not been verified against
hardware.** The rasterizer assumes the graphic area's pin pitch is square. If
it is not, circles will feel slightly elliptical. `crates/core/src/raster/fit.rs`
carries the calibration procedure: slice a sphere at mid-height, feel whether
the circle is round, adjust the constant.

**The braille text-line renderer is a deliberate subset.** `SimpleBrailleRenderer`
handles uncontracted letters, digits, space, `.`, `,` and `-` — enough for the
labels this app emits and nothing more. Any other character renders as a blank
cell. It exists so the app does not have to ship liblouis (several megabytes of
WASM, plus LGPL redistribution obligations) to print one short line; swapping in
a liblouis-backed `TextLineRenderer` would touch nothing else.

**Text-line writes are not coalesced.** Only graphic frames go through the
latest-wins queue; `renderText` fires its write directly. Rapid label changes
can therefore settle out of order and leave a stale label on the text line even
while the graphic area is correct. In practice the label changes at scrubber
speed, so this is a narrow window, but it is a real one.

**Reloading a model briefly holds two meshes.** The worker parses into a
temporary and only frees the old handle once the new one exists, so a failed
parse leaves the previously loaded model live and renderable — which matters
for a user who cannot glance at a file picker to check they grabbed the right
file. The cost is that wasm32 linear memory only ever grows, so the module's
high-water mark is set by the largest *pair* of meshes rather than the largest
single one, and does not come back down.

**The vendored SDK has no license, and this is unresolved.** `web/src/lib/dotpad/vendor/DotPadSDK-3.0.2.js`
is copied byte-identically from `dotincorp/dotpad-sdk-guide` (pinned by git blob
SHA in `version-pin.test.ts`, so an accidental swap fails a test). That
repository contains **no LICENSE file**, and the file itself carries no license
header. The only license text in the upstream repository is liblouis's LGPL,
which is scoped to translation assets this app does not ship. The SDK's README
documents copying the file into your project, which reads as an implied grant —
but an implied grant is not a license grant. **Whether this repository can be
published at all is an open question until Dot Inc clarifies the terms.** It is
not a detail to be discovered later by whoever tries to publish it.

## Manual test plan

**This app has never loaded an STL in a real browser.** Everything above is
verified by unit tests (123 TypeScript, 70 Rust), by `npm run check`, and by a
successful production build. Not one of the paths below has been exercised by a
human. Work through them before trusting any of it.

Start with `npm run dev` in `web/`, open the printed URL in Chrome or Edge, and
use `crates/core/tests/fixtures/cube_ascii.stl` as the first model.

- [ ] **First load, end to end.** Load `crates/core/tests/fixtures/cube_ascii.stl`.
      The preview should show a square outline, the triangle count should be
      announced, and the scrubber should land in the middle of the sweep.
- [ ] **The ends of the sweep still render.** Drag the scrubber to 0 and to the
      maximum. Neither end should go blank.
- [ ] **Filled mode.** Tick the "Filled" checkbox: the square fills, and the
      outline stays.
- [ ] **Rotation.** Enter 45 in "Z rotation, degrees": the square becomes a diamond
      that still fits the grid.
- [ ] **The recovery path.** With the cube loaded, load a garbage file (any
      non-STL). An error must be announced *and the cube must stay loaded and
      still render*. This is the single most important item on this list.
- [ ] **NVDA announcements fire once per event** — one announcement for a load,
      one for an error, one for connect and one for disconnect. Not repeated,
      not stacked, and nothing announced while the scrubber moves (the range
      input announces its own value; a live region firing per tick would talk
      over it).
- [ ] **The rotation nudge holds position.** Note the reported position, change
      a rotation by one degree, and confirm the position is essentially
      unchanged. Then change the view and confirm it *does* re-centre. These are
      the two `boundsChanged`/`viewChanged` call sites.
- [ ] **Both connect pickers open.** "Connect over USB" opens the Web Serial
      picker; "Connect over Bluetooth" opens the Web Bluetooth picker.
      Dismissing either must be a no-op, not an error.
- [ ] **Hardware panning keys move the on-screen slider.** With a device
      connected, the Dot Pad's panning left/right keys must move the slider by
      one step, the same distance as one arrow key press.
- [ ] **Unplug handling.** Disconnect the device physically while connected:
      the app must announce the drop, clear the connected state, and keep
      working against the preview.
- [ ] **Drag and drop.** Drop an STL anywhere on the page. It loads, and the
      browser does not navigate away from the app.
- [ ] **The focus ring is visible on every control** — file input, all three
      rotation fields, the view select, both checkboxes, the slider, the exact
      position field, and every connection button. Tab through the whole page.
- [ ] **Connecting with a model already loaded.** Load a model first, then
      connect. The pins must change and the text line must show a position
      *before you touch any control*. On an A320 the device's grid is 60x40 —
      exactly the disconnected fallback — so nothing about the render changes
      on connect, and only the connect itself can force that first frame. The
      grid-adoption item below would not catch this.
- [ ] **Grid adoption.** With a device attached, confirm the frame is
      rasterized at the device's reported cell counts, not at the 60x40
      fallback.

## Why it is built this way

The geometry is Rust because slicing is where correctness and speed matter, and
because a pure-geometry crate with no WASM, DOM or I/O in it stays testable in
isolation — the 70 Rust tests run in milliseconds and describe the awkward
cases (on-plane vertices, non-watertight rows, degenerate extents) directly.

The output layer is isolated behind `TactileSink`, which takes a plain
row-major bitmap and nothing else. Nothing above that interface knows a Dot Pad
exists. That seam is not tidiness for its own sake: it is what allows the same
rasterized output to be pointed at an NVDA-side tactile path later without
touching the geometry, the store or the pipeline.
