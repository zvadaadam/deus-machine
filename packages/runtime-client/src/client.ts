import { match } from "ts-pattern";
import { subscriptionKey } from "./identity";
import { RuntimeError } from "./types";
import type {
  RuntimeIdentity,
  RuntimeSocket,
  RuntimeState,
  RuntimePorts,
  QueryRequestInterceptor,
  ToolResponseInterceptor,
  SnapshotCallback,
  DeltaCallback,
  StreamCallback,
  ListenOptions,
  MutateResult,
} from "./types";

type Observer = { snapshot: SnapshotCallback; delta?: DeltaCallback };
type Subscription = {
  id: string;
  key: string;
  resource: string;
  params?: Record<string, unknown>;
  observers: Set<Observer>;
  fresh: boolean;
  /** Where a read that answers with rows since a cursor stands: where a return resumes. */
  cursor?: number;
};
type Follower = { onEvent: StreamCallback; options?: ListenOptions };
/** One wire subscription to a stream, shared by everyone here who follows it with that filter. */
type Listener = {
  id: string;
  key: string;
  stream: string;
  filter?: Record<string, unknown>;
  followers: Set<Follower>;
  /** The host has been asked for this stream before: the next ask is a return. */
  joined: boolean;
  /** Number of the last event received, on a stream that numbers them: where a return resumes. */
  last?: number;
};
type Pending = {
  /** A mutation changes something: a lost reply leaves its outcome unknown. */
  kind: "request" | "mutation";
  sent: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
/**
 * One owner for an authenticated runtime's transport, operations and subscriptions.
 * A transport can be a direct socket or a logical relay stream. Neither changes
 * q: or the agent event contract. Reconnect restores reads; writes are never replayed.
 */
export class RuntimeClient<Resource extends string = string> {
  readonly identity: Readonly<RuntimeIdentity>;
  private state: RuntimeState = "offline";
  private socket: RuntimeSocket | null = null;
  private generation = 0;
  private sequence = 0;
  private retryAttempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatId?: string;
  private connection?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private subscriptions = new Map<string, Subscription>();
  private byId = new Map<string, Subscription>();
  private listeners = new Map<string, Listener>();
  private listenersByKey = new Map<string, Listener>();
  private pending = new Map<string, Pending>();
  private states = new Set<(state: RuntimeState) => void>();
  private disposals = new Set<() => void>();
  private requestInterceptor: QueryRequestInterceptor | null;
  private toolResponseInterceptor: ToolResponseInterceptor | null;

  constructor(
    identity: RuntimeIdentity,
    private readonly ports: RuntimePorts
  ) {
    this.identity = Object.freeze({ ...identity });
    this.requestInterceptor = ports.request ?? null;
    this.toolResponseInterceptor = ports.toolResponse ?? null;
  }

  getState = (): RuntimeState => this.state;
  isConnected = (): boolean => this.state === "online";

  connect = (): Promise<void> => {
    if (this.ended()) return Promise.reject(this.disposedError());
    if (this.isConnected()) return Promise.resolve();
    if (this.connection) return this.connection.promise;
    if (this.requestInterceptor) {
      this.transition("online");
      return Promise.resolve();
    }
    if (this.socket && this.state === "offline") {
      return Promise.reject(new RuntimeError("unavailable", "Host unavailable through relay"));
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.connection = { promise, resolve, reject };
    // The relay may keep a healthy socket while its host is temporarily absent.
    if (!this.socket && this.state !== "connecting") void this.open();
    return promise;
  };

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.transition("connecting");
    this.handshakeTimer = setTimeout(() => {
      if (generation === this.generation && !this.isConnected()) {
        this.interrupted("Runtime connection timed out");
      }
    }, this.ports.timeoutMs ?? 10_000);
    try {
      const socket = await this.ports.open();
      if (generation !== this.generation || this.ended()) {
        socket.close();
        return;
      }
      this.socket = socket;
      const current = () =>
        generation === this.generation && this.socket === socket && !this.ended();
      socket.addEventListener("open", () => {
        if (!current() || !this.ports.authenticate) return;
        try {
          socket.send(JSON.stringify(this.ports.authenticate()));
        } catch {
          this.revoke();
        }
      });
      socket.addEventListener("message", (event) => {
        if (!current()) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (frame && typeof frame === "object" && !Array.isArray(frame)) {
          this.receive(frame as Record<string, unknown>);
        }
      });
      socket.addEventListener("error", () => {});
      socket.addEventListener("close", ({ code }) => {
        if (!current()) return;
        if (code === 4001 || code === 4003) this.revoke();
        else this.interrupted("Runtime connection interrupted");
      });
    } catch (error) {
      if (generation !== this.generation || this.ended()) return;
      // The factory can refuse definitively (its credential cannot reach this host).
      if (error instanceof RuntimeError && error.kind === "rejected") this.end("revoked");
      else this.interrupted("Runtime connection failed");
    }
  }

  private receive(frame: Record<string, unknown>): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    match(frame.type)
      .with("connected", "authenticated", () => {
        if (this.isConnected()) return;
        clearTimeout(this.handshakeTimer);
        this.retryAttempt = 0;
        this.state = "online";
        this.scheduleHeartbeat();
        for (const sub of this.subscriptions.values()) this.sendSubscription(sub);
        // A reset may stop a listener later in this pass: it is not asked for again.
        for (const listener of [...this.listeners.values()]) {
          if (this.listeners.has(listener.id)) this.sendListen(listener);
        }
        this.connection?.resolve();
        this.connection = undefined;
        this.notifyState();
      })
      .with("server_reconnecting", () => {
        clearTimeout(this.handshakeTimer);
        this.lost("Host unavailable through relay");
        this.connection?.reject(new RuntimeError("unavailable", "Host unavailable through relay"));
        this.connection = undefined;
        this.scheduleHeartbeat();
      })
      .with("auth_failed", () => this.revoke())
      .with("ping", () => this.write({ type: "pong", ...(id ? { id } : {}) }, true))
      .with("pong", () => {
        if (this.heartbeatId && id === this.heartbeatId) this.scheduleHeartbeat();
      })
      .with("q:snapshot", () => {
        const sub = this.byId.get(id);
        if (!sub || !this.isConnected()) return;
        // A null resource can be authoritative. Ack-only snapshots are an app policy.
        sub.fresh = true;
        if (typeof frame.cursor === "number") sub.cursor = frame.cursor;
        for (const observer of sub.observers) this.notify(() => observer.snapshot(frame.data));
      })
      .with("q:delta", () => {
        const sub = this.byId.get(id);
        if (!sub || !this.isConnected()) return;
        if (typeof frame.cursor === "number") sub.cursor = frame.cursor;
        for (const observer of sub.observers)
          this.notify(() =>
            observer.delta?.(
              frame.upserted as unknown[] | undefined,
              frame.removed as string[] | undefined,
              frame.cursor as number | undefined
            )
          );
      })
      .with("q:event", () => {
        if (!this.isConnected()) return;
        const listener = this.listeners.get(id);
        if (!listener) return;
        if (typeof frame.seq === "number") listener.last = frame.seq;
        for (const follower of [...listener.followers])
          this.notify(() => follower.onEvent(frame.data));
      })
      .with("q:subscribed", () => {
        const listener = this.listeners.get(id);
        if (!listener || !this.isConnected()) return;
        // Where the stream stands: a place to return to even if nothing arrives.
        if (typeof frame.seq === "number") listener.last = frame.seq;
      })
      .with("q:reset", () => {
        const listener = this.listeners.get(id);
        if (!listener || !this.isConnected()) return;
        // Where the stream stands now: what follows is delivered from there.
        listener.last = typeof frame.seq === "number" ? frame.seq : undefined;
        this.resetFollowers(listener);
      })
      .with("q:response", () => this.resolve(id, "request", frame.data))
      .with("q:mutate_result", () => {
        const { type: _type, id: _id, ...result } = frame;
        this.resolve(id, "mutation", result);
      })
      .with("q:error", () => {
        const message = typeof frame.message === "string" ? frame.message : "Query failed";
        const pending = this.takePending(id);
        if (pending) pending.reject(new RuntimeError("rejected", message));
        else if (this.listeners.has(id)) {
          // Refused for good (no such stream, or not allowed): redialing will not change it.
          const listener = this.listeners.get(id)!;
          this.listeners.delete(id);
          this.listenersByKey.delete(listener.key);
          for (const follower of listener.followers)
            this.notify(() => follower.options?.onRefused?.(new RuntimeError("rejected", message)));
        } else {
          const sub = this.byId.get(id);
          if (sub) sub.fresh = false;
          console.warn("[RuntimeClient] Subscription error:", message);
        }
      })
      .otherwise(() => {});
  }

  subscribe = (
    resource: Resource,
    params: Record<string, unknown> | undefined,
    snapshot: SnapshotCallback,
    delta?: DeltaCallback
  ): (() => void) => {
    if (this.ended() || this.requestInterceptor) return () => {};
    const key = subscriptionKey([resource, params ?? {}]);
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = {
        id: `sub_${++this.sequence}`,
        key,
        resource,
        params: params ? structuredClone(params) : undefined,
        observers: new Set(),
        fresh: false,
      };
      this.subscriptions.set(key, sub);
      this.byId.set(sub.id, sub);
    }
    // A new projection cannot replay the original snapshot after intervening
    // deltas (their merge belongs to each cache binding). Refresh the existing
    // wire subscription once; equal cache bindings never reach this path.
    const needsSnapshot = sub.observers.size > 0 && sub.fresh;
    const observer = { snapshot, delta };
    sub.observers.add(observer);
    if ((sub.observers.size === 1 || needsSnapshot) && this.isConnected())
      this.sendSubscription(sub);
    const entry = sub;
    return () => {
      if (!entry.observers.delete(observer) || entry.observers.size) return;
      this.subscriptions.delete(key);
      this.byId.delete(entry.id);
      this.write({ type: "q:unsubscribe", id: entry.id });
    };
  };

  /**
   * Listen to a stream of events, narrowed by `filter`. Nothing arrives that
   * was not asked for, and each event arrives once, in order. Listeners of the
   * same stream and filter share one subscription on the wire.
   *
   * The subscription is restored on every reconnect. Where the stream numbers
   * its events, the host says where it stands when the subscription is made,
   * is told the last number received on a return, and sends what followed it.
   * Where it cannot (the stream is not numbered, or the host no longer holds
   * that far back), `onReset` runs: something may have been missed, so read
   * the state again.
   *
   * A runtime that answers requests itself (no host socket) still keeps its
   * listeners: they receive what `publishLocal` delivers.
   */
  listen = (
    stream: string,
    filter: Record<string, unknown> | undefined,
    onEvent: StreamCallback,
    options?: ListenOptions
  ): (() => void) => {
    if (this.ended()) return () => {};
    const key = subscriptionKey([stream, filter ?? {}]);
    let listener = this.listenersByKey.get(key);
    if (!listener) {
      listener = {
        id: `evt_${++this.sequence}`,
        key,
        stream,
        filter: filter ? structuredClone(filter) : undefined,
        followers: new Set(),
        joined: false,
      };
      this.listeners.set(listener.id, listener);
      this.listenersByKey.set(key, listener);
      if (this.isConnected()) this.sendListen(listener);
    }
    const follower: Follower = { onEvent, options };
    listener.followers.add(follower);
    const shared = listener;
    return () => {
      if (!shared.followers.delete(follower) || shared.followers.size > 0) return;
      if (this.listeners.get(shared.id) !== shared) return;
      this.listeners.delete(shared.id);
      this.listenersByKey.delete(key);
      this.write({ type: "q:unsubscribe", id: shared.id });
    };
  };

  /**
   * Deliver an event to this client's own listeners, as if the host had
   * published it under `scope`. For a source that lives in the client (a
   * channel the browser holds itself) and feeds the same listeners.
   */
  publishLocal = (stream: string, scope: Record<string, unknown>, data: unknown): void => {
    if (this.ended()) return;
    for (const listener of this.listeners.values()) {
      if (listener.stream !== stream) continue;
      const filter = listener.filter ?? {};
      if (
        Object.keys(filter).every((key) => filter[key] === undefined || filter[key] === scope[key])
      ) {
        for (const follower of [...listener.followers]) this.notify(() => follower.onEvent(data));
      }
    }
  };

  sendRequest = <T = unknown>(
    resource: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<T> => {
    if (this.ended()) return Promise.reject(this.disposedError());
    let intercepted: Promise<unknown> | null = null;
    try {
      intercepted = this.requestInterceptor?.(resource, params) ?? null;
    } catch (error) {
      return Promise.reject(error);
    }
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const send = (remainingMs: number) =>
      this.exchange(
        "request",
        resource,
        { type: "q:request", resource, ...(params ? { params } : {}) },
        remainingMs,
        intercepted
      ) as Promise<T>;
    // Asked while the connection is being made (startup, a reconnect attempt):
    // wait for it within the request's deadline instead of failing into the
    // caller's retry backoff. The request was never sent, so this sends it once.
    if (!intercepted && this.state === "connecting") {
      const deadline = Date.now() + timeoutMs;
      return this.within(this.connect(), timeoutMs, `${resource} timed out`).then(() =>
        send(Math.max(deadline - Date.now(), 0))
      );
    }
    return send(timeoutMs);
  };

  /** `promise`, or an unavailable error once `timeoutMs` passes. */
  private within(promise: Promise<void>, timeoutMs: number, message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeError("unavailable", message)), timeoutMs);
      promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: Error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  sendMutate = <T = unknown>(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<MutateResult<T>> =>
    this.exchange("mutation", action, { type: "q:mutate", action, params }, timeoutMs) as Promise<
      MutateResult<T>
    >;

  private exchange(
    kind: Pending["kind"],
    name: string,
    frame: Record<string, unknown>,
    timeoutMs = 30_000,
    intercepted: Promise<unknown> | null = null
  ): Promise<unknown> {
    if (this.ended()) return Promise.reject(this.disposedError());
    if (!intercepted && (this.requestInterceptor || !this.isConnected())) {
      return Promise.reject(
        new RuntimeError(
          "unavailable",
          this.requestInterceptor
            ? `${name} is not available in this runtime`
            : "Runtime is not connected"
        )
      );
    }
    const id = `${kind}_${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePending(id);
        pending?.reject(this.pendingError(pending, `${name} timed out`));
      }, timeoutMs);
      const pending: Pending = { kind, sent: false, resolve, reject, timer };
      this.pending.set(id, pending);
      if (intercepted) {
        void intercepted.then(
          (value) => this.resolve(id, kind, value),
          (error) => this.takePending(id)?.reject(error)
        );
      } else if (this.write({ ...frame, id })) pending.sent = true;
      else this.takePending(id)?.reject(new RuntimeError("unavailable", "Request was not sent"));
    });
  }

  private resolve(id: string, kind: Pending["kind"], data: unknown): void {
    if (this.pending.get(id)?.kind !== kind) return;
    this.takePending(id)?.resolve(data);
  }

  private takePending(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
    }
    return pending;
  }

  private pendingError(pending: Pending, message: string): RuntimeError {
    return pending.kind === "mutation" && pending.sent
      ? new RuntimeError(
          "unknown-outcome",
          `${message}. The operation may have completed; check its result before retrying.`
        )
      : new RuntimeError("unavailable", message);
  }

  onStateChange = (callback: (state: RuntimeState) => void): (() => void) => {
    this.states.add(callback);
    return () => {
      this.states.delete(callback);
    };
  };
  onConnectionChange = (callback: (connected: boolean) => void): (() => void) => {
    let previous = this.isConnected();
    return this.onStateChange(() => {
      const connected = this.isConnected();
      if (connected !== previous) {
        previous = connected;
        callback(connected);
      }
    });
  };
  onDispose = (callback: () => void): (() => void) => {
    this.disposals.add(callback);
    return () => {
      this.disposals.delete(callback);
    };
  };

  setQueryRequestInterceptor = (interceptor: QueryRequestInterceptor | null): void => {
    this.requestInterceptor = interceptor;
  };
  setToolResponseInterceptor = (interceptor: ToolResponseInterceptor | null): void => {
    this.toolResponseInterceptor = interceptor;
  };
  sendToolResponse = (requestId: string, result?: unknown, error?: string): boolean => {
    if (this.ended()) return false;
    if (this.toolResponseInterceptor?.(requestId, result, error)) return true;
    return this.write({
      type: "q:tool_response",
      requestId,
      ...(error !== undefined ? { error } : { result }),
    });
  };

  forceReconnect = (): void => {
    if (this.ended() || this.requestInterceptor) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    this.closeSocket();
    this.lost("Runtime connection replaced");
    void this.open();
  };

  private interrupted(reason: string): void {
    this.closeSocket();
    this.lost(reason);
    this.connection?.reject(new RuntimeError("unavailable", reason));
    this.connection = undefined;
    this.scheduleReconnect();
  }
  private lost(reason: string): void {
    for (const sub of this.subscriptions.values()) sub.fresh = false;
    for (const id of this.pending.keys()) {
      const pending = this.takePending(id)!;
      pending.reject(this.pendingError(pending, reason));
    }
    this.transition(this.ended() ? this.state : "offline");
  }
  private scheduleReconnect(): void {
    if (this.retryTimer || this.ended()) return;
    const delay = Math.min((this.ports.retryMs ?? 500) * 2 ** this.retryAttempt++, 8000);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.open();
      },
      delay * (0.8 + (this.ports.random ?? Math.random)() * 0.4)
    );
  }
  private sendSubscription(sub: Subscription): void {
    sub.fresh = false;
    this.write({
      type: "q:subscribe",
      id: sub.id,
      resource: sub.resource,
      ...(sub.params ? { params: sub.params } : {}),
      ...(sub.cursor !== undefined ? { after: sub.cursor } : {}),
    });
  }
  private sendListen(listener: Listener): void {
    if (this.requestInterceptor) return;
    const returning = listener.joined;
    listener.joined = true;
    this.write({
      type: "q:subscribe",
      id: listener.id,
      resource: listener.stream,
      ...(listener.filter ? { params: listener.filter } : {}),
      ...(listener.last !== undefined ? { after: listener.last } : {}),
    });
    // Back with no place to resume from: what happened meanwhile is unknown.
    if (returning && listener.last === undefined) this.resetFollowers(listener);
  }
  private resetFollowers(listener: Listener): void {
    for (const follower of [...listener.followers])
      this.notify(() => follower.options?.onReset?.());
  }
  private write(frame: Record<string, unknown>, control = false): boolean {
    if ((!control && !this.isConnected()) || this.socket?.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
  private closeSocket(): void {
    ++this.generation;
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.heartbeatTimer);
    this.heartbeatId = undefined;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* Already closed. */
    }
  }
  private scheduleHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatId = undefined;
    const interval = this.ports.heartbeatIntervalMs ?? 30_000;
    if (interval <= 0 || !this.socket || this.ended()) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatId = `ping_${++this.sequence}`;
      this.heartbeatTimer = setTimeout(
        () => this.interrupted("Runtime heartbeat timed out"),
        this.ports.heartbeatTimeoutMs ?? 10_000
      );
      if (!this.write({ type: "ping", id: this.heartbeatId }, true)) {
        this.interrupted("Runtime heartbeat could not be sent");
      }
    }, interval);
  }
  private transition(state: RuntimeState): void {
    this.state = state;
    this.notifyState();
  }
  private notifyState(): void {
    for (const callback of this.states) this.notify(() => callback(this.state));
  }
  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error("[RuntimeClient] Listener failed:", error);
    }
  }
  protected ended(): boolean {
    return this.state === "disposed" || this.state === "revoked";
  }
  private disposedError(): RuntimeError {
    return new RuntimeError("disposed", `Runtime access is ${this.state}`);
  }

  private revoke(): void {
    this.end("revoked");
    this.ports.onAuthFailure?.();
  }
  private end(state: "disposed" | "revoked"): void {
    if (this.ended()) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.closeSocket();
    this.state = state;
    this.lost(`Runtime access is ${state}`);
    this.connection?.reject(this.disposedError());
    this.connection = undefined;
    for (const callback of this.disposals) this.notify(callback);
    this.disposals.clear();
    this.subscriptions.clear();
    this.byId.clear();
    this.listeners.clear();
    this.listenersByKey.clear();
    this.notifyState();
    this.states.clear();
    this.requestInterceptor = null;
    this.toolResponseInterceptor = null;
  }
  dispose = (): void => this.end("disposed");

  diagnostics() {
    return {
      state: this.state,
      subscriptions: this.subscriptions.size,
      observers: [...this.subscriptions.values()].reduce(
        (count, sub) => count + sub.observers.size,
        0
      ),
      pending: this.pending.size,
      generation: this.generation,
    };
  }
}
