// StreamGuard — evidence export (CSV/JSON) for list endpoints.
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Every list endpoint that takes filters also accepts `format=csv|json` plus
// `limit` (integer 1..5000, default 2000). With `format` present the response
// becomes a file download (Content-Disposition: attachment) carrying up to
// `limit` rows in the endpoint's normal filter/sort order. Every export is
// audited (action: 'export') so evidence leaving the system is traceable.
//
// CSV is RFC 4180 (CRLF, quoted fields, doubled quotes), UTF-8 with a BOM so
// Excel opens Persian text correctly. JSON is a pretty-printed envelope
// {kind, exportedAt, count, data}.
import { NextResponse } from 'next/server'
import { jsonError, versionHeaders } from './http'

export const EXPORT_LIMIT_DEFAULT = 2000
export const EXPORT_LIMIT_MAX = 5000
export type ExportFormat = 'csv' | 'json'

export interface ExportParams {
  format: ExportFormat
  limit: number
}

export interface ExportColumn {
  header: string
  key: string
}

/**
 * Parse `format`/`limit`. Returns value=null when no `format` param is present
 * (the endpoint then serves its normal paginated JSON), an error response for
 * invalid values, or the parsed export params.
 */
export function readExportParams(
  url: URL,
): { ok: true; value: ExportParams | null } | { ok: false; error: NextResponse } {
  const raw = url.searchParams.get('format')
  if (raw === null) return { ok: true, value: null }
  if (raw !== 'csv' && raw !== 'json') {
    return { ok: false, error: jsonError(400, 'INVALID_FILTER', "format must be 'csv' or 'json'") }
  }
  const rawLimit = url.searchParams.get('limit')
  let limit = EXPORT_LIMIT_DEFAULT
  if (rawLimit !== null) {
    const n = Number(rawLimit)
    if (!Number.isInteger(n) || n < 1 || n > EXPORT_LIMIT_MAX) {
      return { ok: false, error: jsonError(400, 'INVALID_FILTER', `limit must be an integer 1..${EXPORT_LIMIT_MAX}`) }
    }
    limit = n
  }
  return { ok: true, value: { format: raw, limit } }
}

/** RFC 4180 field: objects are compact JSON, quotes are doubled, CRLF-safe. */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** CSV document: UTF-8 BOM + header row + CRLF rows. */
export function toCsv(columns: ExportColumn[], rows: Array<Record<string, unknown>>): string {
  const head = columns.map((c) => csvField(c.header)).join(',')
  const body = rows.map((r) => columns.map((c) => csvField(r[c.key])).join(',')).join('\r\n')
  return rows.length > 0 ? `\uFEFF${head}\r\n${body}` : `\uFEFF${head}\r\n`
}

function exportFilename(kind: string, format: ExportFormat): string {
  const t = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `streamguard-${kind}-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}T${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.${format}`
}

/** Build the download response for an export (CSV or JSON envelope). */
export function exportResponse(
  kind: string,
  params: ExportParams,
  rows: Array<Record<string, unknown>>,
  columns: ExportColumn[],
): NextResponse {
  const filename = exportFilename(kind, params.format)
  if (params.format === 'csv') {
    return new NextResponse(toCsv(columns, rows), {
      headers: versionHeaders({
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'x-export-count': String(rows.length),
        'x-export-format': 'csv',
      }),
    })
  }
  return new NextResponse(
    JSON.stringify({ kind, exportedAt: new Date().toISOString(), count: rows.length, data: rows }, null, 2),
    {
      headers: versionHeaders({
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'x-export-count': String(rows.length),
        'x-export-format': 'json',
      }),
    },
  )
}
