import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The vendored SDK's git blob SHA, as reported by
 * `git hash-object web/src/lib/dotpad/vendor/DotPadSDK-3.0.2.js` and by the
 * GitHub contents API for
 * `dotincorp/dotpad-sdk-guide:Web/3.0.2/DotPadSDK-3.0.2.js`.
 */
const EXPECTED_BLOB_SHA = "c1577f36f45ae58d8bcc12d4ea876a20d4dfd9c7";

const SDK_PATH = fileURLToPath(
  new URL("./DotPadSDK-3.0.2.js", import.meta.url),
);

/**
 * Git's blob hash: sha1("blob " + byteLength + "\0" + bytes). Used in
 * preference to a bare sha256 so the pin can be re-checked six months from now
 * with one command -- `git hash-object <file>` -- and compared directly
 * against what GitHub reports for the upstream file, with no bespoke script.
 */
function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

describe("vendored DotPad SDK version pin", () => {
  it("is byte-identical to the upstream 3.0.2 release it was declared against", () => {
    // Read the bytes on disk rather than importing the module: the point is to
    // hash what is committed, not to execute it (it touches navigator.* APIs).
    const actual = gitBlobSha(readFileSync(SDK_PATH));

    expect(
      actual,
      [
        "The vendored DotPad SDK has changed on disk.",
        "",
        "`DotPadSDK-3.0.2.d.ts` next to it is HAND-WRITTEN, and was verified",
        "line by line against this exact build of the SDK -- method names,",
        "argument ORDER, which parameters are optional, and which code paths",
        "avoid loading the liblouis WASM assets we deliberately do not ship.",
        "None of that is checked by the compiler: the declarations describe the",
        "vendored .js, they are not derived from it. A newer SDK dropped in here",
        "would keep type-checking green against declarations that no longer",
        "describe it, and fail at runtime on the device instead.",
        "",
        "So: re-verify every declaration in `DotPadSDK-3.0.2.d.ts` against the",
        "new source BEFORE updating this pin. If the version changed, rename",
        "both files to match. Then set EXPECTED_BLOB_SHA to the output of",
        "`git hash-object` on the new file.",
      ].join("\n"),
    ).toBe(EXPECTED_BLOB_SHA);
  });
});
