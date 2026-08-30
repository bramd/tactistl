import {
  DataCodes,
  DisplayMode,
  DotPadSDK,
  DotPadScanner,
  type DataCodeValue,
  type DisplayModeValue,
  type DotDevice,
  type KeyCodeValue,
} from "./vendor/DotPadSDK-3.0.2";
import { PIN_COLS_PER_CELL, PIN_ROWS_PER_CELL, bitmapToCellHex } from "./packing";
import { SimpleBrailleRenderer } from "./braille";
import { LatestWinsQueue } from "../util/latest-wins";
import type { Bitmap, TactileSink, TextLineRenderer, Transport } from "../tactile/types";

/**
 * The Dot Pad A320's grid, used while nothing is connected so the pipeline has
 * a plausible target to rasterize into before the user picks a device. Once a
 * device is attached its OWN reported cell counts win -- these are a fallback,
 * never a hardcoded truth.
 */
const DEFAULT_CELL_COLUMNS = 30;
const DEFAULT_CELL_ROWS = 10;

/** The A320's text line, used when a device does not report its own width. */
const DEFAULT_BRAILLE_CELLS = 20;

/**
 * How long a single device write may take before we give up on it.
 *
 * This is not a latency budget, it is a deadlock guard. `LatestWinsQueue` runs
 * one send at a time and has no timeout of its own, so a write that never
 * settles stalls it permanently and every later frame is silently dropped --
 * the display freezes on a stale layer with no visible symptom, which for a
 * blind user is indistinguishable from geometry that genuinely did not change.
 *
 * So the value must sit comfortably ABOVE a slow but healthy write, and abort
 * only what is genuinely hung. The worst healthy case is a full 300-cell frame
 * over BLE: ten line commands, each a GATT write on a ~7.5-50 ms connection
 * interval, plus the physical actuation of the pins, which is mechanical and
 * takes appreciable time per line. That lands in the high hundreds of
 * milliseconds to low seconds. Five seconds leaves roughly an order of
 * magnitude of headroom over the measured-in-milliseconds case while still
 * recovering fast enough that a stuck link costs one slider frame, not a
 * session.
 */
const DEFAULT_WRITE_TIMEOUT_MS = 5000;

/**
 * The packet strategy the SDK will use for a given device name.
 *
 * `ALL_PARTIAL` writes several regions of the display in one packet;
 * `SINGLE_LINE` writes one line per packet.
 */
export type ExpectedBufferMode = "ALL_PARTIAL" | "SINGLE_LINE";

/**
 * The model names 3.0.2's `BufferMode.fromDeviceName` treats as multi-region.
 *
 * THIS MIRRORS INTERNAL SDK LOGIC. `BufferMode` is not exported and the chosen
 * mode is not readable from outside, so the only way to tell the user which
 * strategy their unit gets is to re-run the SDK's own rule on the name the
 * device reported. If the vendored SDK is ever updated, this list and the
 * matching rule below must be re-checked against it -- `version-pin.test.ts`
 * is the tripwire that will fail and force that check.
 *
 * The rule as of 3.0.2: case-insensitive SUBSTRING match, not equality --
 * `fromDeviceName` lowercases both the reported name and each model string and
 * asks whether the name contains it.
 */
const MULTI_REGION_MODELS = ["DotPad320C", "DotPad320X", "DotPad300A"];

/**
 * Re-run the SDK's own name rule. See `MULTI_REGION_MODELS` -- this is a
 * mirror of SDK internals, not a reading of SDK state.
 */
export function expectedBufferModeForName(name: string): ExpectedBufferMode {
  const lowered = name.toLowerCase();
  return MULTI_REGION_MODELS.some((model) => lowered.includes(model.toLowerCase()))
    ? "ALL_PARTIAL"
    : "SINGLE_LINE";
}

/** The slice of the SDK this sink uses; injectable so tests can pass a fake. */
export interface DotPadSdkLike {
  connectBleDevice(device: unknown): Promise<DotDevice | null | undefined>;
  connectUsbDevice(port: unknown): Promise<DotDevice | null | undefined>;
  disconnect(device?: DotDevice | null): void;
  displayGraphicData(
    hexData: string,
    device?: DotDevice | null,
    displayMode?: DisplayModeValue,
  ): void;
  displayTextData(
    inputData: string,
    device?: DotDevice | null,
    displayMode?: DisplayModeValue,
    /** Narrowed to `false`: `true` would dynamically import liblouis, which we do not ship. */
    needsTranslation?: false,
  ): Promise<void>;
  setCallBack(
    messageCallBack:
      | ((device: DotDevice, dataCode: DataCodeValue, msg: string) => void)
      | null,
    keyCallBack:
      | ((device: DotDevice, keyCode: KeyCodeValue, msg: string) => void)
      | null,
  ): void;
}

