"use client";

// StreamGuard Console — UI store (zustand).
// Theme is handled separately via next-themes; everything else UI lives here.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Lang } from "@/lib/i18n";

export const SECTION_IDS = [
  "overview",
  "events",
  "live",
  "rules",
  "detections",
  "incidents",
  "investigate",
  "correlation",
  "ml",
  "ai",
  "sources",
  "health",
  "audit",
  "settings",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export type WsStatus = "connecting" | "live" | "reconnecting" | "disconnected";

/** Counters pushed by the WS `stats` channel (defensive — partial payloads allowed). */
export interface LiveStats {
  events24h?: number;
  detections24h?: number;
  incidentsOpen?: number;
  rejected24h?: number;
  ingestPerMin?: number;
  queueDepth?: number;
  ts: string;
}

interface UiState {
  activeSection: SectionId;
  lang: Lang;
  wsStatus: WsStatus;
  lastWsEventAt: string | null;
  lastLatencyMs: number | null;
  apiVersion: string | null;
  liveStats: LiveStats | null;
  /** incident preselected for the Investigation section */
  investigateIncidentId: string | null;
  /** focus flag consumed by Event Explorer when "/" is pressed */
  focusEventsSearch: boolean;
  /** set by the API client when any request returns 401 (expired session) */
  sessionExpired: boolean;
  setSection: (s: SectionId) => void;
  setLang: (l: Lang) => void;
  setWsStatus: (s: WsStatus) => void;
  setLastWsEventAt: (iso: string | null) => void;
  setLastLatencyMs: (ms: number | null) => void;
  setApiVersion: (v: string | null) => void;
  setLiveStats: (s: LiveStats | null) => void;
  openIncident: (id: string) => void;
  setFocusEventsSearch: (v: boolean) => void;
  setSessionExpired: (v: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activeSection: "overview",
      lang: "en",
      wsStatus: "connecting",
      lastWsEventAt: null,
      lastLatencyMs: null,
      apiVersion: null,
      liveStats: null,
      investigateIncidentId: null,
      focusEventsSearch: false,
      sessionExpired: false,
      setSection: (s) => set({ activeSection: s, focusEventsSearch: false }),
      setLang: (l) => set({ lang: l }),
      setWsStatus: (s) => set({ wsStatus: s }),
      setLastWsEventAt: (iso) => set({ lastWsEventAt: iso }),
      setLastLatencyMs: (ms) => set({ lastLatencyMs: ms }),
      setApiVersion: (v) => set({ apiVersion: v }),
      setLiveStats: (s) => set({ liveStats: s }),
      openIncident: (id) =>
        set({ investigateIncidentId: id, activeSection: "investigate", focusEventsSearch: false }),
      setFocusEventsSearch: (v) => set({ focusEventsSearch: v }),
      setSessionExpired: (v) => set({ sessionExpired: v }),
    }),
    {
      name: "sg-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ activeSection: s.activeSection, lang: s.lang }),
    },
  ),
);

/** Role helpers — RBAC is enforced server-side; these drive honest UI gating only. */
export type Role = "ADMIN" | "ANALYST" | "VIEWER";

export const isAdmin = (role?: Role | null) => role === "ADMIN";
export const isAnalystPlus = (role?: Role | null) => role === "ADMIN" || role === "ANALYST";
