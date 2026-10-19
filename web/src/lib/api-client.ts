"use client";

// StreamGuard Console — typed API client for every endpoint in CONTRACT.md.
// Base '' (demo edition); can be pointed at the Go edition via NEXT_PUBLIC_API_BASE.
import type {
  AiInvestigateResponse,
  OverviewResponse,
  AuditEntry,
  Detection,
  EventInput,
  HealthResponse,
  Incident,
  IncidentDetail,
  MlEvaluation,
  MlResponse,
  Paginated,
  ScenarioInfo,
  SgEvent,
  SgRule,
  SgSettings,
  SessionUser,
  SourceInfo,
} from "@/lib/types";
import { useUiStore } from "@/lib/store";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** Build a query string, skipping undefined/null/empty values. */
function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Core fetch wrapper: credentials, JSON, ApiError normalization, latency/version tracking. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    useUiStore.getState().setLastLatencyMs(null);
    throw new ApiError("NETWORK_ERROR", err instanceof Error ? err.message : "network error", 0);
  }

  const ms = Math.round(performance.now() - started);
  const store = useUiStore.getState();
  store.setLastLatencyMs(ms);
  const version = res.headers.get("x-streamguard-version");
  if (version) store.setApiVersion(version);

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || "request failed";
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return (await res.text()) as unknown as T;
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Some endpoints return bare arrays — normalize to array. */
function asArray<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    if (Array.isArray(r.data)) return r.data as T[];
    if (Array.isArray(r.rules)) return r.rules as T[];
    if (Array.isArray(r.sources)) return r.sources as T[];
  }
  return [];
}

function asPaginated<T>(res: unknown): Paginated<T> {
  if (res && typeof res === "object" && "data" in (res as Record<string, unknown>)) {
    return res as Paginated<T>;
  }
  const arr = asArray<T>(res);
  return { data: arr, page: 1, pageSize: arr.length, total: arr.length };
}

/* ------------------------------- Auth ---------------------------------- */

export interface LoginResponse {
  user: SessionUser;
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  session: () => request<{ user: SessionUser }>("/api/auth/session"),

  /* ---------------------------- Ingestion ------------------------------ */

  ingest: (payload: EventInput | { batch: EventInput[] }) =>
    request<{
      accepted: number;
      duplicates: number;
      rejected: number;
      eventIds?: string[];
      rejectedItems?: Array<{ index: number; reason: string }>;
    }>("/api/ingest", { method: "POST", body: JSON.stringify(payload) }),

  /* ------------------------------ Events ------------------------------- */

  events: (filters: {
    q?: string;
    severity?: string[];
    category?: string;
    sourceId?: string;
    sourceType?: string;
    from?: string;
    to?: string;
    correlationId?: string;
    traceId?: string;
    incidentId?: string;
    ruleId?: string;
    status?: string;
    origin?: string;
    page?: number;
    pageSize?: number;
  }) =>
    request<unknown>(`/api/events${qs({ ...filters, severity: filters.severity?.join(",") })}`).then(
      (r) => asPaginated<SgEvent>(r),
    ),

  event: (id: string) => request<SgEvent>(`/api/events/${encodeURIComponent(id)}`),

  /* ------------------------------ Rules -------------------------------- */

  rules: () => request<unknown>("/api/rules").then((r) => asArray<SgRule>(r)),

  patchRule: (
    id: string,
    patch: {
      enabled?: boolean;
      threshold?: number;
      windowSeconds?: number;
      severity?: string;
      cooldownSeconds?: number;
    },
  ) => request<SgRule>(`/api/rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),

  ruleAudit: (id: string) =>
    request<unknown>(`/api/rules/${encodeURIComponent(id)}/audit`).then((r) =>
      asArray<AuditEntry & { ruleId: string }>(r),
    ),

  /* ---------------------------- Detections ----------------------------- */

  detections: (filters: {
    ruleId?: string;
    severity?: string;
    incidentId?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) => request<unknown>(`/api/detections${qs(filters)}`).then((r) => asPaginated<Detection>(r)),

  /* ----------------------------- Incidents ----------------------------- */

  incidents: (filters: {
    status?: string;
    severity?: string;
    ruleId?: string;
    assignedTo?: string;
    q?: string;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) => request<unknown>(`/api/incidents${qs(filters)}`).then((r) => asPaginated<Incident>(r)),

  incident: (id: string) => request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}`),

  patchIncident: (
    id: string,
    patch: { status?: string; assignedTo?: string | null; resolutionSummary?: string },
  ) =>
    request<Incident>(`/api/incidents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  addNote: (id: string, body: string) =>
    request<unknown>(`/api/incidents/${encodeURIComponent(id)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  incidentEvents: (id: string, page = 1, pageSize = 25) =>
    request<unknown>(`/api/incidents/${encodeURIComponent(id)}/events${qs({ page, pageSize })}`).then((r) =>
      asPaginated<SgEvent>(r),
    ),

  /* ----------------------------- Analytics ----------------------------- */

  analyticsOverview: () => request<OverviewResponse>("/api/analytics/overview"),

  timeseries: (metric: "events" | "detections" | "rejected", points = 60, bucket = "minute") =>
    request<Array<{ bucketStart: string; value: number }>>(
      `/api/analytics/timeseries${qs({ metric, points, bucket })}`,
    ),

  ml: () => request<MlResponse>("/api/analytics/ml"),

  mlEvaluate: () => request<MlEvaluation>("/api/analytics/ml/evaluate", { method: "POST" }),

  /* -------------------------------- AI --------------------------------- */

  aiInvestigate: (incidentId: string, question?: string) =>
    request<AiInvestigateResponse>("/api/ai/investigate", {
      method: "POST",
      body: JSON.stringify(question ? { incidentId, question } : { incidentId }),
    }),

  /* ----------------------------- Simulator ----------------------------- */

  scenarios: () => request<unknown>("/api/simulator/scenarios").then((r) => asArray<ScenarioInfo>(r)),

  runScenario: (scenarioId: string, seed?: number) =>
    request<{ runId: string; generated: number; eventIds: string[]; note?: string }>(
      "/api/simulator/scenario",
      { method: "POST", body: JSON.stringify(seed ? { scenarioId, seed } : { scenarioId }) },
    ),

  tick: (count = 12) =>
    request<{ generated: number; eventIds?: string[] }>("/api/simulator/tick", {
      method: "POST",
      body: JSON.stringify({ count }),
    }),

  resetSimulator: () =>
    request<{ ok: boolean }>("/api/simulator/reset", { method: "POST", body: JSON.stringify({}) }),

  /* ------------------------------ Sources ------------------------------ */

  sources: () => request<unknown>("/api/sources").then((r) => asArray<SourceInfo>(r)),

  /* ------------------------------- System ------------------------------ */

  health: () => request<HealthResponse>("/api/health"),

  metricsText: () => request<string>("/api/metrics"),

  audit: (filters: {
    actor?: string;
    action?: string;
    targetType?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) => request<unknown>(`/api/audit${qs(filters)}`).then((r) => asPaginated<AuditEntry>(r)),

  settings: () => request<SgSettings>("/api/settings"),

  patchSettings: (patch: Partial<SgSettings>) =>
    request<SgSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  retentionRun: () =>
    request<{ deletedCount: number }>("/api/system/retention-run", { method: "POST", body: JSON.stringify({}) }),
};
