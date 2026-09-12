import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentlingRuntime } from "../runtime";
import type { HostConfig } from "../config";
import { expressionRequestSchema, progressRequestSchema } from "../../core/schemas";

export class LocalApiServer {
  private server: Server | null = null;

  constructor(
    private readonly config: HostConfig["server"],
    private readonly runtime: AgentlingRuntime,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => void this.route(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(request)) return this.json(response, 401, { error: "unauthorized" });
      const url = new URL(request.url || "/", `http://${this.config.host}:${this.config.port}`);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return this.json(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return this.json(response, 200, this.runtime.snapshot());
      }
      if (request.method !== "POST") return this.json(response, 404, { error: "not found" });
      const body = await readJson(request);
      if (url.pathname === "/v1/hook") {
        const event = this.runtime.handleHook(body);
        return this.json(response, 202, { accepted: Boolean(event), event });
      }
      if (url.pathname === "/v1/expression") {
        const value = expressionRequestSchema.parse(body);
        this.runtime.showExpression(value);
        return this.json(response, 200, { ok: true, expiresInMs: value.ttlMs });
      }
      if (url.pathname === "/v1/progress") {
        const value = progressRequestSchema.parse(body);
        this.runtime.showProgress(value);
        return this.json(response, 200, { ok: true, expiresInMs: value.ttlMs });
      }
      if (url.pathname === "/v1/clear") {
        this.runtime.clearExpression();
        return this.json(response, 200, { ok: true });
      }
      return this.json(response, 404, { error: "not found" });
    } catch (error) {
      return this.json(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.config.token) return true;
    return request.headers.authorization === `Bearer ${this.config.token}`;
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