/** The slice of the scanner this sink uses; injectable so tests can pass a fake. */
export interface DotPadScannerLike {
  startBleScan(): Promise<unknown | undefined>;
  startUsbScan(): Promise<unknown | undefined>;
}

export interface DotPadSinkOptions {
  sdk?: DotPadSdkLike;
  scanner?: DotPadScannerLike;
  textRenderer?: TextLineRenderer;
  writeTimeoutMs?: number;
}

export type KeyListener = (keyCode: KeyCodeValue) => void;
export type DisconnectListener = () => void;
export type ErrorListener = (error: unknown) => void;

function unsubscribable<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * The one place in the app that knows a Dot Pad exists.
 *
 * Everything device-specific lives behind `TactileSink`: transport selection,
 * the vendored SDK, the cell packing and the BLE/serial lifecycle. Nothing
 * above this may import from `dotpad/`, which is what lets a later NVDA-side
 * backend be dropped in by constructing a different sink.
 */
export class DotPadSink implements TactileSink {
  private readonly sdk: DotPadSdkLike;
  private readonly scanner: DotPadScannerLike;
  private readonly textRenderer: TextLineRenderer;
  private readonly writeTimeoutMs: number;

  private device: DotDevice | null = null;

  private readonly keyListeners = new Set<KeyListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  /**
   * Whether the last attempted write failed. Latched rather than per-frame: a
   * dropped link during a slider drag produces a failure for every pixel of
   * travel, and announcing each one would bury the user in speech and drown
   * out everything else they need to hear.
   */
  private latchedFailure = false;

  /**
   * The cell hex of the last frame the device ACKNOWLEDGED taking, or null when
   * what it is showing is unknown.
   *
   * This exists because a graphic write is never free, even when it carries no
   * new data. `setDotPadLineCommand` does diff per line and queues nothing for
   * an unchanged one, but `displayGraphicData` sets the refresh mode and sends
   * unconditionally, and reaching the end of the line list runs
   * `graphicRefresh()`: up to six deferred pin re-actuation passes at 500 ms
   * intervals, to counter droop. That cycle cannot be disabled in 3.0.2. So a
   * redundant call costs no payload but physically restarts several seconds of
   * pin movement under the reader's fingers.
   *
   * Deduping on the hex rather than on the bitmap or the render parameters is
   * deliberate: it is the exact payload, so it catches every case where
   * different parameters happen to rasterize to the same dots -- which, at 100
   * scrubber steps across 40 dot rows, is most of a scrub.
   */
  private lastSentHex: string | null = null;

  /**
   * The cell hex of the last TEXT line the device took, or null when unknown.
   *
   * Same class of problem as `lastSentHex`, and deliberately the same shape:
   * `displayTextData` also sends unconditionally, and lands the device in a
   * 1500 ms text refresh cadence that a redundant write restarts under the
   * reader's fingers.
   *
   * The asymmetry is worth stating: the position label changes on most
   * scrubber ticks, so unlike the frame check this one rarely fires. It earns
   * its place in the case where it does -- holding against a clamped scrubber
   * end, or re-entering a position already shown -- and in reading as one
   * pattern with the frame suppression rather than two different rules.
   *
   * Kept separate from `lastSentHex`: the two go to different display modes on
   * different parts of the device, so a frame must never mask a text write.
   */
  private lastSentTextHex: string | null = null;

  /**
   * The device's own reported model name, or null while unknown.
   *
   * Not cosmetic: it is the ONLY way to tell which packet strategy the SDK
   * picked, because `BufferMode.fromDeviceName` keys on this string and
   * exposes neither the choice nor an override. See `expectedBufferMode`.
   */
  private reportedDeviceName: string | null = null;

  /**
   * Names seen through the message callback, keyed by the device they
   * described.
   *
   * This indirection is load-bearing. In 3.0.2 both `connectBleDevice` and
   * `connectUsbDevice` request the name themselves and the connection
   * handshake is gated behind the reply -- `#ce` handles the name and only
   * then emits `Connected`, which is what resolves the connect promise. So the
   * name arrives BEFORE `connect()` returns, at a moment when `this.device` is
   * still null and the sink's usual "is this my device?" filter would discard
   * it. Parking it against the device object instead lets `connect()` claim it
   * the instant it knows which device is ours.
   *
   * Weak so a device that is never adopted -- a failed connect, another
   * consumer of the same SDK instance -- does not pin its name forever.
   */
  private readonly seenDeviceNames = new WeakMap<object, string>();

  private readonly queue: LatestWinsQueue<Bitmap>;

