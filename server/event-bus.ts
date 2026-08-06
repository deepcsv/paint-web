import type { Server } from "ws";
import type { JsonRpcResponse, EventType } from "../shared/protocol.js";

interface Subscription {
  clientId: string;
  types: Set<string> | null; // null = all events
}

interface QueuedEvent {
  seq: number;
  type: EventType;
  data: unknown;
}

const RING_BUFFER_SIZE = 1000;

/**
 * EventBus — maintains a monotonic seq counter, a ring buffer of the last
 * N events (for replay on reconnect), and a list of subscribers.
 */
export class EventBus {
  private seq = 0;
  private ring: QueuedEvent[] = [];
  private subscribers: Map<string, Subscription> = new Map();
  private wsServer: Server;

  constructor(wsServer: Server) {
    this.wsServer = wsServer;
  }

  currentSeq(): number {
    return this.seq;
  }

  /** Emit an event to all subscribers, advancing seq. */
  emit(type: EventType, data: unknown, excludeClientId?: string): number {
    this.seq += 1;
    const event: QueuedEvent = { seq: this.seq, type, data };
    this.ring.push(event);
    if (this.ring.length > RING_BUFFER_SIZE) {
      this.ring.shift();
    }
    this.broadcast(event, excludeClientId);
    return this.seq;
  }

  /** Replay events after the given seq to a specific client. */
  replay(afterSeq: number, targetClientId: string): void {
    const target = this.subscribers.get(targetClientId);
    if (!target) return;
    const matching = this.ring.filter((e) => e.seq > afterSeq && this.matches(target, e.type));
    for (const e of matching) {
      this.sendTo(targetClientId, {
        jsonrpc: "2.0",
        method: `event.${e.type}`,
        params: { seq: e.seq, type: e.type, data: e.data },
      });
    }
  }

  subscribe(clientId: string, types: string[] | undefined): void {
    this.subscribers.set(clientId, {
      clientId,
      types: types ? new Set(types) : null,
    });
  }

  unsubscribeAll(clientId: string): void {
    this.subscribers.delete(clientId);
  }

  /** Remove subscriber on disconnect. */
  drop(clientId: string): void {
    this.subscribers.delete(clientId);
  }

  private matches(sub: Subscription, type: string): boolean {
    return sub.types === null || sub.types.has(type);
  }

  private broadcast(event: QueuedEvent, excludeClientId?: string): void {
    for (const sub of this.subscribers.values()) {
      if (sub.clientId === excludeClientId) continue;
      if (!this.matches(sub, event.type)) continue;
      this.sendTo(sub.clientId, {
        jsonrpc: "2.0",
        method: `event.${event.type}`,
        params: { seq: event.seq, type: event.type, data: event.data },
      });
    }
  }

  private sendTo(clientId: string, msg: JsonRpcResponse | object): void {
    for (const client of this.wsServer.clients) {
      const conn = client as unknown as { __paintClientId?: string };
      if (conn.__paintClientId === clientId) {
        try {
          client.send(JSON.stringify(msg));
        } catch {
          // socket may have closed; ignore
        }
      }
    }
  }
}
