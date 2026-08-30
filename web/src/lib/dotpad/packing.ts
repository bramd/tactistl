import type { Bitmap } from "../tactile/types";

export const PIN_COLS_PER_CELL = 2;
export const PIN_ROWS_PER_CELL = 4;

/**
 * Which bit each dot position within a cell occupies, indexed
 * `[column][row]`. Taken from the SDK's PIN_BIT_TABLE.
 *
 * This is the GRAPHIC area layout. It is NOT the same as the braille dot
 * numbering the SDK uses for text cells (1/2/4, 8/16/32, 64/128) — mixing the
 * two silently produces scrambled output.
 */
const PIN_BIT: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x08],
  [0x10, 0x20, 0x40, 0x80],
];

/**
 * Pack a dot bitmap into the hex string `displayGraphicData` expects: one byte
 * per cell, cells row-major from the top-left.
 */
export function bitmapToCellHex(
  bitmap: Bitmap,
  cellColumns: number,
  cellRows: number,
): string {
  const width = cellColumns * PIN_COLS_PER_CELL;
  const height = cellRows * PIN_ROWS_PER_CELL;
  if (bitmap.width !== width || bitmap.height !== height) {
    throw new Error(
      `bitmap is ${bitmap.width}x${bitmap.height}, expected ${width}x${height} ` +
        `for a ${cellColumns}x${cellRows} cell grid`,
    );
  }
  // A mismatched buffer means the producer and this consumer disagree about
  // the layout. Reject both directions: too short would read past the end
  // (an out-of-range Uint8Array index yields `undefined`, which is falsy, so
  // the missing dots would silently pack as blanks); too long means the
  // producer computed a different stride or grid, and packing the prefix
  // anyway would emit a plausible-looking but wrong frame.
  if (bitmap.data.length !== width * height) {
    throw new Error(
      `bitmap data has ${bitmap.data.length} bytes, expected ${width * height} ` +
        `for a ${width}x${height} dot grid`,
    );
  }
  // `cellColumns` / `cellRows` are deliberately not checked for integrality:
  // they come from the device's own reported cell count via the SDK, so a
  // fractional caller cannot exist.

  let hex = "";
  for (let cellRow = 0; cellRow < cellRows; cellRow++) {
    for (let cellCol = 0; cellCol < cellColumns; cellCol++) {
      let byte = 0;
      for (let c = 0; c < PIN_COLS_PER_CELL; c++) {
        for (let r = 0; r < PIN_ROWS_PER_CELL; r++) {
          const x = cellCol * PIN_COLS_PER_CELL + c;
          const y = cellRow * PIN_ROWS_PER_CELL + r;
          // Index with the bitmap's own width, not the derived `width`. They
          // are equal by the guard above, but relying on the derived value
          // would silently corrupt every row stride if that guard is ever
          // relaxed, rather than failing loudly.
          if (bitmap.data[y * bitmap.width + x]) byte |= PIN_BIT[c][r];
        }
      }
      hex += byte.toString(16).padStart(2, "0");
    }
  }
  return hex;
}
