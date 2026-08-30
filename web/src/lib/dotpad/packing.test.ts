import { describe, expect, it } from "vitest";
import { bitmapToCellHex } from "./packing";
import type { Bitmap } from "../tactile/types";

function blank(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(width * height) };
}

function set(b: Bitmap, x: number, y: number) {
  b.data[y * b.width + x] = 1;
}

describe("bitmapToCellHex", () => {
  it("packs an empty grid as all zeros", () => {
    // One cell: 2 dots wide, 4 tall.
    expect(bitmapToCellHex(blank(2, 4), 1, 1)).toBe("00");
  });

  it("packs a full grid as all ones", () => {
    const b = blank(2, 4);
    b.data.fill(1);
    expect(bitmapToCellHex(b, 1, 1)).toBe("ff");
  });

  // Bit table from the SDK's PIN_BIT_TABLE: left column top-to-bottom is
  // bits 0-3, right column top-to-bottom is bits 4-7.
  it.each([
    [0, 0, "01"],
    [0, 1, "02"],
    [0, 2, "04"],
    [0, 3, "08"],
    [1, 0, "10"],
    [1, 1, "20"],
    [1, 2, "40"],
    [1, 3, "80"],
  ])("maps dot (%i,%i) to hex %s", (x, y, hex) => {
    const b = blank(2, 4);
    set(b, x, y);
    expect(bitmapToCellHex(b, 1, 1)).toBe(hex);
  });

  it("emits cells row-major", () => {
    // 2 cells across, 1 down. Set the top-left dot of the SECOND cell only.
    const b = blank(4, 4);
    set(b, 2, 0);
    expect(bitmapToCellHex(b, 2, 1)).toBe("0001");
  });

  it("emits one byte per cell for a full-size Dot Pad grid", () => {
    const b = blank(60, 40);
    // 30 x 10 cells = 300 cells = 600 hex characters.
    expect(bitmapToCellHex(b, 30, 10)).toHaveLength(600);
  });

  it("rejects a bitmap whose size does not match the cell grid", () => {
    expect(() => bitmapToCellHex(blank(10, 10), 30, 10)).toThrow();
  });

  it("rejects a bitmap whose data is shorter than width * height", () => {
    // The dimensions match a 2x1 cell grid, so the size guard passes; only the
    // buffer is wrong. Without a length check this returned "1100" — the two
    // dots that were present packed correctly and every missing dot silently
    // blank, because an out-of-range Uint8Array read yields `undefined`.
    const b: Bitmap = { width: 4, height: 4, data: new Uint8Array(2) };
    b.data[0] = 1;
    b.data[1] = 1;
    expect(() => bitmapToCellHex(b, 2, 1)).toThrow(/2 bytes, expected 16/);
  });

  it("rejects a bitmap whose data is longer than width * height", () => {
    // An oversized buffer is an error too, not something to pack the prefix
    // of: it means the producer computed a different stride or grid than the
    // declared width and height, so the dots we would read are at the wrong
    // offsets and the frame would be wrong while looking plausible.
    const b: Bitmap = { width: 4, height: 4, data: new Uint8Array(32) };
    expect(() => bitmapToCellHex(b, 2, 1)).toThrow(/32 bytes, expected 16/);
  });
});