  constructor(options: DotPadSinkOptions = {}) {
    this.sdk = options.sdk ?? new DotPadSDK();
    this.scanner = options.scanner ?? new DotPadScanner();
    this.textRenderer = options.textRenderer ?? new SimpleBrailleRenderer();
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;

    // The queue's default `onError` logs every rejection, which is the
    // per-frame spam the latch exists to prevent. Route failures through the
    // latch instead, which both logs and notifies exactly once per run.
    this.queue = new LatestWinsQueue<Bitmap>(
      (bitmap) => this.writeFrame(bitmap),
      (e) => this.recordFailure(e),
    );

    this.sdk.setCallBack(
      (device, dataCode, msg) => {
        if (dataCode === DataCodes.DeviceName) {
          // Deliberately NOT filtered on `this.device`: this message normally
          // arrives mid-connect, before the sink has a device to compare
          // against. Park it and let `connect()` pick it up; also accept it
          // live, for a device that reports its name later or again.
          if (msg) {
            this.seenDeviceNames.set(device as object, msg);
            if (device === this.device) this.reportedDeviceName = msg;
          }
          return;
        }
        if (dataCode !== DataCodes.Disconnected) return;
        // Some other device on the same SDK instance is not our concern.
        if (device !== this.device) return;
        // Clear the device BEFORE notifying, so a listener that reads
        // `connected` (to update a button label, say) sees the new truth.
        this.device = null;
        // What the pins hold after a drop is unknowable, so the next frame
        // must go out even if the app's state has not moved since.
        this.lastSentHex = null;
        this.lastSentTextHex = null;
        this.reportedDeviceName = null;
        for (const listener of [...this.disconnectListeners]) listener();
      },
      (_device, keyCode) => {
        for (const listener of [...this.keyListeners]) listener(keyCode);
      },
    );
  }

  /**
   * Feature-detected at access time rather than cached, because a sink may
   * outlive the moment it was constructed and because caching would make the
   * value untestable without rebuilding the sink.
   *
   * USB is listed first: it is the faster link, so it is the better default
   * offer. The two gate independently, so a browser with only one of the APIs
   * still gets that one rather than nothing.
   */
  get availableTransports(): Transport[] {
    if (typeof navigator === "undefined") return [];
    const transports: Transport[] = [];
    if ("serial" in navigator) transports.push("usb");
    if ("bluetooth" in navigator) transports.push("ble");
    return transports;
  }

  get connected(): boolean {
    return this.device !== null;
  }

  /**
   * The model name the connected device reported, or null when no device is
   * connected or it has not said.
   */
  get deviceName(): string | null {
    return this.reportedDeviceName;
  }

  /**
   * The packet strategy the SDK will have chosen for `deviceName`, or null
   * while the name is unknown.
   *
   * DERIVED, not read: see `expectedBufferModeForName`. The SDK keeps its
   * choice private, so this replicates the rule rather than reporting it.
   */
  get expectedBufferMode(): ExpectedBufferMode | null {
    const name = this.reportedDeviceName;
    return name === null ? null : expectedBufferModeForName(name);
  }

  /** True while the most recent write failed; cleared by the next success. */
  get failing(): boolean {
    return this.latchedFailure;
  }

  /** The grid in DOTS, from the device's own cell counts where it has any. */
  get grid(): { width: number; height: number } {
    const { cellColumns, cellRows } = this.cellGrid();
    return {
      width: cellColumns * PIN_COLS_PER_CELL,
      height: cellRows * PIN_ROWS_PER_CELL,
    };
  }

  private cellGrid(): { cellColumns: number; cellRows: number } {
    return {
      cellColumns: this.device?.numberCellColumns ?? DEFAULT_CELL_COLUMNS,
      cellRows: this.device?.numberCellRows ?? DEFAULT_CELL_ROWS,
    };
  }

  /**
   * Both Web Serial and Web Bluetooth open their picker only from a user
   * gesture, so this must stay callable straight from a click handler -- no
   * awaiting anything before the scan.
   */
  async connect(transport: Transport): Promise<void> {
    const chosen =
      transport === "usb"
        ? await this.scanner.startUsbScan()
        : await this.scanner.startBleScan();
    // A dismissed picker resolves `undefined`. That is the user saying "not
    // now", not a failure: return normally and stay disconnected.
    if (!chosen) return;

    const device =
      transport === "usb"
        ? await this.sdk.connectUsbDevice(chosen)
        : await this.sdk.connectBleDevice(chosen);
    if (!device) return;

    this.device = device;
    this.latchedFailure = false;
    // A freshly attached device may be blank, or may still hold a previous
    // session's frame. Either way this process has not written to it, so the
    // duplicate check must not suppress the first frame after connecting --
    // that would leave a connected device showing nothing until the user
    // happened to move a control.
    this.lastSentHex = null;
    this.lastSentTextHex = null;
    // The SDK asked for the name as part of its own handshake, so by the time
    // a device is returned the answer has already come through the message
    // callback and been parked. We do NOT ask again: `requestDeviceInfo` would
    // re-enter the SDK's name handler, which rebuilds the line configuration
    // and can clear its per-line diff state -- racing the first frame the app
    // pushes immediately after connecting, for a string we already have.
    this.reportedDeviceName = this.seenDeviceNames.get(device as object) ?? null;
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    if (!device) return;
    this.device = null;
    this.lastSentHex = null;
    this.lastSentTextHex = null;
    this.reportedDeviceName = null;
    this.sdk.disconnect(device);
  }

