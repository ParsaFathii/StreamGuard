"use client";

// StreamGuard Console — list pagination footer (page X of Y · total · pageSize 25/50/100).
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "./primitives";

export function PaginationFooter({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  extra,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize?: (s: number) => void;
  extra?: React.ReactNode;
}) {
  const T = useT();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-1 py-2 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span>
          <span dir="ltr" className="sg-num">{from}–{to}</span> · {T("common.total")}{" "}
          <span dir="ltr" className="sg-num">{total.toLocaleString("en-US")}</span>
        </span>
        {extra}
      </div>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <div className="flex items-center gap-1.5">
            <span className="hidden sm:inline">{T("common.perPage")}</span>
            <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
              <SelectTrigger size="sm" className="h-8 w-[72px] font-mono text-[11px] max-sm:h-11 max-sm:w-20" aria-label={T("common.perPage")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100].map((s) => (
                  <SelectItem key={s} value={String(s)} className="font-mono text-xs">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <span>
          {T("common.page")} <span dir="ltr" className="sg-num">{page}</span> {T("common.of")}{" "}
          <span dir="ltr" className="sg-num">{pages}</span>
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-7 max-sm:size-11"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            aria-label={T("common.prev")}
          >
            <ChevronLeft className="size-3.5 rtl:-scale-x-100" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7 max-sm:size-11"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
            aria-label={T("common.next")}
          >
            <ChevronRight className="size-3.5 rtl:-scale-x-100" />
          </Button>
        </div>
      </div>
    </div>
  );
}
