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

function fakes(options: { device?: ReturnType<typeof fakeDevice> } = {}) {
  const device = options.device ?? fakeDevice();
  const graphicCalls: string[] = [];
  const textCalls: string[] = [];
  let graphicResult: Promise<void> | undefined;
  let messageCallBack: MessageCallback | null = null;
  let keyCallBack: KeyCallback | null = null;

  const sdk = {
    connectUsbDevice: vi.fn(async (_port: unknown) => device),
    connectBleDevice: vi.fn(async (_dev: unknown) => device),
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
    toCellHex: vi.fn(async (_text: string, cells: number) => "aa".repeat(cells)),
  };

  return {
    device,
    sdk,
    scanner,
    textRenderer,
    graphicCalls,
    textCalls,
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
    fireMessage(dev: unknown, dataCode: string) {
      messageCallBack?.(dev, dataCode, "");
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

    // ...so the next run of failures is announced afresh.
    f.failGraphicWrites();
    sink.renderFrame(blankBitmap(60, 40));
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
