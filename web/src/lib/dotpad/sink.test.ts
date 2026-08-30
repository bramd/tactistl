import { afterEach, describe, expect, it, vi } from "vitest";
import { DotPadSink } from "./sink";
import type { Bitmap, TextLineRenderer } from "../tactile/types";

/**
 * The tests never touch the vendored SDK or real hardware: every case drives
 * `DotPadSink` through injected fakes. `sink.ts` still imports the vendor
 * module for its defaults and its `DisplayMode` / `DataCodes` constants, which
 * is safe -- that module has no browser-only top-level code.
 */

type MessageCallback = (device: unknown, dataCode: string, msg: string) => void;
type KeyCallback = (device: unknown, keyCode: string, msg: string) => void;

/** Stands in for a `DotDevice`; only the four fields the sink reads matter. */
function fakeDevice(cellColumns = 30, cellRows = 10, brailleCells = 20) {
  return {
    isConnect: true,
    cellType: "A320",
    numberCellColumns: cellColumns,
    numberCellRows: cellRows,
    numberBrailleCellColumns: brailleCells,
  };
}

function fakes(
  options: {
    device?: ReturnType<typeof fakeDevice>;
    /**
     * When set, the fake reports this model name through the message callback
     * DURING the connect call, before it resolves -- which is what the real
     * SDK does, because its connect handshake is gated on the name reply. The
     * sink therefore sees the name while it still has no device of its own,
     * and a naive "is this my device?" filter would drop it.
     */
    deviceName?: string;
  } = {},
) {
  const device = options.device ?? fakeDevice();
  const graphicCalls: string[] = [];
  const textCalls: string[] = [];
  /** The device each `displayAllDown` was aimed at, one entry per call. */
  const downCalls: unknown[] = [];
  let allDownThrows: string | null = null;
  let graphicResult: Promise<void> | undefined;
  let releaseGraphic: (() => void) | null = null;
  let messageCallBack: MessageCallback | null = null;
  let keyCallBack: KeyCallback | null = null;

  /** Mirrors the SDK: the name lands before the connect promise settles. */
  const reportName = () => {
    if (options.deviceName !== undefined) {
      messageCallBack?.(device, "DeviceName", options.deviceName);
    }
  };

  const sdk = {
    connectUsbDevice: vi.fn(async (_port: unknown) => {
      reportName();
      return device;
    }),
    connectBleDevice: vi.fn(async (_dev: unknown) => {
      reportName();
      return device;
    }),
    disconnect: vi.fn((_device?: unknown) => {}),
    // Declared `void` by the SDK, but returning a promise here is legal (a
    // value-returning function is assignable to a void-returning type) and is
    // exactly how the timeout tests hold a write open.
    displayGraphicData: vi.fn((hex: string) => {
      graphicCalls.push(hex);
      return graphicResult;
    }),
    displayTextData: vi.fn(
      async (
        hex: string,
        _device?: unknown,
        _displayMode?: string,
        _needsTranslation?: false,
      ) => {
        textCalls.push(hex);
      },
    ),
    displayAllDown: vi.fn((device?: unknown) => {
      if (allDownThrows !== null) throw new Error(allDownThrows);
      downCalls.push(device);
    }),
    setCallBack: vi.fn((m: MessageCallback | null, k: KeyCallback | null) => {
      messageCallBack = m;
      keyCallBack = k;
    }),
  };

  const scanner = {
    startUsbScan: vi.fn(async () => ({ port: true }) as unknown),
    startBleScan: vi.fn(async () => ({ ble: true }) as unknown),
  };

  const textRenderer: TextLineRenderer = {
    // The hex MUST depend on the text. A fake that rendered every label to the
    // same bytes would make the duplicate-text tests vacuous: identical output
    // for different labels would be suppressed, and the suppression test would
    // pass without the suppression existing.
    toCellHex: vi.fn(async (text: string, cells: number) => {
      let hex = "";
      for (let i = 0; i < cells; i++) {
        const code = text.length > 0 ? text.charCodeAt(i % text.length) : 0;
        hex += (code & 0xff).toString(16).padStart(2, "0");
      }
      return hex;
    }),
  };

  return {
    device,
    sdk,
    scanner,
    textRenderer,
    graphicCalls,
    textCalls,
    downCalls,
    /** Make the blanking call throw, to exercise the failure latch. */
    failAllDown(message = "clear failed") {
      allDownThrows = message;
    },
    /**
     * Hold graphic writes open until `releaseGraphicWrites` is called, so a
     * test can put something between the SDK call and its completion without
     * racing a timer.
     */
    holdGraphicWrites() {
      graphicResult = new Promise<void>((resolve) => {
        releaseGraphic = resolve;
      });
    },
    /** Let a held graphic write finish. */
    releaseGraphicWrites() {
      const release = releaseGraphic;
      releaseGraphic = null;
      graphicResult = undefined;
      release?.();
    },
    /** Make the next graphic write hang forever, to exercise the timeout. */
    hangGraphicWrites() {
      graphicResult = new Promise<void>(() => {});
    },
    /** Make graphic writes reject, to exercise the failure latch. */
    failGraphicWrites(message = "write failed") {
      graphicResult = Promise.reject(new Error(message));
      // Attach a no-op catch so the shared rejected promise is never an
      // unhandled rejection between the moments the sink awaits it.
      graphicResult.catch(() => {});
    },
    /** Restore healthy synchronous writes. */
    healGraphicWrites() {
      graphicResult = undefined;
    },
    fireMessage(dev: unknown, dataCode: string, msg = "") {
      messageCallBack?.(dev, dataCode, msg);
    },
    fireKey(dev: unknown, keyCode: string) {
      keyCallBack?.(dev, keyCode, "");
    },
  };
}

