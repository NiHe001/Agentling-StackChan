import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SerialPort } from "serialport";
import { DeviceEventQueue } from "../../core/device-events";
import { DeviceFrameDecoder, encodeEnvelope } from "../../core/protocol";
import { resolveLayout } from "../../core/layout";
import type {
  AgentSnapshot,
  CompiledPack,
  DeviceCapabilities,
  DeviceEnvelope,
  DeviceStatus,
  DeviceInputEvent,
  ExpressionOverlay,
  HardwareCommandResult,
  SensorSnapshot,
  CameraCaptureResult,
  UsageSnapshot,
  WeatherSnapshot,
  ClockSnapshot,
} from "../../core/types";
import type { HostConfig } from "../config";

// Keep enough headroom for CBOR/COBS and ESP32 allocation pressure while
// halving the ACK count versus the original 1 KiB transfer.
const PACK_CHUNK_BYTES = 2 * 1024;
const SERIAL_DEBUG = process.env.AGENTLING_SERIAL_DEBUG === "1";
const CAMERA_MAX_BYTES = 1024 * 1024;

export function packContentDigest(files: Array<{ path: string; size: number; sha256: string }>): string {
  // Include the generated runtime file as well as assets: changing behavior
  // or layout must invalidate a cached pack even if its version is unchanged.
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update("\0").update(String(file.size)).update("\0").update(file.sha256).update("\n");
  }
  return hash.digest("hex");
}

