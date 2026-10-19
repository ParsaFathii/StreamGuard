"use client";

// StreamGuard Console — structured AI report renderer.
// Distinct visual styles per block: facts emerald, hypotheses amber-dashed,
// next steps numbered, references mono.
import { BookOpen, Brain, ChevronRight, CircleHelp, FileSearch, ListOrdered, ScrollText, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { AiInvestigateResponse } from "@/lib/types";
import { useUiStore } from "@/lib/store";
import { useT } from "./primitives";

function ReportBlock({
  title,
  icon,
  items,
  className,
  ordered,
}: {
  title: string;
  icon: ReactNode;
  items: string[];
  className?: string;
  ordered?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className={`rounded-md border bg-card p-3 ${className ?? "border-border"}`}>
      <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon} {title}
      </h4>
      {ordered ? (
        <ol className="list-decimal space-y-1 ps-5 text-xs leading-relaxed">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      ) : (
        <ul className="space-y-1 text-xs leading-relaxed">
          {items.map((it, i) => (
            <li key={i} className="relative ps-3">
              <span aria-hidden className="absolute start-0 top-[7px] size-1 rounded-full bg-emerald-400" />
              {it}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AiReportView({ res }: { res: AiInvestigateResponse }) {
  const T = useT();
  const openIncident = useUiStore((s) => s.openIncident);
  const r = res.report;

  return (
    <div className="space-y-3">
      <section className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-3">
        <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
          <Sparkles className="size-3.5" /> {T("aiBlocks.summary")}
        </h4>
        <p className="text-xs leading-relaxed">{r.summary}</p>
        <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>
            {T("ai.provider")}: {res.provider.name} · {res.provider.model}
          </span>
          <span>
            {T("ai.duration")} {res.durationMs}ms
          </span>
        </p>
      </section>

      <ReportBlock
        title={T("aiBlocks.facts")}
        icon={<FileSearch className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
        items={r.facts}
        className="border-emerald-500/25"
      />
      <ReportBlock
        title={T("aiBlocks.ruleFindings")}
        icon={<ScrollText className="size-3.5 text-amber-600 dark:text-amber-300" />}
        items={r.ruleFindings}
      />
      <ReportBlock
        title={T("aiBlocks.mlFindings")}
        icon={<Brain className="size-3.5 text-teal-700 dark:text-teal-300" />}
        items={r.mlFindings}
      />

      {r.hypotheses.length > 0 && (
        <section className="rounded-md border border-dashed border-amber-400/50 bg-amber-400/5 p-3">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            <CircleHelp className="size-3.5" /> {T("aiBlocks.hypotheses")}
          </h4>
          <ul className="space-y-1 text-xs leading-relaxed">
            {r.hypotheses.map((h, i) => (
              <li key={i} className="relative ps-3">
                <span aria-hidden className="absolute start-0 top-[7px] size-1 rounded-full bg-amber-300" />
                {h}
              </li>
            ))}
          </ul>
        </section>
      )}

      <ReportBlock
        title={T("aiBlocks.nextSteps")}
        icon={<ListOrdered className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
        items={r.nextSteps}
        ordered
      />

      {r.references && (
        <section className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <BookOpen className="size-3.5" /> {T("aiBlocks.references")}
          </h4>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
            <button
              type="button"
              onClick={() => openIncident(r.references.incidentId)}
              className="inline-flex items-center gap-1 rounded border border-border bg-secondary/50 px-1.5 py-0.5 text-emerald-600 hover:underline dark:text-emerald-400"
            >
              {r.references.incidentId} <ChevronRight className="size-3" />
            </button>
            {(r.references.ruleIds ?? []).map((id) => (
              <span key={id} className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 text-muted-foreground">
                {id}
              </span>
            ))}
            <span dir="ltr" className="text-muted-foreground">
              {T("aiBlocks.events")}: {(r.references.eventIds ?? []).length}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
