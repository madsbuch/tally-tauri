/// <reference types="vite/client" />

// heic-decode ships no types. It decodes a HEIC/HEIF buffer to raw RGBA pixels.
declare module "heic-decode" {
  interface DecodeResult {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  function decode(input: { buffer: Uint8Array }): Promise<DecodeResult>;
  export default decode;
}
