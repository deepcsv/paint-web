const RING_BUFFER_SIZE = 1000;
/**
 * EventBus — maintains a monotonic seq counter, a ring buffer of the last
 * N events (for replay on reconnect), and a list of subscribers.
 */
export class EventBus {
    seq = 0;
    ring = [];
    subscribers = new Map();
    wsServer;
    constructor(wsServer) {
        this.wsServer = wsServer;
    }
    currentSeq() {
        return this.seq;
    }
    /** Emit an event to all subscribers, advancing seq. */
    emit(type, data, excludeClientId) {
        this.seq += 1;
        const event = { seq: this.seq, type, data };
        this.ring.push(event);
        if (this.ring.length > RING_BUFFER_SIZE) {
            this.ring.shift();
        }
        this.broadcast(event, excludeClientId);
        return this.seq;
    }
    /** Replay events after the given seq to a specific client. */
    replay(afterSeq, targetClientId) {
        const target = this.subscribers.get(targetClientId);
        if (!target)
            return;
        const matching = this.ring.filter((e) => e.seq > afterSeq && this.matches(target, e.type));
        for (const e of matching) {
            this.sendTo(targetClientId, {
                jsonrpc: "2.0",
                method: `event.${e.type}`,
                params: { seq: e.seq, type: e.type, data: e.data },
            });
        }
    }
    subscribe(clientId, types) {
        this.subscribers.set(clientId, {
            clientId,
            types: types ? new Set(types) : null,
        });
    }
    unsubscribeAll(clientId) {
        this.subscribers.delete(clientId);
    }
    /** Remove subscriber on disconnect. */
    drop(clientId) {
        this.subscribers.delete(clientId);
    }
    matches(sub, type) {
        return sub.types === null || sub.types.has(type);
    }
    broadcast(event, excludeClientId) {
        for (const sub of this.subscribers.values()) {
            if (sub.clientId === excludeClientId)
                continue;
            if (!this.matches(sub, event.type))
                continue;
            this.sendTo(sub.clientId, {
                jsonrpc: "2.0",
                method: `event.${event.type}`,
                params: { seq: event.seq, type: event.type, data: event.data },
            });
        }
    }
    sendTo(clientId, msg) {
        for (const client of this.wsServer.clients) {
            const conn = client;
            if (conn.__paintClientId === clientId) {
                try {
                    client.send(JSON.stringify(msg));
                }
                catch {
                    // socket may have closed; ignore
                }
            }
        }
    }
}
