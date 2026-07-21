import {
  PROTOCOL_VERSION,
  type ErrorEnvelope,
  type HostMethod,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "./messages.js";

export class RequestTracker {
  private nextId = 1;
  private readonly pending = new Set<number>();

  request(method: HostMethod): RequestEnvelope {
    if (!Number.isSafeInteger(this.nextId)) {
      throw new Error("control request id space is exhausted");
    }
    const id = this.nextId++;
    this.pending.add(id);
    return { version: PROTOCOL_VERSION, kind: "request", id, method };
  }

  accept(
    envelope: ResponseEnvelope | ErrorEnvelope,
  ): ResponseEnvelope | ErrorEnvelope {
    if (!this.pending.delete(envelope.id)) {
      throw new Error(`unknown response id: ${envelope.id}`);
    }
    return envelope;
  }
}
