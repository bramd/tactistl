import type { TextLineRenderer } from "../tactile/types";

/**
 * Braille cell bytes for the device's text line.
 *
 * Bit N of the byte is dot N+1, the standard 8-dot ordering: bit 0 = dot 1,
 * bit 1 = dot 2, ... bit 6 = dot 7, bit 7 = dot 8. This is the layout the SDK
 * uses for text cells, and is NOT the graphic-area pin layout in packing.ts.
 */
function dots(...ds: number[]): number {
  return ds.reduce((byte, d) => byte | (1 << (d - 1)), 0);
}

const NUMBER_SIGN = dots(3, 4, 5, 6);
const CAPITAL_SIGN = dots(6);
/** UEB grade 1 indicator, needed before a letter a-j that follows a digit. */
const GRADE_1_SIGN = dots(5, 6);
const BLANK = 0;

/** Letters a-j double as digits 1-9 and 0 after a number sign. */
const LETTERS: Record<string, number> = {
  a: dots(1),
  b: dots(1, 2),
  c: dots(1, 4),
  d: dots(1, 4, 5),
  e: dots(1, 5),
  f: dots(1, 2, 4),
  g: dots(1, 2, 4, 5),
  h: dots(1, 2, 5),
  i: dots(2, 4),
  j: dots(2, 4, 5),
  k: dots(1, 3),
  l: dots(1, 2, 3),
  m: dots(1, 3, 4),
  n: dots(1, 3, 4, 5),
  o: dots(1, 3, 5),
  p: dots(1, 2, 3, 4),
  q: dots(1, 2, 3, 4, 5),
  r: dots(1, 2, 3, 5),
  s: dots(2, 3, 4),
  t: dots(2, 3, 4, 5),
  u: dots(1, 3, 6),
  v: dots(1, 2, 3, 6),
  w: dots(2, 4, 5, 6),
  x: dots(1, 3, 4, 6),
  y: dots(1, 3, 4, 5, 6),
  z: dots(1, 3, 5, 6),
};

const DIGITS = "jabcdefghi"; // index by the digit's value

/** The letters that share a cell with a digit, so are ambiguous after one. */
const DIGIT_LETTERS = "abcdefghij";

/**
 * The decimal point is dots 256 in UEB. Older English Braille American Edition
 * used dots 46 for it; this table is UEB throughout.
 *
 * No entry for "/": the UEB solidus is the two-cell dots 456 then dots 34, and
 * every other entry here is a single cell, so supporting it would mean teaching
 * the loop variable-width symbols for a character no label uses. Omitted
 * deliberately, not forgotten. Dots 34 alone is the EBAE slash (and the "st"
 * contraction), so mapping it that way would be worse than leaving it blank.
 */
const PUNCTUATION: Record<string, number> = {
  " ": BLANK,
  ".": dots(2, 5, 6),
  ",": dots(2),
  "-": dots(3, 6),
};

/**
 * A minimal uncontracted-braille renderer for the short axis labels this app
 * emits (for example "Z 12.4 mm"). It covers letters, digits, and the few
 * punctuation marks those labels use — nothing more.
 *
 * It exists so the app does not have to ship liblouis (several megabytes of
 * WASM plus LGPL redistribution obligations) to print one short line. Swap in
 * a liblouis-backed TextLineRenderer here if full braille translation is ever
 * needed; nothing else in the app has to change.
 */
export class SimpleBrailleRenderer implements TextLineRenderer {
  async toCellHex(text: string, cells: number): Promise<string> {
    const out: number[] = [];
    let numeric = false;

    // An indicator and the cell it marks travel together: emitting one with no
    // room left for its letter or digit would strand a cell that means nothing
    // on its own. Stopping a character earlier is the cleaner truncation.
    const roomForPair = () => out.length + 2 <= cells;

    for (const ch of text) {
      if (out.length >= cells) break;

      if (ch >= "0" && ch <= "9") {
        if (!numeric) {
          if (!roomForPair()) break;
          out.push(NUMBER_SIGN);
          numeric = true;
        }
        out.push(LETTERS[DIGITS[Number(ch)]]);
        continue;
      }

      // A decimal point between digits stays inside numeric mode. A comma does
      // too in UEB (as a thousands separator); this exits and re-issues the
      // number sign instead, which is unambiguous but nonstandard. No label
      // this app emits uses thousands separators.
      if (ch === "." && numeric) {
        out.push(PUNCTUATION["."]);
        continue;
      }

      const lower = ch.toLowerCase();
      const letter = LETTERS[lower];

      if (letter !== undefined && ch !== lower) {
        // Each capital gets its own dot 6 rather than the UEB capitalized-word
        // indicator. Correct, if verbose for a run of capitals; axis names are
        // single letters.
        numeric = false;
        if (!roomForPair()) break;
        out.push(CAPITAL_SIGN);
        out.push(letter);
        continue;
      }

      if (letter !== undefined) {
        // a-j share their cells with the digits, so one directly after a digit
        // would read as another digit ("0.5in" as "0.59n"). UEB marks it with
        // the grade 1 indicator. k-z cannot be confused with a digit and must
        // NOT get one. A space has already ended numeric mode by this point,
        // so only a letter abutting a digit is affected.
        if (numeric && DIGIT_LETTERS.includes(lower)) {
          if (!roomForPair()) break;
          out.push(GRADE_1_SIGN);
        }
        numeric = false;
        out.push(letter);
        continue;
      }

      numeric = false;
      out.push(PUNCTUATION[ch] ?? BLANK);
    }

    while (out.length < cells) out.push(BLANK);
    return out
      .slice(0, cells)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
