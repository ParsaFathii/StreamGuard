"use client";

// StreamGuard Console — live transport.
// Two modes (contract: identical channels + payload shapes):
//  - socket.io (default, demo edition): io("/?XTransformPort=3003") — never an
//    absolute URL/port; the sandbox gateway routes via the query param.
//  - SSE (Go reference edition): NEXT_PUBLIC_LIVE_TRANSPORT=sse — EventSource
//    on `${NEXT_PUBLIC_API_BASE}/api/stream`, SSE event names = channel names.
import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useUiStore } from "@/lib/store";
import type { LiveChannels, LiveEventPayload } from "@/lib/types";

export type EventNewPayload = { events?: LiveEventPayload[] } | LiveEventPayload;

const TRANSPORT = (process.env.NEXT_PUBLIC_LIVE_TRANSPORT ?? "socketio").toLowerCase();
const SSE_MODE = TRANSPORT === "sse";
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

function isLiveEvent(v: unknown): v is LiveEventPayload {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<LiveEventPayload>;
  return typeof e.id === "string" && typeof e.severity === "string";
}

/** Normalize an event:new payload (batch {events:[...]} or single event) into a flat list. */
export function normalizeEventNewPayload(payload: unknown): LiveEventPayload[] {
  const p = payload as EventNewPayload;
  const items = Array.isArray(p)
    ? p
    : p && Array.isArray((p as { events?: unknown[] }).events)
      ? ((p as { events: unknown[] }).events)
      : [p];
  const out: LiveEventPayload[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!isLiveEvent(it) || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------- socket.io

let socket: Socket | null = null;

/** Get (or lazily create) the shared socket.io connection (client-side only). */
export function getSocket(): Socket {
  if (socket) return socket;
  socket = io("/?XTransformPort=3003", {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 8000,
  });

  const store = () => useUiStore.getState();
  socket.on("connect", () => store().setWsStatus("live"));
  socket.on("disconnect", () => store().setWsStatus("reconnecting"));
  socket.on("connect_error", () => {
    const s = store();
    if (s.wsStatus !== "disconnected") s.setWsStatus("reconnecting");
  });
  socket.on("reconnect_failed", () => store().setWsStatus("disconnected"));

  return socket;
}

// ---------------------------------------------------------------------- SSE

type SseHandler = (payload: unknown) => void;
const sseHandlers = new Map<string, Set<SseHandler>>();
let sseSource: EventSource | null = null;

function ensureSse(): void {
  if (sseSource || typeof window === "undefined") return;
  const store = () => useUiStore.getState();
  // EventSource auto-reconnects; surface connection state honestly.
  const url = `${API_BASE}/api/stream`;
  try {
    const es = new EventSource(url, { withCredentials: true });
    sseSource = es;
    es.onopen = () => store().setWsStatus("live");
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        store().setWsStatus("disconnected");
      } else {
        store().setWsStatus("reconnecting");
      }
    };
    const channels: LiveChannels[] = [
      "event:new",
      "detection:new",
      "incident:new",
      "incident:update",
      "stats",
      "simulator",
    ];
    for (const ch of channels) {
      es.addEventListener(ch, (ev) => {
        let payload: unknown = null;
        try {
          payload = JSON.parse((ev as MessageEvent).data);
        } catch {
          return;
        }
        const set = sseHandlers.get(ch);
        if (set) for (const h of set) h(payload);
      });
    }
  } catch {
    store().setWsStatus("disconnected");
  }
}

function sseSubscribe(channel: string, handler: SseHandler): () => void {
  ensureSse();
  let set = sseHandlers.get(channel);
  if (!set) {
    set = new Set();
    sseHandlers.set(channel, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

// ------------------------------------------------------------------ public

/** Connect the live transport (idempotent) — call from the app shell once. */
export function connectLive(): () => void {
  if (SSE_MODE) {
    useUiStore.getState().setWsStatus("connecting");
    ensureSse();
  } else {
    const s = getSocket();
    if (!s.connected) {
      useUiStore.getState().setWsStatus("connecting");
      s.connect();
    }
  }
  return () => {
    /* the transport stays alive for the whole console session (single-page app) */
  };
}

/**
 * Subscribe to a live channel with automatic cleanup.
 * The callback receives the payload as the backend emitted it.
 */
export function useLiveChannel<C extends LiveChannels>(
  channel: C,
  cb: (payload: C extends "event:new" ? EventNewPayload : C extends "stats" ? Record<string, number> : unknown) => void,
): void {
  const cbRef = useRef(cb);
  useEffect(() => {
    // keep the latest callback without re-subscribing the channel
    cbRef.current = cb;
  });

  useEffect(() => {
    const handler = (payload: unknown) => cbRef.current(payload as never);
    if (SSE_MODE) {
      return sseSubscribe(channel, handler);
    }
    const s = getSocket();
    // socket.io's reserved-event typing conflicts with dynamic channel names;
    // our channels are always data channels with a single payload argument.
    const ch = channel as string;
    const listener = handler as (...args: unknown[]) => void;
    s.on(ch, listener);
    return () => {
      s.off(ch, listener);
    };
  }, [channel]);
}