function makeSink(f: ReturnType<typeof fakes>, writeTimeoutMs = 50) {
  return new DotPadSink({
    sdk: f.sdk,
    scanner: f.scanner,
    textRenderer: f.textRenderer,
    writeTimeoutMs,
  });
}

/** A bitmap of the given dot size, every dot lowered. */
function blankBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(width * height) };
}

/** The same, with one dot raised, so it packs to a different cell hex. */
function dottedBitmap(width: number, height: number): Bitmap {
  const bitmap = blankBitmap(width, height);
  bitmap.data[0] = 1;
  return bitmap;
}

/**
 * Let every already-scheduled continuation run.
 *
 * `vi.waitFor` returns as soon as its condition holds, which for a
 * synchronously-recorded SDK call is BEFORE the write's own continuation has
 * run and updated the sink's record of what the device is showing. Tests about
 * that record have to wait for it, not for the call.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  // A leaked `navigator` stub silently changes what the next test's feature
  // detection sees, which is a classic source of false greens here.
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DotPadSink.availableTransports", () => {
  it("offers USB first when both Web Serial and Web Bluetooth exist", () => {
    vi.stubGlobal("navigator", { serial: {}, bluetooth: {} });
    expect(makeSink(fakes()).availableTransports).toEqual(["usb", "ble"]);
  });

  it("offers only USB when Web Bluetooth is missing", () => {
    vi.stubGlobal("navigator", { serial: {} });
    expect(makeSink(fakes()).availableTransports).toEqual(["usb"]);
  });

  it("offers only BLE when Web Serial is missing", () => {
    vi.stubGlobal("navigator", { bluetooth: {} });
    expect(makeSink(fakes()).availableTransports).toEqual(["ble"]);
  });

  it("offers nothing when neither API exists", () => {
    vi.stubGlobal("navigator", {});
    expect(makeSink(fakes()).availableTransports).toEqual([]);
  });

  it("is detected at access time, not frozen at construction", () => {
    vi.stubGlobal("navigator", {});
    const sink = makeSink(fakes());
    expect(sink.availableTransports).toEqual([]);
    vi.stubGlobal("navigator", { serial: {} });
    expect(sink.availableTransports).toEqual(["usb"]);
  });
});

describe("DotPadSink.connect", () => {
  it("uses the serial scan and connect pair for USB, never the bluetooth one", async () => {
    vi.stubGlobal("navigator", { serial: {}, bluetooth: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    expect(f.scanner.startUsbScan).toHaveBeenCalledTimes(1);
    expect(f.sdk.connectUsbDevice).toHaveBeenCalledTimes(1);
    expect(f.scanner.startBleScan).not.toHaveBeenCalled();
    expect(f.sdk.connectBleDevice).not.toHaveBeenCalled();
    expect(sink.connected).toBe(true);
  });

  it("uses the bluetooth scan and connect pair for BLE, never the serial one", async () => {
    vi.stubGlobal("navigator", { serial: {}, bluetooth: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("ble");
    expect(f.scanner.startBleScan).toHaveBeenCalledTimes(1);
    expect(f.sdk.connectBleDevice).toHaveBeenCalledTimes(1);
    expect(f.scanner.startUsbScan).not.toHaveBeenCalled();
    expect(f.sdk.connectUsbDevice).not.toHaveBeenCalled();
    expect(sink.connected).toBe(true);
  });

  it("treats a dismissed picker as a normal outcome and stays disconnected", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    f.scanner.startUsbScan.mockResolvedValue(undefined);
    const sink = makeSink(f);
    await expect(sink.connect("usb")).resolves.toBeUndefined();
    expect(f.sdk.connectUsbDevice).not.toHaveBeenCalled();
    expect(sink.connected).toBe(false);
  });

  it("stays disconnected when the SDK refuses the chosen device", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    f.sdk.connectUsbDevice.mockResolvedValue(null as never);
    const sink = makeSink(f);
    await sink.connect("usb");
    expect(sink.connected).toBe(false);
  });
});

describe("DotPadSink.grid", () => {
  it("is 60x40 dots before connecting, the Dot Pad A320 default", () => {
    vi.stubGlobal("navigator", {});
    expect(makeSink(fakes()).grid).toEqual({ width: 60, height: 40 });
  });

  it("is 60x40 dots for a device reporting 30x10 cells", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const sink = makeSink(fakes({ device: fakeDevice(30, 10) }));
    await sink.connect("usb");
    expect(sink.grid).toEqual({ width: 60, height: 40 });
  });

  it("is 80x48 dots for a device reporting 40x12 cells", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const sink = makeSink(fakes({ device: fakeDevice(40, 12) }));
    await sink.connect("usb");
    expect(sink.grid).toEqual({ width: 80, height: 48 });
  });

  it("returns to the default after disconnecting", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const sink = makeSink(fakes({ device: fakeDevice(40, 12) }));
    await sink.connect("usb");
    await sink.disconnect();
    expect(sink.grid).toEqual({ width: 60, height: 40 });
    expect(sink.connected).toBe(false);
  });
});

describe("DotPadSink.renderFrame", () => {
  it("sends nothing while disconnected", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(sink.connected).toBe(false));
    expect(f.sdk.displayGraphicData).not.toHaveBeenCalled();
  });

  it("packs a 60x40 bitmap into one 600-character hex write", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    // 30 x 10 cells, one byte per cell, two hex characters per byte.
    expect(f.graphicCalls[0]).toHaveLength(600);
    expect(f.sdk.displayGraphicData).toHaveBeenCalledTimes(1);
  });

  it("reports a bitmap that does not match the device grid instead of sending it", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    const errors: unknown[] = [];
    sink.onError((e) => errors.push(e));
    await sink.connect("usb");
    sink.renderFrame(blankBitmap(80, 48));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(f.sdk.displayGraphicData).not.toHaveBeenCalled();
    expect(sink.failing).toBe(true);
  });
});

describe("DotPadSink write timeout", () => {
  it("does not wedge on a write that never settles, and surfaces the failure", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    vi.useFakeTimers();
    const f = fakes();
    const sink = makeSink(f, 5000);
    const errors: unknown[] = [];
    sink.onError((e) => errors.push(e));
    await sink.connect("usb");

    f.hangGraphicWrites();
    sink.renderFrame(blankBitmap(60, 40));
    await vi.advanceTimersByTimeAsync(4999);
    expect(errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(errors).toHaveLength(1);
    expect(sink.failing).toBe(true);

    // The real proof that the sink is not wedged: the NEXT frame gets through.
    f.healGraphicWrites();
    sink.renderFrame(blankBitmap(60, 40));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.graphicCalls).toHaveLength(2);
    expect(sink.failing).toBe(false);
  });
});

describe("DotPadSink failure latching", () => {
  it("notifies once across a run of failures, then again after a success and a new failure", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    const errors: unknown[] = [];
    sink.onError((e) => errors.push(e));
    await sink.connect("usb");

    f.failGraphicWrites();
    for (let i = 0; i < 5; i++) {
      sink.renderFrame(blankBitmap(60, 40));
      await vi.waitFor(() => expect(f.graphicCalls.length).toBeGreaterThan(i));
    }
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors).toHaveLength(1);
    expect(sink.failing).toBe(true);

    // A success clears the latch...
    f.healGraphicWrites();
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(sink.failing).toBe(false));
    expect(errors).toHaveLength(1);

    // ...so the next run of failures is announced afresh. It has to be a
    // DIFFERENT bitmap: an identical one is suppressed as a duplicate of the
    // frame that just succeeded, and never reaches the device to fail.
    f.failGraphicWrites();
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(sink.failing).toBe(true);
  });

  it("unsubscribes an error listener", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    const errors: unknown[] = [];
    const off = sink.onError((e) => errors.push(e));
    off();
    await sink.connect("usb");
    f.failGraphicWrites();
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(sink.failing).toBe(true));
    expect(errors).toHaveLength(0);
  });
});

describe("DotPadSink.renderText", () => {
  it("sends nothing while disconnected", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    makeSink(f).renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(0));
    expect(f.sdk.displayTextData).not.toHaveBeenCalled();
  });

  it("renders at the device's braille cell count", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes({ device: fakeDevice(30, 10, 24) });
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    expect(f.textRenderer.toCellHex).toHaveBeenCalledWith("z 10.0mm", 24);
    expect(f.textCalls[0]).toHaveLength(48);
  });

  it("never asks the SDK to translate braille itself", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderText("z");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    // liblouis is deliberately not shipped; `true` here would fail at runtime.
    expect(f.sdk.displayTextData.mock.calls[0][3]).toBe(false);
  });

  it("latches a text write failure rather than rejecting into nowhere", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    const errors: unknown[] = [];
    sink.onError((e) => errors.push(e));
    await sink.connect("usb");
    f.sdk.displayTextData.mockRejectedValue(new Error("text write failed"));
    sink.renderText("z");
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(sink.failing).toBe(true);
  });
});

describe("DotPadSink device callbacks", () => {
  it("notifies disconnect listeners and reads as disconnected inside the listener", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    expect(sink.connected).toBe(true);

    let connectedInsideListener: boolean | null = null;
    sink.onDisconnect(() => {
      connectedInsideListener = sink.connected;
    });
    f.fireMessage(f.device, "Disconnected");

    expect(connectedInsideListener).toBe(false);
    expect(sink.connected).toBe(false);
  });

  it("ignores a disconnect reported for some other device", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    const seen: number[] = [];
    sink.onDisconnect(() => seen.push(1));
    f.fireMessage(fakeDevice(), "Disconnected");
    expect(seen).toEqual([]);
    expect(sink.connected).toBe(true);
  });

  it("ignores message codes other than Disconnected", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    const seen: number[] = [];
    sink.onDisconnect(() => seen.push(1));
    f.fireMessage(f.device, "BoardInfo");
    expect(seen).toEqual([]);
    expect(sink.connected).toBe(true);
  });

  it("forwards key codes to key listeners and can unsubscribe them", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    const keys: string[] = [];
    const off = sink.onKey((k) => keys.push(k));
    f.fireKey(f.device, "KeyFunction1");
    f.fireKey(f.device, "PanningRight");
    off();
    f.fireKey(f.device, "KeyFunction2");
    expect(keys).toEqual(["KeyFunction1", "PanningRight"]);
  });
});

describe("DotPadSink duplicate frame suppression", () => {
  it("sends a byte-identical frame only once", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    sink.renderFrame(blankBitmap(60, 40));
    // Asserting "no second call" by waiting is unfalsifiable, so chase the
    // duplicate with a frame that IS different and check what actually landed.
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
    expect(f.graphicCalls[1]).not.toBe(f.graphicCalls[0]);
  });

  it("sends a changed frame after a suppressed duplicate", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
    // And back again: the previous frame is not remembered, only the last one.
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(3));
    expect(f.graphicCalls[2]).toBe(f.graphicCalls[0]);
  });

  it("does not latch a failure or notify listeners when it skips a duplicate", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    const errors: unknown[] = [];
    sink.onError((e) => errors.push(e));
    await sink.connect("usb");

    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    sink.renderFrame(blankBitmap(60, 40));
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
    expect(errors).toEqual([]);
    expect(sink.failing).toBe(false);
  });

  it("retries a frame whose write failed rather than treating it as displayed", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    f.failGraphicWrites();
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(sink.failing).toBe(true));
    expect(f.graphicCalls).toHaveLength(1);

    // A failed write records nothing, so the very same bitmap must go out
    // again -- otherwise re-scrubbing to a failed slice would be a no-op and
    // the device would silently hold a stale frame.
    f.healGraphicWrites();
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(sink.failing).toBe(false));
    expect(f.graphicCalls).toHaveLength(2);
    expect(f.graphicCalls[1]).toBe(f.graphicCalls[0]);
  });

  it("resends the same frame after an explicit disconnect and reconnect", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));

    await sink.disconnect();
    await sink.connect("usb");
    // The pins' physical state across a reconnect is unknown, so the first
    // frame of a session always goes out.
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
    expect(f.graphicCalls[1]).toBe(f.graphicCalls[0]);
  });

  it("resends the same frame after the device drops and is reconnected", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));

    // The unplug path, which goes through the SDK message callback rather
    // than through `disconnect()`.
    f.fireMessage(f.device, "Disconnected");
    expect(sink.connected).toBe(false);
    await sink.connect("usb");
    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
    expect(f.graphicCalls[1]).toBe(f.graphicCalls[0]);
  });
});

describe("DotPadSink duplicate text suppression", () => {
  it("sends a byte-identical text line only once", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    sink.renderText("z 10.0mm");
    // Same trick as the frame case: "no second call" cannot be waited for, so
    // chase the duplicate with a line that IS different and see what landed.
    sink.renderText("z 12.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(2));
    expect(f.textCalls[1]).not.toBe(f.textCalls[0]);
  });

  it("sends a changed label after a suppressed duplicate, and back again", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    sink.renderText("z 12.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(2));
    // Only the LAST line is remembered, so returning to an earlier label sends.
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(3));
    expect(f.textCalls[2]).toBe(f.textCalls[0]);
  });

  it("does not latch a failure or notify listeners when it skips a duplicate", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    const errors: unknown[] = [];
    sink.onError((e) => errors.push(e));
    await sink.connect("usb");

    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    sink.renderText("z 10.0mm");
    sink.renderText("z 12.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(2));
    expect(errors).toEqual([]);
    expect(sink.failing).toBe(false);
  });

  it("retries a line whose write failed rather than treating it as displayed", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    f.sdk.displayTextData.mockRejectedValueOnce(new Error("text write failed"));
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(sink.failing).toBe(true));
    expect(f.textCalls).toHaveLength(0);

    // A failed write records nothing, so the identical label must go out again.
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    expect(sink.failing).toBe(false);
  });

  it("resends the same line after a disconnect and reconnect", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));

    await sink.disconnect();
    await sink.connect("usb");
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(2));
    expect(f.textCalls[1]).toBe(f.textCalls[0]);
  });

  it("resends the same line after the device drops and is reconnected", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));

    f.fireMessage(f.device, "Disconnected");
    await sink.connect("usb");
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(2));
    expect(f.textCalls[1]).toBe(f.textCalls[0]);
  });

  it("keeps the frame and text records apart", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.renderFrame(blankBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    // A frame write must never make a text write look like a duplicate.
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
  });
});

describe("DotPadSink device name and packet strategy", () => {
  it("reports neither before a device is connected", () => {
    vi.stubGlobal("navigator", { serial: {} });
    const sink = makeSink(fakes({ deviceName: "DotPad320X" }));
    expect(sink.deviceName).toBeNull();
    expect(sink.expectedBufferMode).toBeNull();
  });

  it("captures a name reported before the connect call resolves", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes({ deviceName: "DotPad320X" });
    const sink = makeSink(f);
    await sink.connect("usb");
    // The real SDK gates its handshake on this reply, so it arrives while the
    // sink still has no device to match it against.
    expect(sink.deviceName).toBe("DotPad320X");
  });

  it("captures a name reported after connecting", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    expect(sink.deviceName).toBeNull();
    f.fireMessage(f.device, "DeviceName", "DotPad300A");
    expect(sink.deviceName).toBe("DotPad300A");
  });

  it("ignores a name reported for some other device", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes({ deviceName: "DotPad320X" });
    const sink = makeSink(f);
    await sink.connect("usb");
    f.fireMessage(fakeDevice(), "DeviceName", "DotPad320C");
    expect(sink.deviceName).toBe("DotPad320X");
  });

  it("derives multi-region packets for a DotPad320X", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const sink = makeSink(fakes({ deviceName: "DotPad320X" }));
    await sink.connect("usb");
    expect(sink.expectedBufferMode).toBe("ALL_PARTIAL");
  });

  it("derives multi-region packets for a DotPad320C, matching case-insensitively", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    // The SDK lowercases both sides and matches on substring, so a decorated
    // name still resolves -- which is why this is not an equality check.
    const sink = makeSink(fakes({ deviceName: "dotpad320c_1234" }));
    await sink.connect("usb");
    expect(sink.expectedBufferMode).toBe("ALL_PARTIAL");
  });

  it("derives one line per packet for a DotPad320A", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    // Easy to get backwards: DotPad300A is on the multi-region list and
    // DotPad320A is not, despite differing by one character in each half.
    const sink = makeSink(fakes({ deviceName: "DotPad320A" }));
    await sink.connect("usb");
    expect(sink.expectedBufferMode).toBe("SINGLE_LINE");
  });

  it("derives one line per packet for an unknown name", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const sink = makeSink(fakes({ deviceName: "SomeFutureBrailleThing" }));
    await sink.connect("usb");
    expect(sink.expectedBufferMode).toBe("SINGLE_LINE");
  });

  it("clears both on an explicit disconnect", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const sink = makeSink(fakes({ deviceName: "DotPad320X" }));
    await sink.connect("usb");
    await sink.disconnect();
    expect(sink.deviceName).toBeNull();
    expect(sink.expectedBufferMode).toBeNull();
  });

  it("clears both when the device drops", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes({ deviceName: "DotPad320X" });
    const sink = makeSink(f);
    await sink.connect("usb");
    f.fireMessage(f.device, "Disconnected");
    expect(sink.deviceName).toBeNull();
    expect(sink.expectedBufferMode).toBeNull();
  });
});

describe("DotPadSink clear", () => {
  it("lowers every pin on the connected device", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.clear();

    expect(f.sdk.displayAllDown).toHaveBeenCalledTimes(1);
    // Aimed at OUR device, never at the SDK's "every attached device"
    // overload: another consumer's display is not ours to blank.
    expect(f.downCalls).toEqual([f.device]);
  });

  it("does nothing while disconnected", () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);

    sink.clear();

    expect(f.sdk.displayAllDown).not.toHaveBeenCalled();
  });

  it("resends a frame identical to the one that was cleared away", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    // The write must be fully recorded before the clear, or this would pass
    // for the wrong reason: a cache never written to needs no resetting.
    await settle();

    sink.clear();

    // THE case this method exists to survive. The pins are down now, so the
    // frame the sink last sent is no longer what the device is showing --
    // suppressing it as a duplicate would leave a connected display blank,
    // which to a blind reader is indistinguishable from a dead link.
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
    expect(f.graphicCalls[1]).toBe(f.graphicCalls[0]);
  });

  it("resends a text line identical to the one that was cleared away", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(1));
    await settle();

    sink.clear();

    // Separate cache, same trap: the SDK's `displayAllDown` blanks the braille
    // line too, so the label the fingers were on is gone from the device.
    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(2));
    expect(f.textCalls[1]).toBe(f.textCalls[0]);
  });

  it("latches a failed clear rather than throwing into the caller", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    const errors: unknown[] = [];
    sink.onError((e) => errors.push(e));
    await sink.connect("usb");
    f.failAllDown();

    // The pipeline calls this from a microtask with nothing catching around
    // it, so a synchronous throw would escape as an unhandled error.
    expect(() => sink.clear()).not.toThrow();
    expect(sink.failing).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("still forces the next frame out when the clear itself failed", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));
    await settle();

    f.failAllDown();
    sink.clear();

    // A clear that threw may have moved the pins part of the way, or not at
    // all. Either way what the device holds is now unknown, so the safe
    // direction is to resend rather than to assume the old frame survived.
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
  });
  it("does not let a frame still in flight undo the clear", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    // A write records what the device is showing only once it has SETTLED, so
    // there is a real window in which the pins change under a write that has
    // not finished. Blanking inside that window is the window's worst case.
    f.holdGraphicWrites();
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(1));

    sink.clear();
    f.releaseGraphicWrites();
    await settle();

    // Without the epoch check, that late completion writes the pre-clear frame
    // back into the cache the clear just emptied, and this frame is suppressed
    // -- leaving a connected display blank, the exact symptom clear() exists
    // to prevent.
    sink.renderFrame(dottedBitmap(60, 40));
    await vi.waitFor(() => expect(f.graphicCalls).toHaveLength(2));
  });

  it("does not let a text line still in flight undo the clear", async () => {
    vi.stubGlobal("navigator", { serial: {} });
    const f = fakes();
    const sink = makeSink(f);
    await sink.connect("usb");

    // The text path has no hold hook, but it does not need one: the renderer
    // is async, so clearing before the awaited render resolves puts the clear
    // inside the same window.
    sink.renderText("z 10.0mm");
    sink.clear();
    await settle();

    sink.renderText("z 10.0mm");
    await vi.waitFor(() => expect(f.textCalls).toHaveLength(2));
    expect(f.textCalls[1]).toBe(f.textCalls[0]);
  });
});
