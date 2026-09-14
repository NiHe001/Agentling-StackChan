import { Decoder, Encoder } from "cbor-x";
import type { DeviceEnvelope } from "./types";

const cborEncoder = new Encoder({ useRecords: false });
const cborDecoder = new Decoder({ mapsAsObjects: true });

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function cobsEncode(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length + Math.ceil(input.length / 254) + 1);
  let read = 0;
  let write = 1;
  let codeIndex = 0;
  let code = 1;

  while (read < input.length) {
    if (input[read] === 0) {
      output[codeIndex] = code;
      codeIndex = write;
      write += 1;
      code = 1;
      read += 1;
    } else {
      output[write] = input[read] as number;
      write += 1;
      read += 1;
      code += 1;
      if (code === 0xff) {
        output[codeIndex] = code;
        codeIndex = write;
        write += 1;
        code = 1;
      }
    }
  }
  output[codeIndex] = code;
  return output.slice(0, write);
}

export function cobsDecode(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length);
  let read = 0;
  let write = 0;

  while (read < input.length) {
    const code = input[read] as number;
    if (code === 0 || read + code > input.length + 1) throw new Error("invalid COBS frame");
    read += 1;
    for (let index = 1; index < code; index += 1) {
      if (read >= input.length) throw new Error("truncated COBS frame");
      output[write++] = input[read++] as number;
    }
    if (code !== 0xff && read < input.length) output[write++] = 0;
  }
  return output.slice(0, write);
}

export function encodeEnvelope(envelope: DeviceEnvelope): Uint8Array {
  const payload = cborEncoder.encode(envelope);
  const packet = new Uint8Array(payload.length + 4);
  packet.set(payload, 0);
  new DataView(packet.buffer).setUint32(payload.length, crc32(payload), false);
  const framed = cobsEncode(packet);
  const result = new Uint8Array(framed.length + 1);
  result.set(framed, 0);
  result[result.length - 1] = 0;
  return result;
}

export function decodeEnvelope(frame: Uint8Array): DeviceEnvelope {
  const decoded = cobsDecode(frame);
  if (decoded.length < 5) throw new Error("device frame is too short");
  const payload = decoded.slice(0, -4);
  const expected = new DataView(
    decoded.buffer,
    decoded.byteOffset + decoded.length - 4,
    4,
  ).getUint32(0, false);
  const actual = crc32(payload);
  if (actual !== expected) throw new Error("device frame CRC mismatch");
  const envelope = cborDecoder.decode(payload) as DeviceEnvelope;
  if (envelope.protocol !== 1) throw new Error(`unsupported protocol ${envelope.protocol}`);
  return envelope;
}

export class DeviceFrameDecoder {
  private buffered: number[] = [];

  push(chunk: Uint8Array): Array<DeviceEnvelope> {
    const messages: DeviceEnvelope[] = [];
    for (const byte of chunk) {
      if (byte === 0) {
        if (this.buffered.length > 0) {
          // Clear before decoding so one corrupt USB frame cannot poison every
          // later frame until the serial port is reconnected.
          const frame = Uint8Array.from(this.buffered);
          this.buffered = [];
          messages.push(decodeEnvelope(frame));
        }
      } else {
        if (this.buffered.length >= 256 * 1024) {
          this.buffered = [];
          throw new Error("device frame exceeds 256 KiB");
        }
        this.buffered.push(byte);
      }
    }
    return messages;
  }
}