  renderFrame(bitmap: Bitmap): void {
    if (!this.device) return;
    this.queue.submit(bitmap);
  }

  renderText(text: string): void {
    if (!this.device) return;
    // `renderText` is void by interface, so nothing upstream can await this.
    // Swallowing the rejection would both hide the failure and (under vitest)
    // surface as an unhandled rejection, so it goes through the same latch as
    // frame writes.
    void this.writeText(text).catch((e: unknown) => this.recordFailure(e));
  }

  onKey(listener: KeyListener): () => void {
    return unsubscribable(this.keyListeners, listener);
  }

  onDisconnect(listener: DisconnectListener): () => void {
    return unsubscribable(this.disconnectListeners, listener);
  }

  /**
   * Subscribe to write failures. Fires once when writes start failing and not
   * again until a write has succeeded in between, so the UI can announce the
   * problem accessibly without repeating it per frame.
   */
  onError(listener: ErrorListener): () => void {
    return unsubscribable(this.errorListeners, listener);
  }

  private async writeFrame(bitmap: Bitmap): Promise<void> {
    const device = this.device;
    // The device can vanish between submission and dequeue.
    if (!device) return;
    const { cellColumns, cellRows } = this.cellGrid();
    // A size mismatch throws here, inside the queue's send, so it lands in the
    // latch as a failure rather than escaping into an unhandled rejection.
    const hex = bitmapToCellHex(bitmap, cellColumns, cellRows);
    // Compare here, inside the send, rather than at submission: the queue
    // coalesces, so this compares against what was actually last written to the
    // device rather than against a frame that may never have been sent. A skip
    // deliberately touches the failure latch in neither direction -- nothing
    // was written, so it is evidence of neither a healthy link nor a broken one.
    if (hex === this.lastSentHex) return;
    await this.withTimeout(
      // The SDK's `displayGraphicData` is declared (and, in 3.0.2, is) a
      // synchronous void call, so `Promise.resolve` normally settles at once.
      // Wrapping it anyway costs nothing and means a synchronous throw becomes
      // a rejection, and a transport that ever does return a promise is
      // covered by the timeout without this code changing.
      Promise.resolve(this.sdk.displayGraphicData(hex, device, DisplayMode.GraphicMode)),
      "graphic",
    );
    // Only a write that settled counts. A throw or a timeout leaves the record
    // untouched, so the user re-scrubbing back to the same slice retries it
    // instead of being told, silently, that it is already displayed.
    this.lastSentHex = hex;
    this.clearFailure();
  }

  private async writeText(text: string): Promise<void> {
    const device = this.device;
    if (!device) return;
    const cells = device.numberBrailleCellColumns || DEFAULT_BRAILLE_CELLS;
    const hex = await this.textRenderer.toCellHex(text, cells);
    // Compare on the rendered hex, after the renderer has run and before the
    // device is touched -- the same place, and for the same reason, as the
    // frame check: it is the exact payload, so two labels that braille to the
    // same cells count as the same write. A skip touches the failure latch in
    // neither direction, because nothing was written.
    if (hex === this.lastSentTextHex) return;
    await this.withTimeout(
      // `needsTranslation` is explicitly `false`: we ship our own braille table
      // rather than the SDK's liblouis, which is 13.7 MB and LGPL.
      this.sdk.displayTextData(hex, device, DisplayMode.TextMode, false),
      "text",
    );
    // Recorded only on success, so a throw or a timeout leaves the line
    // eligible to be retried by the next identical label.
    this.lastSentTextHex = hex;
    this.clearFailure();
  }

  private withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Dot Pad ${what} write did not complete within ${this.writeTimeoutMs} ms`,
          ),
        );
      }, this.writeTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private recordFailure(error: unknown): void {
    if (this.latchedFailure) return;
    this.latchedFailure = true;
    for (const listener of [...this.errorListeners]) listener(error);
  }

  private clearFailure(): void {
    this.latchedFailure = false;
  }
}
