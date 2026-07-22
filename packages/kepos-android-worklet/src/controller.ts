export type WorkletState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface WorkletControllerOptions {
  runtimeId: string;
  echoUrl: string;
  write(frame: Uint8Array): void;
  stopEcho(): Promise<void>;
  configurePublisher?(publisherKey: string): Promise<unknown>;
  status?(): Record<string, unknown>;
}

export class WorkletController {
  private readonly decoder = new FrameDecoder();
  private state: WorkletState = "starting";

  constructor(private readonly options: WorkletControllerOptions) {}

  start(): void {
    if (this.state !== "starting") return;
    this.state = "running";
    this.emitState();
  }

  async receive(chunk: Uint8Array): Promise<void> {
    for (const envelope of this.decoder.push(chunk)) {
      if (envelope.kind !== "request") {
        throw new Error("Worklet accepts only control requests");
      }
      await this.handleRequest(envelope);
    }
  }

  private async handleRequest(request: RequestEnvelope): Promise<void> {
    if (request.method === "ping") {
      this.respond(request, { pong: true, runtimeId: this.options.runtimeId });
      return;
    }
    if (request.method === "status") {
      this.respond(request, {
        state: this.state,
        runtimeId: this.options.runtimeId,
        echoUrl: this.options.echoUrl,
        ...this.options.status?.(),
      });
      return;
    }
    if (request.method === "configure") {
      await this.configure(request);
      return;
    }
    await this.stop(request);
  }

  private async configure(request: RequestEnvelope): Promise<void> {
    try {
      const params = request.params;
      if (
        typeof params !== "object" ||
        params === null ||
        Array.isArray(params) ||
        typeof (params as Record<string, unknown>).publisherKey !== "string"
      ) {
        throw new Error("publisherKey is required");
      }
      const publisherKey = (params as { publisherKey: string }).publisherKey;
      if (!/^[0-9a-f]{64}$/.test(publisherKey)) {
        throw new Error("publisherKey must be 32 bytes of lowercase hex");
      }
      if (!this.options.configurePublisher) {
        throw new Error("publisher configuration is unavailable");
      }
      this.respond(
        request,
        await this.options.configurePublisher(publisherKey),
      );
    } catch (error) {
      this.write({
        version: 1,
        kind: "error",
        id: request.id,
        error: {
          code: "invalid_configuration",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async stop(request: RequestEnvelope): Promise<void> {
    this.state = "stopping";
    this.emitState();
    await this.options.stopEcho();
    this.state = "stopped";
    this.emitState();
    this.respond(request, { stopped: true, runtimeId: this.options.runtimeId });
  }

  private emitState(): void {
    this.write({
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: {
        state: this.state,
        runtimeId: this.options.runtimeId,
        ...(this.state === "running"
          ? { echoUrl: this.options.echoUrl, ...this.options.status?.() }
          : {}),
      },
    });
  }

  private respond(request: RequestEnvelope, result: unknown): void {
    this.write({
      version: 1,
      kind: "response",
      id: request.id,
      result,
    });
  }

  private write(envelope: HostEnvelope): void {
    this.options.write(encodeFrame(envelope));
  }
}
import {
  encodeFrame,
  FrameDecoder,
} from "@tta-lab/bare-host-protocol/framing";
import type {
  HostEnvelope,
  RequestEnvelope,
} from "@tta-lab/bare-host-protocol/messages";
