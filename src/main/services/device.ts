import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SerialPort } from "serialport";
import { DeviceFrameDecoder, encodeEnvelope } from "../../core/protocol";
import { resolveLayout } from "../../core/layout";
import type {
  AgentSnapshot,
  CompiledPack,
  DeviceCapabilities,
  DeviceEnvelope,
  DeviceStatus,
  ExpressionOverlay,
  UsageSnapshot,
  WeatherSnapshot,
  ClockSnapshot,
} from "../../core/types";
import type { HostConfig } from "../config";

const PACK_CHUNK_BYTES = 1024;
const SERIAL_DEBUG = process.env.AGENTLING_SERIAL_DEBUG === "1";

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

export class DeviceService extends EventEmitter {
  private port: SerialPort | null = null;
  private readonly decoder = new DeviceFrameDecoder();
  private epoch = Math.floor(Date.now() / 1_000);
  private sequence = 0;
  private lastReceivedSequence = 0;
  private lastAcknowledgedSequence = 0;
  private readonly pendingAcks = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private status: DeviceStatus = { connected: false };

  constructor(private readonly config: HostConfig["device"]) {
    super();
  }

  async start(): Promise<void> {
    if (!this.config.autoConnect) return;
    const ports = await this.listPorts();
    const preferred = this.config.preferredPath
      ? ports.find((port) => port.path === this.config.preferredPath)
      : undefined;
    const recognized = ports.filter((port) => /m5stack/i.test(port.manufacturer || ""));
    const candidate = preferred ?? (recognized.length === 1 ? recognized[0] : undefined);
    if (candidate) await this.connect(candidate.path).catch((error) => this.setError(error));
  }

  async stop(): Promise<void> {
    await this.disconnect();
  }

