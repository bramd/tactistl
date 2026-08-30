import type { Bitmap, TactileSink, Transport } from "./types";

/**
 * The Dot Pad A320's grid in dots, used as the default so the preview matches
 * the device most users will attach. Deliberately a plain literal rather than
 * an import from `../dotpad/`: nothing in `tactile/` may know that the Dot Pad
 * exists, or the layering that makes a future NVDA-side backend a drop-in
 * replacement quietly stops holding.
 */
const DEFAULT_WIDTH = 60;
const DEFAULT_HEIGHT = 40;

export interface CanvasPreviewOptions {
  /** Grid size in dots. Defaults to the 60x40 the A320 offers. */
  width?: number;
  height?: number;
  /** Centre-to-centre dot spacing in CSS pixels. */
  dotPitch?: number;
}

/**
 * Draws the frame a tactile display would show onto a `<canvas>`.
 *
 * This exists so the whole slice-and-rasterize pipeline can be built, demoed
 * and reviewed with no hardware attached, and so sighted collaborators can see
 * what the blind user is feeling. It is a `TactileSink` like any other, so the
 * app can drive it and a real device from the same code path.
 */
export class CanvasPreviewSink implements TactileSink {
  readonly grid: { width: number; height: number };

  private readonly canvas: HTMLCanvasElement;
  private readonly pitch: number;
  private lastBitmap: Bitmap | null = null;
  private lastText = "";

  constructor(canvas: HTMLCanvasElement, options: CanvasPreviewOptions = {}) {
    this.canvas = canvas;
    this.grid = {
      width: options.width ?? DEFAULT_WIDTH,
      height: options.height ?? DEFAULT_HEIGHT,
    };
    this.pitch = options.dotPitch ?? 10;

    // Size the backing store to the grid so a dot is never a fractional pixel.
    this.canvas.width = this.grid.width * this.pitch;
    this.canvas.height = this.grid.height * this.pitch;
    this.paint();
  }

  /**
   * The preview needs no connection, so it advertises no transports. A UI
   * listing transports to offer therefore shows none for it, which is right:
   * there is nothing for the user to pick.
   */
  get availableTransports(): Transport[] {
    return [];
  }

  /** The preview is always available; connecting is meaningless but harmless. */
  async connect(_transport: Transport): Promise<void> {}

  async disconnect(): Promise<void> {}

  renderFrame(bitmap: Bitmap): void {
    this.lastBitmap = bitmap;
    this.paint();
  }

  /**
   * Retained rather than drawn: the device shows this on a separate braille
   * text line, and the preview's caller (or a test) reads it back to display
   * it as text, which is more useful on screen than rendered braille dots.
   */
  renderText(text: string): void {
    this.lastText = text;
  }

  get text(): string {
    return this.lastText;
  }

  private paint(): void {
    const ctx = this.canvas.getContext("2d");
    // A canvas whose 2d context is unavailable is not worth throwing over: the
    // preview is a convenience, and failing here would take down a pipeline
    // that is otherwise working.
    if (!ctx) return;

    const { width, height } = this.grid;
    const pitch = this.pitch;
    ctx.fillStyle = "#1b1b1f";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const bitmap = this.lastBitmap;
    // Raised dots are large and bright, lowered ones small and dim, so the
    // grid still reads as a grid of pins rather than as scattered marks -- the
    // lowered dots are what make the raised ones locatable at a glance.
    const raisedRadius = pitch * 0.4;
    const loweredRadius = pitch * 0.12;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Any nonzero byte is raised, per the Bitmap contract. A bitmap of the
        // wrong size is drawn as far as it goes rather than rejected: missing
        // dots read as lowered, and the preview is not the place to enforce
        // the grid -- the device sink already does that loudly.
        const raised =
          bitmap !== null &&
          x < bitmap.width &&
          y < bitmap.height &&
          bitmap.data[y * bitmap.width + x] !== 0;
        ctx.beginPath();
        ctx.arc(
          x * pitch + pitch / 2,
          y * pitch + pitch / 2,
          raised ? raisedRadius : loweredRadius,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = raised ? "#f2f2f7" : "#3a3a42";
        ctx.fill();
      }
    }
  }
}
