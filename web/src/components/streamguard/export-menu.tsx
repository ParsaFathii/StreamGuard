"use client";

// StreamGuard Console — evidence export menu (CSV/JSON download of the full
// filtered set, up to 5000 rows; server-side, audited). Console edition only —
// the Go reference service does not implement the export params.
import { useState } from "react";
import { ChevronDown, Download, FileJson, FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError, downloadFile } from "@/lib/api-client";
import { useT } from "./primitives";

export function ExportMenu({
  buildPath,
  disabled,
}: {
  /** Build the export URL for a format (filters already applied; format+limit appended). */
  buildPath: (format: "csv" | "json") => string;
  disabled?: boolean;
}) {
  const T = useT();
  const [busy, setBusy] = useState(false);

  const run = async (format: "csv" | "json") => {
    setBusy(true);
    try {
      const r = await downloadFile(buildPath(format));
      toast.success(T("export.toastOk", { file: r.filename, count: r.count ?? 0 }));
    } catch (e) {
      const ae = e as ApiError;
      toast.error(T("export.toastFail", { msg: ae.message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={disabled || busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          {T("export.button")}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="text-xs">
        <DropdownMenuItem onClick={() => void run("csv")}>
          <FileSpreadsheet className="size-3.5" />
          {T("export.csv")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run("json")}>
          <FileJson className="size-3.5" />
          {T("export.json")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
