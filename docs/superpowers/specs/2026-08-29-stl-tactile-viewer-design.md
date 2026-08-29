# STL Tactile Layer Viewer for Dot Pad — Design

Date: 2026-08-29

## Purpose

A browser-based tool for checking a 3D model's orientation by touch before
slicing and printing. It loads an STL, applies a user-specified rotation,
computes a cross-section, rasterizes it to the Dot Pad's tactile graphics
grid, and pushes it to the device over Web Bluetooth. A scrubber moves the
cross-section through the model so the shape can be felt end to end.

This is an orientation-check tool, not a slicer preview. No infill, supports,
or G-code-accurate layer geometry.

### Secondary purpose: testbed

The "render a raster to a tactile device" layer is kept cleanly separable so
it can later be retargeted or mirrored into an NVDA-side tactile output path
without a rewrite. Concretely: the geometry core emits a device-agnostic
row-major bitmap, and everything Dot-specific (cell packing, hex encoding,
BLE transport) lives behind a single TypeScript interface.

## Confirmed device facts

Researched from `github.com/dotincorp/dotpad-sdk-guide`, `Web/3.0.2/`
(latest Web SDK version; the brief's reference to earlier docs is superseded).

### Graphics grid: 60 x 40 dots

The brief's guess of 120 x 80 is **incorrect**. The graphic area is 300
braille cells arranged 30 columns x 10 rows. Each cell is 2 dots wide x 4
dots tall:

- width  = 30 cells x 2 = **60 dots**
- height = 10 cells x 4 = **40 dots**

The 30/10 figures are the SDK's *offline fallback* values. A connected device
reports its true layout via `DataCodes.BoardInfo`, exposed as
`device.numberCellColumns` and `device.numberCellRows`. The app therefore:

- defaults to 30 x 10 cells (60 x 40 dots) when no device is connected,
- adopts the device-reported dimensions on `Connected`,
- always passes grid dimensions into the rasterizer as parameters.

No grid dimension is ever hardcoded in the Rust core.

### Graphic-area pin bit packing

Extracted from the SDK's `PIN_BIT_TABLE` / `packPinsToGraphicHex`. Within one
cell, for a dot at (column r, row a):

| position | bit  |
|----------|------|
| (0,0)    | 0x01 |
| (0,1)    | 0x02 |
| (0,2)    | 0x04 |
| (0,3)    | 0x08 |
| (1,0)    | 0x10 |
| (1,1)    | 0x20 |
| (1,2)    | 0x40 |
| (1,3)    | 0x80 |

That is: left column top-to-bottom occupies bits 0-3, right column
top-to-bottom occupies bits 4-7.

Cells are emitted row-major (`cellIndex = row * numberCellColumns + col`), one
byte (two hex characters) per cell, as a single hex string.

**Trap:** this differs from the braille dot numbering the SDK uses in
`buildMultilinePages` (1/2/4, 8/16/32, 64/128). The graphic packing above is
the correct one for `displayGraphicData`.

### Text line

Line 0 is a separate 20-cell braille text line, written with
`displayTextData(hex, device, DisplayMode.TextMode)`. Its width is
`device.numberBrailleCellColumns`.

### API surface used

- `new DotPadScanner().startBleScan()` returns a `BluetoothDevice` (requires a
  user gesture; opens the browser's Bluetooth picker)
- `sdk.connectBleDevice(device)` returns a `DotDevice`
- `sdk.setCallBack(messageCb, keyCb, onKeyDown?, onKeyUp?)`
- wait for `DataCodes.Connected` before sending anything
- `sdk.displayGraphicData(hex, device, DisplayMode.GraphicMode)`
- `sdk.displayTextData(hex, device, DisplayMode.TextMode)`
- `sdk.disconnect(device)`
- hardware keys: `KeyCodes.PanningLeft` / `PanningRight`, `KeyFunction1`-`4`

The SDK ships as a vendored ES module (`DotPadSDK-3.0.2.js` plus its `.d.ts`);
there is no npm package.

### Browser support

Chromium only (Chrome/Edge). Web Bluetooth is not implemented in Firefox or
Safari. Everything except the connection step works in any browser; the README
must say so.

## Architecture

```
  STL bytes
      |
      v
+------------------------- Rust / WASM ----------------------------+
|  parse_stl  ->  transform  ->  slice  ->  rasterize              |
|  (stl_io)       (rotation)     (plane)    (grid bitmap)          |
+------------------------------------------------------------------+
      |
      v  row-major 0/1 bitmap (device-agnostic)  <-- the NVDA seam
      |
+---------------------- TypeScript ---------------------------------+
|  TactileSink interface                                            |
|    +-- DotPadSink  (bitmap -> cell hex -> SDK -> BLE)             |
|    +-- (future) NvdaSink / CanvasPreviewSink                      |
+-------------------------------------------------------------------+
      ^
      |
+--------------------------- Svelte --------------------------------+
|  single reactive store; every input source writes to it           |
+-------------------------------------------------------------------+
```

### Rust/WASM core

Pure computation. No DOM, no Bluetooth, no UI. Exported interface:

```
parse_stl(bytes) -> MeshHandle
mesh_bounds(mesh, rotation) -> Bbox        // rotated extent
slice(mesh, rotation, z) -> Segment[]
rasterize(segments, bbox, width, height, mode, mirror) -> Bitmap
```

Crate: `stl_io` 0.11 — actively maintained, 4.5M downloads, parses both ASCII
and binary STL from any `Read + Seek`, so an in-memory `Cursor` over the
uploaded bytes works directly.

#### Slicing: segments, not polygons

`slice()` returns a flat list of 2D line segments, **not** assembled polygon
loops. Plane/triangle intersection naturally produces a segment soup; stitching
it into ordered loops is the fiddly, failure-prone part and buys nothing here:

- disjoint regions (separate legs of a model) work for free — they are just
  more segments in the same list,
- holes work for free,
- non-watertight STLs (common in the wild) degrade gracefully into a partial
  outline instead of crashing a loop stitcher.

Both render modes fall out of segments directly:

- **outline**: draw each segment onto the grid with a line rasterizer.
- **filled**: for each dot row, collect the x-crossings of all segments with
  that row's scanline, sort them, and fill between successive pairs
  (even-odd parity).

Outline is the default — on a 60x40 grid it carries more shape information
than a filled blob. Filled is a toggle.

#### Degeneracies

A vertex or edge lying exactly on the slice plane is handled by nudging the
slice z by a small epsilon proportional to the model's bbox height, rather
than enumerating coplanar cases. This is the standard slicer trick and is more
than adequate for an orientation checker.

#### Rotation

```
v' = R_view * R_user * v
```

The user's manually entered orientation is applied first; the view preset
rotation is composed outside it. The result is always sliced along **Z** — the
Rust core has no notion of a slice axis, per the brief.

Euler order for the user inputs is **X, then Y, then Z, about world axes**,
matching common slicer convention. This is documented in the UI.

View presets:

| View  | R_view          | Scrubs  |
|-------|-----------------|---------|
| Top   | identity        | model Z |
| Front | -90 deg about X | model Y |
| Side  | +90 deg about Y | model X |

Back and Left are **not** separate presets. They are a "mirror" toggle on the
current view: the cross-section data is identical, only the viewing direction
differs, so mirroring the raster horizontally is the whole difference. This
keeps the preset list short and the mental model simple.

#### Stable raster framing

The rasterizer's bounding box is the **full XY extent of the rotated mesh**,
computed once whenever the rotation changes — never the individual slice's own
extent.

This matters for the actual use case: if each slice were fitted to its own
extent, the model would appear to "breathe" as the scrubber moves — scale and
position shifting layer to layer. That is disorienting to read by touch and
destroys the sense of the model's overall proportions.

Aspect ratio is preserved and the fitted image is centred in the grid with
symmetric padding.

Pin pitch is assumed square, expressed as a single named constant
(`PIN_ASPECT = 1.0`). This will be verified empirically by slicing a sphere STL
at mid-height: if the circle feels elliptical on the device, the constant is
adjusted. Not worth researching the physical pitch up front.

### TypeScript: tactile output layer

A `TactileSink` interface is the only thing the rest of the app talks to:

```
interface TactileSink {
  readonly grid: { width: number; height: number };
  renderFrame(bitmap: Bitmap): void;
  renderText(text: string): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
```

`DotPadSink` implements it over the vendored SDK and owns everything
Dot-specific: bitmap to cell hex packing (using the bit table above), the SDK
calls, and the BLE lifecycle. A future `NvdaSink` or an on-screen
`CanvasPreviewSink` implements the same interface with no change elsewhere.

#### Latest-wins send queue

`DotPadSink` maintains a single-slot outbound queue: at most one frame in
flight, and a newly submitted frame **replaces** any frame still waiting.

Without this, dragging the scrubber queues a frame per intermediate value and
the device spends seconds replaying stale layers after the user has stopped.
With it, the device always converges on the current layer.

#### Text line

The axis position (e.g. `Z 12.4 mm`) is rendered via a `TextLineRenderer`
interface:

```
interface TextLineRenderer {
  toCellHex(text: string, cells: number): Promise<string>;
}
```

The initial implementation, `SimpleBrailleRenderer`, is a hand-written
ASCII-to-braille-cell table covering only what this app emits: digits 0-9, the
number sign, period, minus, space, and the letters X/Y/Z/m. Numbers use the
literary number-sign prefix. This avoids a multi-megabyte liblouis WASM payload
and its LGPL redistribution obligations.

A `LiblouisTextLineRenderer` using the SDK's translation API can be dropped in
later behind the same interface without touching any other code.

### Svelte UI

A single reactive store holds all view state:

```
{ mesh, rotation: {x,y,z}, view, mirror, axisPos, renderMode, device }
```

Every input source **writes to the store only**; the recompute pipeline is a
single derived subscription that runs slice, then rasterize, then sink. Input
sources:

- rotation number inputs
- view axis select
- mirror checkbox
- scrubber (range input plus a numeric field for an exact value)
- Dot Pad hardware keys via the SDK key callback

Hardware `PanningLeft` / `PanningRight` map to scrub -1 / +1 step. Because they
write to the same store, the on-screen slider stays in sync automatically —
which is exactly the class of bug the store exists to prevent. Further key
mappings are deferred; on-screen controls cover all functionality on their own.

#### Scrubber

The range covers the rotated model's extent along the current view axis, in
100 steps. A separate numeric input accepts an exact value in mm. On load, and
whenever the view axis changes, the position defaults to the **middle** of the
extent, so the first read without touching anything is a sensible cross-section.

#### Accessibility

- Native HTML controls throughout: number, select, range, checkbox and file
  inputs. No component library, no custom-styled slider.
- Every control has a real label element.
- Drag-and-drop for the STL is an addition to the file input, never a
  replacement.
- Connection state and slice position changes are announced via a polite live
  region.
- Full keyboard operability; no mouse-only interaction anywhere.

An on-screen canvas preview of the current bitmap is rendered alongside, both
for sighted collaborators and for development without hardware attached.

## Error handling

| Condition | Behaviour |
|-----------|-----------|
| Unparseable STL | Error message in a live region; previous model retained |
| Zero-triangle or degenerate mesh | Explicit "no geometry found" message |
| Slice plane misses all geometry | Blank frame, not an error (legitimate at the extremes) |
| Web Bluetooth unavailable | Connect button disabled with an explanatory message; rest of the app fully usable |
| BLE connection lost mid-session | Disconnected event resets connection state; UI stays usable, frames stop being sent |
| Very large STL | Parsing runs off the main thread; a busy state is announced |

## Testing

- **Rust unit tests** for the core: parsing ASCII and binary STL fixtures,
  rotation matrix composition, plane/triangle intersection against
  analytically known cases (cube, sphere, tetrahedron), the vertex-on-plane
  epsilon case, scanline fill parity with holes and with disjoint regions,
  and aspect-preserving fit.
- **TypeScript unit tests** for bitmap-to-hex packing, verified against the
  bit table above with hand-computed expected hex; and for the latest-wins
  queue (submit N frames, assert only the first and last are sent).
- **Store tests**: assert that a hardware-key scrub and an on-screen scrub
  produce identical state, which is the single-pipeline invariant.
- **Manual hardware verification**: sphere at mid-height for the aspect-ratio
  constant; a two-legged model to confirm disjoint regions render together.

## Out of scope

- PrusaSlicer integration or live external app state reading
- Slicer fidelity (supports, infill, accurate layer geometry)
- NVDA output bridging (architecture accommodates it; not built)
- Zoom and pan
- USB serial connection (the SDK supports it; BLE only for v1)
