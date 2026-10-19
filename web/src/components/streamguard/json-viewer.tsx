"use client";

// StreamGuard Console — dependency-free JSON syntax highlighter.
// Simple regex tokenizer over pre-escaped JSON text: keys emerald, strings amber,
// numbers teal, booleans/null rose, punctuation muted.
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { useT } from "./primitives";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(json: string): string {
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
    (match, str: string | undefined, colon: string | undefined, kw: string | undefined, num: string | undefined) => {
      if (str !== undefined) {
        if (colon !== undefined) return `<span class="sg-j-key">${str}</span><span class="sg-j-punc">${colon}</span>`;
        return `<span class="sg-j-str">${str}</span>`;
      }
      if (kw !== undefined) return `<span class="sg-j-bool">${kw}</span>`;
      if (num !== undefined) return `<span class="sg-j-num">${num}</span>`;
      return match;
    },
  );
}

export function JsonViewer({
  value,
  className,
  maxHeight,
  copyable = true,
  label,
}: {
  value: unknown;
  className?: string;
  maxHeight?: number;
  copyable?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const T = useT();
  const html = useMemo(() => highlight(JSON.stringify(value ?? null, null, 2)), [value]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value ?? null, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className={cn("relative rounded-md border border-border bg-[#0C110F]", className)}>
      {copyable && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={T("common.copyJson")}
          className="absolute end-1.5 top-1.5 z-10 rounded border border-border bg-secondary/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3" />}
        </button>
      )}
      <pre
        dir="ltr"
        className={cn("sg-json max-w-full overflow-auto p-3 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere] text-foreground/90")}
        style={maxHeight ? { maxHeight } : undefined}
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
