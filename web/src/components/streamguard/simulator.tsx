"use client";

// StreamGuard Console — simulator quick actions (tick + scenarios), shared by
// empty states and the Sources section. ANALYST+ only (server enforces anyway).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Play, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import type { SessionUser } from "@/lib/types";
import { isAnalystPlus } from "@/lib/store";
import { useT } from "./primitives";

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] === "overview" ||
        q.queryKey[0] === "events" ||
        q.queryKey[0] === "detections" ||
        q.queryKey[0] === "incidents" ||
        q.queryKey[0] === "rules" ||
        q.queryKey[0] === "sources" ||
        q.queryKey[0] === "ml" ||
        q.queryKey[0] === "health",
    });
}

export function GenerateActivityButton({ user, size = "sm" }: { user?: SessionUser | null; size?: "sm" | "default" }) {
  const T = useT();
  const invalidateAll = useInvalidateAll();
  const [busy, setBusy] = useState(false);
  if (user && !isAnalystPlus(user.role)) return null;

  return (
    <Button
      size={size}
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await api.tick(12);
          toast.success(T("toasts.tickDone", { n: res.generated ?? 0 }));
          invalidateAll();
        } catch (err) {
          toast.error(err instanceof ApiError && err.status === 403 ? T("toasts.forbidden") : T("toasts.tickFailed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
      {busy ? T("common.generatingActivity") : T("common.generateActivity")}
    </Button>
  );
}

export function ScenarioRunButtons({ user }: { user: SessionUser }) {
  const T = useT();
  const invalidateAll = useInvalidateAll();
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!isAnalystPlus(user.role)) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {(
        [
          "brute_force",
          "credential_stuffing",
          "traffic_burst",
          "error_storm",
          "config_change",
          "authz_failures",
          "mixed_attack",
        ] as const
      ).map((id) => (
        <Button
          key={id}
          size="sm"
          variant="outline"
          className="h-7 font-mono text-[11px]"
          disabled={busyId !== null}
          onClick={async () => {
            setBusyId(id);
            try {
              const res = await api.runScenario(id);
              toast.success(T("toasts.scenarioDone", { n: res.generated ?? 0 }));
              invalidateAll();
            } catch (err) {
              toast.error(err instanceof ApiError && err.status === 403 ? T("toasts.forbidden") : T("toasts.scenarioFailed"));
            } finally {
              setBusyId(null);
            }
          }}
        >
          {busyId === id ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          {id}
        </Button>
      ))}
    </div>
  );
}
