/**
 * A device-agnostic dot grid, row-major from the top-left, one byte per dot.
 *
 * `data.length` MUST equal `width * height`; consumers reject any other length
 * rather than silently truncating or ignoring the excess.
 *
 * A dot is raised if its byte is NONZERO. The Rust core emits only 0 or 1, but
 * any nonzero value counts as raised, so a producer working from image data —
 * an NVDA-side backend, say — can hand over 255 for "on" without converting.
 */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Transport = "usb" | "ble";

/**
 * Anything that can render a dot grid. The whole app talks to tactile hardware
 * only through this, so a future NVDA-side backend can be dropped in without
 * touching the pipeline.
 */
export interface TactileSink {
  readonly grid: { width: number; height: number };
  readonly availableTransports: Transport[];
  renderFrame(bitmap: Bitmap): void;
  renderText(text: string): void;
  connect(transport: Transport): Promise<void>;
  disconnect(): Promise<void>;
}

/** Turns a short ASCII string into braille cell hex for the device text line. */
export interface TextLineRenderer {
  toCellHex(text: string, cells: number): Promise<string>;
}
