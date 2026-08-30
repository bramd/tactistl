// Hand-written declarations for the subset of DotPadSDK 3.0.2 this app uses.
// The SDK's own .d.ts is not usable as-is: it declares `export const X = {...}`
// with initializers, which TypeScript rejects in an ambient context.

export declare const DisplayMode: {
  readonly GraphicMode: "GraphicMode";
  readonly TextMode: "TextMode";
};
export type DisplayModeValue = "GraphicMode" | "TextMode";

export declare const DataCodes: {
  readonly Connected: "Connected";
  readonly ConnectedFail: "ConnectedFail";
  readonly Disconnected: "Disconnected";
  readonly BoardInfo: "BoardInfo";
};
export type DataCodeValue = string;

export declare const KeyCodes: {
  readonly KeyFunction1: "KeyFunction1";
  readonly KeyFunction2: "KeyFunction2";
  readonly KeyFunction3: "KeyFunction3";
  readonly KeyFunction4: "KeyFunction4";
  readonly PanningLeft: "PanningLeft";
  readonly PanningRight: "PanningRight";
};
export type KeyCodeValue = string;

export declare class DotDevice {
  readonly isConnect: boolean;
  readonly cellType: string;
  readonly numberCellRows: number;
  readonly numberCellColumns: number;
  readonly numberBrailleCellColumns: number;
}

export declare class DotPadScanner {
  startBleScan(): Promise<unknown | undefined>;
  startUsbScan(): Promise<unknown | undefined>;
}

export declare class DotPadSDK {
  getConnectedDevices(): DotDevice[];
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
    /**
     * Deliberately narrowed to `false`. The SDK supports braille translation,
     * but passing `true` dynamically imports `./lib/liblouis.js` -- assets we
     * do not ship (13.7 MB of `.data` alone, plus the LGPL relinking
     * obligations that come with redistributing them). That failure would be
     * green at compile time and blow up at RUNTIME, mid device interaction,
     * so the type makes it unrepresentable instead. We translate the short
     * axis labels this app emits with our own minimal table in `../braille.ts`.
     */
    needsTranslation?: false,
  ): Promise<void>;
  displayAllDown(device?: DotDevice | null): void;
  setCallBack(
    messageCallBack:
      | ((device: DotDevice, dataCode: DataCodeValue, msg: string) => void)
      | null,
    keyCallBack:
      | ((device: DotDevice, keyCode: KeyCodeValue, msg: string) => void)
      | null,
  ): void;
}