  async listPorts(): Promise<SerialPortInfo[]> {
    return (await SerialPort.list()).map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      vendorId: port.vendorId,
      productId: port.productId,
    }));
  }

  async connect(portPath: string): Promise<DeviceStatus> {
    await this.disconnect();
    this.epoch = Math.floor(Date.now() / 1_000);
    this.sequence = 0;
    this.lastAcknowledgedSequence = 0;
    this.port = new SerialPort({ path: portPath, baudRate: this.config.baudRate, autoOpen: false });
    this.port.on("data", (chunk: Buffer) => this.onData(chunk));
    this.port.on("error", (error) => this.setError(error));
    this.port.on("close", () => {
      this.port = null;
      this.status = { connected: false, path: portPath };
      this.emit("status", this.current());
    });
    await new Promise<void>((resolve, reject) => this.port?.open((error) => (error ? reject(error) : resolve())));
    this.status = { connected: false, path: portPath };
    this.emit("status", this.current());
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("ready", onReady);
        reject(new Error("Serial device did not answer the Agentling handshake within 5 seconds"));
      }, 5_000);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("ready", onReady);
    });
    this.send("device.hello", { client: "agentling-desktop", protocol: 1 });
    try {
      await ready;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
    return this.current();
  }

  async disconnect(): Promise<void> {
    const port = this.port;
    this.port = null;
    if (port?.isOpen) {
      await new Promise<void>((resolve) => port.close(() => resolve()));
    }
    if (this.status.connected) {
      this.status = { connected: false, path: this.status.path };
      this.emit("status", this.current());
    }
    this.rejectPendingAcks(new Error("StackChan disconnected"));
  }

  current(): DeviceStatus {
    return structuredClone(this.status);
  }

  sendAgentSnapshot(snapshot: AgentSnapshot): void {
    this.send("agent.snapshot", snapshot);
  }

  sendWidgetSnapshot(payload: {
    usage: UsageSnapshot;
    clock: ClockSnapshot;
    weather: WeatherSnapshot;
  }): void {
    this.send("widget.snapshot", payload);
  }

  sendActionCue(payload: {
    behavior?: string;
    event?: string;
    overlay?: ExpressionOverlay | null;
    payload?: Record<string, unknown>;
  }): void {
    this.send("action.cue", payload);
  }

  async syncPack(pack: CompiledPack): Promise<void> {
    if (!this.port?.isOpen) throw new Error("StackChan is not connected");
    const runtime = Buffer.from(
      JSON.stringify({
        manifest: pack.manifest,
        ui: {
          ...pack.ui,
          layouts: Object.fromEntries(
            Object.keys(pack.ui.layouts).map((name) => [name, { widgets: resolveLayout(pack.ui, name) }]),
          ),
        },
        events: pack.events,
        behaviors: pack.behaviors,
        motions: pack.motions,
        sounds: pack.sounds,
        lights: pack.lights,
        visuals: pack.visuals,
      }),
      "utf8",
    );
    const runtimeFile = {
      path: "pack.runtime.json",
      size: runtime.length,
      sha256: createHash("sha256").update(runtime).digest("hex"),
    };
    await this.sendReliable("pack.manifest", {
      id: pack.manifest.id,
      version: pack.manifest.version,
      protocol: pack.manifest.protocol,
      files: [...pack.files, runtimeFile],
    });
    for (const file of pack.files) {
      const bytes = await fs.readFile(path.join(pack.sourceDir, file.path));
      for (let offset = 0; offset < bytes.length; offset += PACK_CHUNK_BYTES) {
        await this.sendReliable("pack.chunk", {
          path: file.path,
          offset,
          data: bytes.subarray(offset, Math.min(offset + PACK_CHUNK_BYTES, bytes.length)),
        });
      }
    }
    for (let offset = 0; offset < runtime.length; offset += PACK_CHUNK_BYTES) {
      await this.sendReliable("pack.chunk", {
        path: runtimeFile.path,
        offset,
        data: runtime.subarray(offset, Math.min(offset + PACK_CHUNK_BYTES, runtime.length)),
      });
    }
    await this.sendReliable("pack.commit", { id: pack.manifest.id, version: pack.manifest.version });
  }

  private send(type: DeviceEnvelope["type"], payload: unknown): number {
    if (!this.port?.isOpen) return 0;
    const envelope: DeviceEnvelope = {
      protocol: 1,
      epoch: this.epoch,
      sequence: ++this.sequence,
      ack: this.lastReceivedSequence || undefined,
      type,
      sentAt: Date.now(),
      payload,
    };
    this.port.write(Buffer.from(encodeEnvelope(envelope)));
    return envelope.sequence;
  }

  private async sendReliable(type: DeviceEnvelope["type"], payload: unknown): Promise<void> {
    if (SERIAL_DEBUG) {
      const chunk = payload as { path?: string; offset?: number; data?: Uint8Array };
      console.log(
        `[agentling:serial] send ${type}`,
        chunk.path ? `${chunk.path}@${chunk.offset ?? 0}+${chunk.data?.byteLength ?? 0}` : "",
      );
    }
    const sequence = this.send(type, payload);
    if (!sequence) throw new Error("StackChan is not connected");
    if (sequence <= this.lastAcknowledgedSequence) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(sequence);
        reject(new Error(`StackChan did not acknowledge ${type} (${sequence})`));
      }, 5_000);
      timer.unref();
      this.pendingAcks.set(sequence, { resolve, reject, timer });
    });
  }

  private onData(chunk: Uint8Array): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        this.lastReceivedSequence = Math.max(this.lastReceivedSequence, message.sequence);
        if (message.ack !== undefined) this.acknowledge(message.ack);
        if (message.type === "device.hello") {
          const hello = message.payload as {
            firmwareVersion?: string;
            protocolVersion?: number;
            capabilities?: DeviceCapabilities;
          };
          this.status = {
            ...this.status,
            connected: true,
            firmwareVersion: hello.firmwareVersion,
            protocolVersion: hello.protocolVersion,
            capabilities: hello.capabilities,
            error: undefined,
          };
          this.emit("status", this.current());
          this.emit("ready");
        } else if (message.type === "input.event") {
          this.emit("input", message.payload);
        } else if (message.type === "error") {
          const messageText = String((message.payload as { message?: string }).message || "device error");
          if (SERIAL_DEBUG) console.error(`[agentling:serial] device error: ${messageText}`);
          this.setError(new Error(messageText));
        }
      }
    } catch (error) {
      this.setError(error);
    }
  }

  private setError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.rejectPendingAcks(normalized);
    this.status = {
      ...this.status,
      error: normalized.message,
    };
    this.emit("status", this.current());
  }

  private acknowledge(sequence: number): void {
    this.lastAcknowledgedSequence = Math.max(this.lastAcknowledgedSequence, sequence);
    for (const [pendingSequence, pending] of this.pendingAcks) {
      if (pendingSequence > this.lastAcknowledgedSequence) continue;
      clearTimeout(pending.timer);
      this.pendingAcks.delete(pendingSequence);
      pending.resolve();
    }
  }

  private rejectPendingAcks(error: Error): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingAcks.clear();
  }
}
