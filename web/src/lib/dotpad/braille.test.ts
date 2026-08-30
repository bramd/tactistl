import { describe, expect, it } from "vitest";
import { SimpleBrailleRenderer } from "./braille";

const r = new SimpleBrailleRenderer();

describe("SimpleBrailleRenderer", () => {
  it("renders a lowercase letter", async () => {
    // 'a' is dot 1 = 0x01, padded to 3 cells.
    expect(await r.toCellHex("a", 3)).toBe("010000");
  });

  it("prefixes numbers with the number sign", async () => {
    // number sign (dots 3456 = 0x3c), then 'a' (1) and 'b' (2).
    expect(await r.toCellHex("12", 3)).toBe("3c0103");
  });

  it("does not repeat the number sign within one number", async () => {
    // #, 1, ., 4  -> 4 cells. Decimal point is dots 256 = 0x32.
    expect(await r.toCellHex("1.4", 4)).toBe("3c013219");
  });

  it("leaves numeric mode after a space", async () => {
    const hex = await r.toCellHex("1 2", 5);
    // #,1,space,#,2
    expect(hex).toBe("3c0100" + "3c03");
  });

  it("marks a capital with the capital sign", async () => {
    // capital sign (dot 6 = 0x20) then 'z' (dots 1356 = 0x35).
    expect(await r.toCellHex("Z", 3)).toBe("203500");
  });

  it("renders a realistic axis label", async () => {
    const hex = await r.toCellHex("Z 12.4 mm", 20);
    // 20 cells, 2 hex characters each.
    expect(hex).toHaveLength(40);
    // Starts with the capital sign and 'z'.
    expect(hex.startsWith("2035")).toBe(true);
  });

  it("pads short text to the full cell count", async () => {
    expect(await r.toCellHex("a", 20)).toHaveLength(40);
  });

  it("truncates text longer than the cell count", async () => {
    expect(await r.toCellHex("abcdefghij", 4)).toHaveLength(8);
  });

  it("renders an unknown character as a blank cell", async () => {
    expect(await r.toCellHex("~", 1)).toBe("00");
  });

  it("marks a letter a-j after a digit with the grade 1 indicator", async () => {
    // #,0,.,5 then the grade 1 indicator (dots 56 = 0x30), 'i', 'n'.
    // Without it the 'i' cell reads as the digit 9: "0.59n".
    expect(await r.toCellHex("0.5in", 7)).toBe("3c1a3211" + "300a" + "1d");
  });

  it("re-enters numeric mode after a grade 1 marked letter", async () => {
    // #,1,grade 1,e,#,3 -- the marked letter ended numeric mode.
    expect(await r.toCellHex("1e3", 6)).toBe("3c01" + "3011" + "3c09");
  });

  it("does not mark a letter k-z after a digit", async () => {
    // #,1,2,m,m -- 'm' cannot be confused with a digit, so no indicator.
    expect(await r.toCellHex("12mm", 5)).toBe("3c0103" + "0d0d");
  });

  it("does not mark a letter after a space", async () => {
    // The space already terminated numeric mode, so 'i' needs no indicator.
    expect(await r.toCellHex("0.5 in", 7)).toBe("3c1a3211" + "00" + "0a1d");
  });

  it("renders a slash as a blank cell", async () => {
    // Dots 34 is the EBAE slash, not the UEB one; deliberately unsupported.
    expect(await r.toCellHex("/", 1)).toBe("00");
  });

  it("drops a prefix with no room for the letter it marks", async () => {
    // A lone indicator is meaningless, so truncate one character earlier.
    expect(await r.toCellHex("Z", 1)).toBe("00");
    expect(await r.toCellHex("1", 1)).toBe("00");
  });
});