interface PendingSensorRequest {
  resolve(value: SensorSnapshot): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingCameraRequest {
  resolve(value: CameraCaptureResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  chunks: Array<{ offset: number; data: Uint8Array }>;
}

interface PendingHardwareRequest {
  resolve(value: HardwareCommandResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

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
  private syncingPack = false;
  private readonly inputEvents = new DeviceEventQueue();
  private readonly pendingSensorRequests = new Map<string, PendingSensorRequest>();
  private readonly pendingCameraRequests = new Map<string, PendingCameraRequest>();
  private readonly pendingHardwareRequests = new Map<string, PendingHardwareRequest>();
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
    let lastError: unknown;
    // USB CDC may re-enumerate just after the desktop process starts. A few
    // bounded retries avoid requiring a manual scan without creating a
    // permanent background reconnect loop.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ports = await this.listPorts();
      const preferred = this.config.preferredPath
        ? ports.find((port) => port.path === this.config.preferredPath)
        : undefined;
      const recognized = ports.filter((port) => /m5stack/i.test(port.manufacturer || ""));
      const candidate = preferred ?? (recognized.length === 1 ? recognized[0] : undefined);
      if (candidate) {
        try {
          await this.connect(candidate.path);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      if (attempt < 2) await delay(900 * (attempt + 1));
    }
    if (lastError) this.setError(lastError);
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
    this.lastReceivedSequence = 0;
    this.lastAcknowledgedSequence = 0;
    this.port = new SerialPort({ path: portPath, baudRate: this.config.baudRate, autoOpen: false });
    this.port.on("data", (chunk: Buffer) => this.onData(chunk));
    this.port.on("error", (error) => this.setError(error));
    this.port.on("close", () => {
      this.port = null;
      this.status = { connected: false, path: portPath };
      this.rejectPendingAcks(new Error("StackChan disconnected"));
      this.rejectHardwareRequests(new Error("StackChan disconnected"));
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
    const sendHello = () => this.send("device.hello", { client: "agentling-desktop", protocol: 1 });
    sendHello();
    const helloTimer = setInterval(sendHello, 750);
    helloTimer.unref();
    try {
      await ready;
    } catch (error) {
      await this.disconnect();
      throw error;
    } finally {
      clearInterval(helloTimer);
    }
    // Firmware retains its last ACK sequence across USB reconnects. Start this
    // host session above that watermark so stale ACKs cannot make pack chunks
    // appear confirmed before the device has received them.
    this.sequence = Math.max(this.sequence, this.lastAcknowledgedSequence);
    if (SERIAL_DEBUG) console.log(`[agentling:serial] handshake sequence=${this.sequence} ack=${this.lastAcknowledgedSequence}`);
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
    this.rejectHardwareRequests(new Error("StackChan disconnected"));
  }

  current(): DeviceStatus {
    return structuredClone(this.status);
  }

  async diagnostics(): Promise<DeviceStatus> {
    if (!this.status.connected) throw new Error("StackChan is not connected");
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.requestDiagnostics();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!this.status.connected) throw lastError;
        if (attempt < 2) await delay(120);
      }
    }
    throw lastError ?? new Error("Diagnostics timeout");
  }

  async sensors(): Promise<SensorSnapshot> {
    if (!this.status.connected) throw new Error("StackChan is not connected");
    const requestId = randomUUID();
    return new Promise<SensorSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSensorRequests.delete(requestId);
        reject(new Error("Sensor snapshot timeout"));
      }, 5_000);
      timer.unref();
      this.pendingSensorRequests.set(requestId, { resolve, reject, timer });
      if (!this.send("sensor.request", { requestId })) {
        clearTimeout(timer);
        this.pendingSensorRequests.delete(requestId);
        reject(new Error("StackChan is not connected"));
      }
    });
  }

  async waitForInputEvent(input: {
    types?: string[];
    afterId?: number;
    timeoutMs: number;
  }): Promise<{ event: DeviceInputEvent | null; latestId: number }> {
    const cursor = input.afterId ?? this.inputEvents.latestId();
    const existing = this.inputEvents.findAfter(cursor, input.types);
    if (existing) return { event: existing, latestId: this.inputEvents.latestId() };
    if (input.timeoutMs === 0) return { event: null, latestId: this.inputEvents.latestId() };
    if (!this.status.connected) throw new Error("StackChan is not connected");

    return new Promise((resolve) => {
      const onEvent = (event: DeviceInputEvent) => {
        if (event.id <= cursor || (input.types?.length && !input.types.includes(event.type))) return;
        clearTimeout(timer);
        this.off("input-event", onEvent);
        resolve({ event, latestId: this.inputEvents.latestId() });
      };
      const timer = setTimeout(() => {
        this.off("input-event", onEvent);
        resolve({ event: null, latestId: this.inputEvents.latestId() });
      }, input.timeoutMs);
      timer.unref();
      this.on("input-event", onEvent);
    });
  }

  async captureCamera(): Promise<CameraCaptureResult> {
    if (!this.status.connected) throw new Error("StackChan is not connected");
    if (this.pendingCameraRequests.size > 0) throw new Error("A camera confirmation is already pending");
    const requestId = randomUUID();
    return new Promise<CameraCaptureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCameraRequests.delete(requestId);
        reject(new Error("Camera confirmation or capture timed out"));
      }, 25_000);
      timer.unref();
      this.pendingCameraRequests.set(requestId, { resolve, reject, timer, chunks: [] });
      if (!this.send("camera.request", { requestId })) {
        clearTimeout(timer);
        this.pendingCameraRequests.delete(requestId);
        reject(new Error("StackChan is not connected"));
      }
    });
  }

  setLight(input: {
    color: string;
    brightness: number;
    mode: "solid" | "breathe" | "pulse" | "chase";
    periodMs: number;
    ttlMs: number;
  }): Promise<HardwareCommandResult> {
    return this.requestHardwareCommand("hardware.light", "light", input);
  }

  playSound(input: {
    preset: string;
    volumePercent: number;
    maxDurationMs: number;
  }): Promise<HardwareCommandResult> {
    return this.requestHardwareCommand("hardware.sound", "sound", input);
  }

  moveServo(input: {
    yawDegrees: number;
    pitchDegrees: number;
    speedPercent: number;
    holdMs: number;
  }): Promise<HardwareCommandResult> {
    return this.requestHardwareCommand("hardware.servo", "servo", input);
  }

  recoverServoHome(): Promise<HardwareCommandResult> {
    return Promise.reject(new Error("Automatic servo recovery has been removed; use a normal move to the default pose after bench validation"));
  }

  inspectServo(): Promise<HardwareCommandResult> {
    return this.requestHardwareCommand("hardware.servo.inspect", "servo_inspect", {});
  }

  private requestDiagnostics(): Promise<DeviceStatus> {
    return new Promise((resolve, reject) => {
      const onHello = () => { clearTimeout(timer); resolve(this.current()); };
      const timer = setTimeout(() => { this.off("diagnostics", onHello); reject(new Error("Diagnostics timeout")); }, 5000);
      this.once("diagnostics", onHello);
      this.send("device.hello", { client: "agentling-desktop", protocol: 1 });
    });
  }

  sendAgentSnapshot(snapshot: AgentSnapshot): void {
    if (this.syncingPack) return;
    // The desktop keeps the full activity timeline. The device only needs the
    // latest report already attached to each task, which keeps the 1 Hz
    // heartbeat small and avoids retransmitting history.
    const { reports: _reports, ...deviceSnapshot } = snapshot;
    this.send("agent.snapshot", deviceSnapshot);
  }

  sendWidgetSnapshot(payload: {
    usage: UsageSnapshot;
    clock: ClockSnapshot;
    weather: WeatherSnapshot;
  }): void {
    if (this.syncingPack) return;
    this.send("widget.snapshot", payload);
  }

  sendActionCue(payload: {
    behavior?: string;
    event?: string;
    overlay?: ExpressionOverlay | null;
    payload?: Record<string, unknown>;
  }): void {
    if (this.syncingPack) return;
    this.send("action.cue", payload);
  }

  async syncPack(pack: CompiledPack): Promise<void> {
    if (!this.port?.isOpen) throw new Error("StackChan is not connected");
    if (this.syncingPack) throw new Error("A character pack sync is already running");
    this.syncingPack = true;
    try {
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
      const digest = packContentDigest([...pack.files, runtimeFile]);
      // Firmware before 0.8 has no digest field and keeps using the full sync.
      // The cache probe is read-only; a miss falls through to normal transfer.
      const fresh = await this.diagnostics();
      if (typeof fresh.diagnostics?.packDigest === "string") {
        const matches = (status: DeviceStatus) => status.diagnostics?.packDigest === digest &&
          status.diagnostics?.packId === pack.manifest.id &&
          status.diagnostics?.packVersion === pack.manifest.version &&
          !status.diagnostics?.packError && !status.diagnostics?.renderError;
        if (matches(fresh)) return;
        // A cache miss leaves the active pack untouched. The readback decides
        // whether the switch succeeded, even if its serial ACK was lost.
        try {
          await this.sendReliable("pack.activate", {
            id: pack.manifest.id, version: pack.manifest.version, digest,
          });
        } catch (error) {
          if (SERIAL_DEBUG) console.warn("[agentling:serial] cache activation ACK missing", error);
        }
        await delay(60);
        if (matches(await this.diagnostics())) return;
      }
      await this.sendReliable("pack.manifest", {
        id: pack.manifest.id,
        version: pack.manifest.version,
        digest,
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
      let commitAckError: Error | undefined;
      try {
        await this.sendReliable("pack.commit", { id: pack.manifest.id, version: pack.manifest.version });
      } catch (error) {
        // SHA verification and the SD-card rename can finish after the ACK
        // deadline. The readback below is authoritative even if that ACK was lost.
        commitAckError = error instanceof Error ? error : new Error(String(error));
      }
      // An ACK confirms receipt, not that device-side SHA verification and
      // atomic activation succeeded. Read back the active identity so the UI
      // never reports a false-positive sync completion.
      await delay(120);
      let status: DeviceStatus;
      try {
        status = await this.diagnostics();
      } catch (error) {
        throw commitAckError ?? error;
      }
      const diagnostics = status.diagnostics ?? {};
      const activeId = String(diagnostics.packId ?? "");
      const activeVersion = String(diagnostics.packVersion ?? "");
      const packError = String(diagnostics.packError ?? "");
      if (activeId !== pack.manifest.id || activeVersion !== pack.manifest.version ||
          (typeof diagnostics.packDigest === "string" && diagnostics.packDigest !== digest) ||
          packError || diagnostics.renderError) {
        throw new Error(packError || String(diagnostics.renderError || "") ||
          `StackChan kept ${activeId || "an unknown pack"} after sync${commitAckError ? `: ${commitAckError.message}` : ""}`);
      }
    } finally {
      this.syncingPack = false;
    }
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
    // File chunks are idempotent by path+offset. A fresh sequence retry heals
    // an occasional lost USB frame/ACK during a multi-megabyte transfer.
    // Commit stays single-shot because a lost commit ACK may still mean the
    // atomic rename already succeeded on the device.
    const attempts = type === "pack.commit" ? 1 : 3;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const sequence = this.send(type, payload);
      if (!sequence) throw new Error("StackChan is not connected");
      if (sequence <= this.lastAcknowledgedSequence) return;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingAcks.delete(sequence);
            reject(new Error(`StackChan did not acknowledge ${type} (${sequence})`));
          }, type === "pack.commit" ? 15_000 : 5_000);
          timer.unref();
          this.pendingAcks.set(sequence, { resolve, reject, timer });
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt + 1 < attempts) await delay(80);
      }
    }
    throw lastError ?? new Error(`StackChan did not acknowledge ${type}`);
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
            diagnostics?: Record<string, unknown>;
          };
          const wasConnected = this.status.connected;
          this.status = {
            ...this.status,
            connected: true,
            firmwareVersion: hello.firmwareVersion,
            protocolVersion: hello.protocolVersion,
            capabilities: hello.capabilities,
            diagnostics: hello.diagnostics,
            error: undefined,
          };
          this.emit("status", this.current());
          this.emit("diagnostics");
          if (!wasConnected) this.emit("ready");
        } else if (message.type === "input.event") {
          const payload = message.payload as { type?: unknown; source?: unknown; at?: unknown };
          const event = this.inputEvents.push(payload);
          this.emit("input", payload);
          this.emit("input-event", event);
        } else if (message.type === "sensor.snapshot") {
          const snapshot = {
            ...(message.payload as Omit<SensorSnapshot, "receivedAt">),
            receivedAt: Date.now(),
          };
          const pending = this.pendingSensorRequests.get(snapshot.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingSensorRequests.delete(snapshot.requestId);
            pending.resolve(snapshot);
          }
        } else if (message.type === "camera.chunk") {
          const payload = message.payload as { requestId?: string; offset?: number; data?: Uint8Array };
          const pending = payload.requestId ? this.pendingCameraRequests.get(payload.requestId) : undefined;
          if (pending && Number.isInteger(payload.offset) && payload.offset! >= 0 && payload.data instanceof Uint8Array &&
              payload.data.byteLength <= PACK_CHUNK_BYTES && payload.offset! + payload.data.byteLength <= CAMERA_MAX_BYTES) {
            pending.chunks.push({ offset: payload.offset!, data: payload.data });
          }
        } else if (message.type === "camera.result") {
          void this.completeCameraCapture(message.payload as Record<string, unknown>);
        } else if (message.type === "hardware.result") {
          const result = message.payload as HardwareCommandResult;
          const pending = this.pendingHardwareRequests.get(result.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingHardwareRequests.delete(result.requestId);
            if (result.ok) pending.resolve(result);
            else pending.reject(new Error(result.error || `${result.command || "hardware"} command rejected`));
          }
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

  private rejectHardwareRequests(error: Error): void {
    for (const pending of this.pendingSensorRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingSensorRequests.clear();
    for (const pending of this.pendingCameraRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCameraRequests.clear();
    for (const pending of this.pendingHardwareRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingHardwareRequests.clear();
  }

  private requestHardwareCommand(
    type: "hardware.light" | "hardware.sound" | "hardware.servo" | "hardware.servo.home" | "hardware.servo.inspect",
    command: HardwareCommandResult["command"],
    payload: Record<string, unknown>,
  ): Promise<HardwareCommandResult> {
    if (!this.status.connected) return Promise.reject(new Error("StackChan is not connected"));
    const requestId = randomUUID();
    return new Promise<HardwareCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHardwareRequests.delete(requestId);
        reject(new Error(`${command} command timeout`));
      }, command === "servo" ? 27_000 : 5_000);
      timer.unref();
      this.pendingHardwareRequests.set(requestId, { resolve, reject, timer });
      if (!this.send(type, { requestId, ...payload })) {
        clearTimeout(timer);
        this.pendingHardwareRequests.delete(requestId);
        reject(new Error("StackChan is not connected"));
      }
    });
  }

  private async completeCameraCapture(payload: Record<string, unknown>): Promise<void> {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const pending = this.pendingCameraRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCameraRequests.delete(requestId);
    try {
      if (payload.ok !== true) throw new Error(typeof payload.error === "string" ? payload.error : "Camera capture rejected");
      const totalBytes = typeof payload.totalBytes === "number" ? payload.totalBytes : -1;
      const width = typeof payload.width === "number" ? payload.width : 0;
      const height = typeof payload.height === "number" ? payload.height : 0;
      if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > CAMERA_MAX_BYTES) {
        throw new Error("Camera returned an invalid image size");
      }
      pending.chunks.sort((left, right) => left.offset - right.offset);
      let expectedOffset = 0;
      const buffers: Buffer[] = [];
      for (const chunk of pending.chunks) {
        if (chunk.offset !== expectedOffset) throw new Error(`Camera image has a gap at byte ${expectedOffset}`);
        const buffer = Buffer.from(chunk.data);
        buffers.push(buffer);
        expectedOffset += buffer.length;
      }
      if (expectedOffset !== totalBytes) throw new Error(`Camera image is incomplete (${expectedOffset}/${totalBytes} bytes)`);
      const image = Buffer.concat(buffers);
      if (image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) {
        throw new Error("Camera returned invalid JPEG data");
      }
      const directory = path.join(os.tmpdir(), "agentling-stackchan-camera");
      await fs.mkdir(directory, { recursive: true });
      const target = path.join(directory, `capture-${Date.now()}-${requestId.slice(0, 8)}.jpg`);
      await fs.writeFile(target, image, { mode: 0o600 });
      pending.resolve({
        requestId,
        path: target,
        mimeType: "image/jpeg",
        width,
        height,
        size: image.length,
        sha256: createHash("sha256").update(image).digest("hex"),
        capturedAt: Date.now(),
      });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
