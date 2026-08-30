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
  /**
   * Blank the display: every dot lowered, on the graphic area and on the text
   * line where the device has one.
   *
   * On the interface rather than on one sink because it is a device-agnostic
   * idea -- any tactile display can be blanked -- and because the reason it
   * exists is device-agnostic too. A tactile display holds its state
   * mechanically, so connecting to one that a previous session (or another
   * app) left dots on shows stale geometry with nothing to say it is stale.
   * A blind reader cannot tell that from live output, so the app must be able
   * to assert "nothing is displayed" rather than hope.
   *
   * An implementation MUST invalidate whatever it uses to suppress duplicate
   * writes: this changes the physical state of the display, so the next frame
   * or label is no longer a duplicate of what the pins are holding even when
   * it is a duplicate of what was last sent.
   *
   * A no-op when the sink has nothing to write to.
   */
  clear(): void;
  connect(transport: Transport): Promise<void>;
  disconnect(): Promise<void>;
}

/** Turns a short ASCII string into braille cell hex for the device text line. */
export interface TextLineRenderer {
  toCellHex(text: string, cells: number): Promise<string>;
}
