import { describe, expect, it } from "vitest";
import { cobsDecode, cobsEncode, decodeEnvelope, DeviceFrameDecoder, encodeEnvelope } from "../src/core/protocol";
import type { DeviceEnvelope } from "../src/core/types";

const envelope: DeviceEnvelope = { protocol: 1, epoch: 7, sequence: 9, type: "widget.snapshot", sentAt: 1234, payload: { text: "zero\0inside", value: 42 } };

describe("device framing", () => {
  it("round trips COBS including embedded zero bytes", () => {
    const source = Uint8Array.from([0, 1, 2, 0, 3, 0]);
    expect(cobsDecode(cobsEncode(source))).toEqual(source);
  });

  it("round trips a CBOR envelope and supports split serial chunks", () => {
    const frame = encodeEnvelope(envelope);
    expect(decodeEnvelope(frame.slice(0, -1))).toEqual(envelope);
    const decoder = new DeviceFrameDecoder();
    expect(decoder.push(frame.slice(0, 4))).toEqual([]);
    expect(decoder.push(frame.slice(4))).toEqual([envelope]);
  });

  it("rejects corruption", () => {
    const frame = encodeEnvelope(envelope);
    frame[3] = (frame[3] || 0) ^ 0x40;
    expect(() => decodeEnvelope(frame.slice(0, -1))).toThrow();
  });

  it("recovers after a corrupt serial frame without reconnecting", () => {
    const corrupt = encodeEnvelope(envelope);
    corrupt[3] = (corrupt[3] || 0) ^ 0x40;
    const decoder = new DeviceFrameDecoder();
    expect(() => decoder.push(corrupt)).toThrow();
    expect(decoder.push(encodeEnvelope(envelope))).toEqual([envelope]);
  });

  it("round trips binary camera chunks", () => {
    const cameraChunk: DeviceEnvelope = {
      protocol: 1,
      epoch: 8,
      sequence: 10,
      type: "camera.chunk",
      sentAt: 5678,
      payload: { requestId: "capture-1", offset: 0, data: Uint8Array.from([0xff, 0xd8, 0, 1, 0xff, 0xd9]) },
    };
    expect(decodeEnvelope(encodeEnvelope(cameraChunk).slice(0, -1))).toEqual(cameraChunk);
  });
});
