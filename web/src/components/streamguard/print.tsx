"use client";

// StreamGuard Console — clean printable reports (incident / AI investigation).
// Opens a dedicated print window with a purpose-built document instead of
// fighting the app shell's scroll layout: reports get a proper header
// (case id, prepared-by, timestamp) and a confidentiality footer.
import { toast } from "sonner";
import type { AiInvestigateResponse } from "@/lib/types";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PrintDoc {
  title: string;
  subtitle?: string;
  /** Prepared-by (display name @username) */
  by: string;
  /** i18n strings supplied by the caller */
  labels: {
    generatedBy: string;
    generatedAt: string;
    confidential: string;
  };
  bodyHtml: string;
}

const PRINT_CSS = `
  * { box-sizing: border-box; }
  body { font: 12px/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
         color: #111; margin: 32px 40px; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #10b981;
           padding-bottom: 12px; margin-bottom: 18px; }
  .mark { width: 34px; height: 34px; border-radius: 8px; background: #10b981; color: #052e22;
          font-weight: 800; font-size: 15px; display: flex; align-items: center; justify-content: center; }
  h1 { font-size: 17px; margin: 0; }
  .sub { color: #555; font-size: 11px; margin-top: 2px; }
  .meta { margin-left: auto; text-align: right; font-size: 10px; color: #444; line-height: 1.6; }
  h2 { font-size: 13px; margin: 18px 0 6px; color: #065f46; border-bottom: 1px solid #d1fae5;
       padding-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th { text-align: left; background: #ecfdf5; border: 1px solid #d1fae5; padding: 3px 6px; }
  td { border: 1px solid #e5e7eb; padding: 3px 6px; vertical-align: top; }
  td.num, th.num { text-align: right; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .muted { color: #6b7280; }
  .chip { display: inline-block; border: 1px solid #d1d5db; border-radius: 999px;
          padding: 0 7px; font-size: 9.5px; margin-right: 4px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f9fafb; border: 1px solid #e5e7eb;
        border-radius: 6px; padding: 8px 10px; font-size: 10.5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 9.5px; color: #6b7280;
           border-top: 1px solid #e5e7eb; padding: 6px 40px 10px; background: #fff; }
  @page { margin: 18mm 14mm; }
  @media print { body { margin: 0 40px; } }
`;

/** Open the print window for a report document. Returns false when pop-ups are blocked. */
export function printReport(doc: PrintDoc, blockedMsg: string): boolean {
  const w = window.open("", "_blank", "width=980,height=760");
  if (!w) {
    toast.error(blockedMsg);
    return false;
  }
  const stamp = new Date();
  const iso = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(
    stamp.getDate(),
  ).padStart(2, "0")} ${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}:${String(
    stamp.getSeconds(),
  ).padStart(2, "0")}`;
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title>` +
      `<style>${PRINT_CSS}</style></head><body>` +
      `<header><div class="mark">SG</div><div><h1>${escapeHtml(doc.title)}</h1>` +
      (doc.subtitle ? `<div class="sub">${escapeHtml(doc.subtitle)}</div>` : "") +
      `</div><div class="meta"><div>${escapeHtml(doc.labels.generatedBy)}: ${escapeHtml(doc.by)}</div>` +
      `<div>${escapeHtml(doc.labels.generatedAt)}: <span class="mono">${iso}</span></div></div></header>` +
      doc.bodyHtml +
      `<footer>${escapeHtml(doc.labels.confidential)} · StreamGuard Console</footer>` +
      `</body></html>`,
  );
  w.document.close();
  w.focus();
  w.addEventListener(
    "load",
    () => {
      w.print();
    },
    { once: true },
  );
  return true;
}

export interface AiReportLabels {
  summary: string;
  facts: string;
  ruleFindings: string;
  mlFindings: string;
  hypotheses: string;
  nextSteps: string;
  references: string;
  events: string;
  incident: string;
  rules: string;
  provider: string;
}

/** Structured AI report → print HTML (shared by Investigation and AI section printouts). */
export function aiReportHtml(res: AiInvestigateResponse, L: AiReportLabels): string {
  const r = res.report;
  const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
  const out: string[] = [];
  out.push(`<h2>${escapeHtml(L.summary)}</h2><p>${escapeHtml(r.summary)}</p>`);
  if (r.facts.length) out.push(`<h2>${escapeHtml(L.facts)}</h2>${ul(r.facts)}`);
  if (r.ruleFindings.length) out.push(`<h2>${escapeHtml(L.ruleFindings)}</h2>${ul(r.ruleFindings)}`);
  if (r.mlFindings.length) out.push(`<h2>${escapeHtml(L.mlFindings)}</h2>${ul(r.mlFindings)}`);
  if (r.hypotheses.length) out.push(`<h2>${escapeHtml(L.hypotheses)}</h2>${ul(r.hypotheses)}`);
  if (r.nextSteps.length) out.push(`<h2>${escapeHtml(L.nextSteps)}</h2>${ul(r.nextSteps)}`);
  out.push(
    `<h2>${escapeHtml(L.references)}</h2><table><tbody>` +
      `<tr><th>${escapeHtml(L.incident)}</th><td class="mono">${escapeHtml(r.references.incidentId)}</td></tr>` +
      `<tr><th>${escapeHtml(L.events)}</th><td class="mono num">${r.references.eventIds.length}</td></tr>` +
      `<tr><th>${escapeHtml(L.rules)}</th><td class="mono">${escapeHtml(r.references.ruleIds.join(", "))}</td></tr>` +
      `</tbody></table>`,
  );
  out.push(
    `<p class="muted">${escapeHtml(L.provider)}: ${escapeHtml(res.provider.name)} · ${escapeHtml(res.provider.model)} · ${escapeHtml(res.provider.status)}</p>`,
  );
  return out.join("");
}
