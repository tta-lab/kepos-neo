import * as b4a from "b4a";
import { parseEnvelope, type HostEnvelope } from "./messages.js";

export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

export function encodeFrame(envelope: HostEnvelope): Uint8Array {
  const payload = b4a.from(
    JSON.stringify(parseEnvelope(envelope)),
    "utf8",
  );
  if (payload.byteLength === 0 || payload.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw new Error("control frame payload is outside the allowed size");
  }
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}

export class FrameDecoder {
  private buffered = new Uint8Array(0);

  push(chunk: Uint8Array): HostEnvelope[] {
    const combined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    combined.set(this.buffered);
    combined.set(chunk, this.buffered.byteLength);
    this.buffered = combined;

    const envelopes: HostEnvelope[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= 4) {
      const length = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset + offset,
        4,
      ).getUint32(0);
      if (length === 0 || length > MAX_CONTROL_FRAME_BYTES) {
        throw new Error("control frame length is outside the allowed size");
      }
      if (this.buffered.byteLength - offset - 4 < length) break;
      const payload = this.buffered.subarray(offset + 4, offset + 4 + length);
      let value: unknown;
      try {
        const decoded = b4a.toString(payload, "utf8");
        if (!b4a.equals(b4a.from(decoded, "utf8"), payload)) {
          throw new Error("invalid UTF-8");
        }
        value = JSON.parse(decoded) as unknown;
      } catch (error) {
        throw new Error("control frame payload is not valid UTF-8 JSON", {
          cause: error,
        });
      }
      envelopes.push(parseEnvelope(value));
      offset += 4 + length;
    }
    this.buffered = this.buffered.slice(offset);
    return envelopes;
  }
}
