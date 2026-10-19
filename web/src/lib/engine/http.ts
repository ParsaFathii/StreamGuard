// StreamGuard — shared HTTP helpers for API routes.
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'

export const API_VERSION = '10.4.0'

/** Version header set for all responses; raw (non-JSON) responses such as CSV exports use it directly. */
export function versionHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'X-StreamGuard-Version': API_VERSION, ...(extra ?? {}) }
}

export function jsonOk(data: unknown, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(data, { status, headers: versionHeaders(headers) })
}

export function jsonError(status: number, code: string, message: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: versionHeaders(headers) })
}

/**
 * Uniform route-handler safety net: any unhandled throw becomes a contract-
 * shaped 500 `{error:{code:'INTERNAL',...}}` instead of Next.js' empty body.
 * Preserves behavior exactly — it only adds the catch-all.
 * For dynamic routes pass the ctx type: `apiRoute<{ params: Promise<{ id: string }> }>`.
 */
export function apiRoute<C = unknown>(fn: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      return await fn(req, ctx)
    } catch (err) {
      console.error('[api] unhandled error', err)
      return jsonError(500, 'INTERNAL', 'Internal server error')
    }
  }
}

export const unauthorized = (): NextResponse => jsonError(401, 'UNAUTHORIZED', 'Authentication required')
export const forbidden = (): NextResponse => jsonError(403, 'FORBIDDEN', 'Insufficient role for this action')
export const notFound = (what: string): NextResponse => jsonError(404, 'NOT_FOUND', `${what} not found`)

export interface Pagination {
  page: number
  pageSize: number
  skip: number
  take: number
}

export function parsePagination(url: URL, defPageSize = 25, maxPageSize = 100): { ok: true; value: Pagination } | { ok: false; param: string } {
  const rawPage = url.searchParams.get('page')
  const rawSize = url.searchParams.get('pageSize')
  let page = 1
  let pageSize = defPageSize
  if (rawPage !== null) {
    const n = Number(rawPage)
    if (!Number.isInteger(n) || n < 1) return { ok: false, param: 'page' }
    page = n
  }
  if (rawSize !== null) {
    const n = Number(rawSize)
    if (!Number.isInteger(n) || n < 1 || n > maxPageSize) return { ok: false, param: 'pageSize' }
    pageSize = n
  }
  return { ok: true, value: { page, pageSize, skip: (page - 1) * pageSize, take: pageSize } }
}

export function invalidFilter(param: string, message?: string): NextResponse {
  return jsonError(400, 'INVALID_FILTER', message ?? `Invalid filter value for '${param}'`)
}

export function readEnumMulti(url: URL, name: string, allowed: readonly string[]): { values?: string[]; error?: string } {
  const raw = url.searchParams.get(name)
  if (raw === null) return {}
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  for (const p of parts) {
    if (!allowed.includes(p)) return { error: `${name} must be one of ${allowed.join('|')} (csv allowed)` }
  }
  return { values: parts }
}

export function readEnumSingle(url: URL, name: string, allowed: readonly string[]): { value?: string; error?: string } {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return {}
  if (!allowed.includes(raw)) return { error: `${name} must be one of ${allowed.join('|')}` }
  return { value: raw }
}

export function readIsoRange(url: URL): { from?: Date; to?: Date; error?: string } {
  const rawFrom = url.searchParams.get('from')
  const rawTo = url.searchParams.get('to')
  let from: Date | undefined
  let to: Date | undefined
  if (rawFrom) {
    const d = new Date(rawFrom)
    if (Number.isNaN(d.getTime())) return { error: 'from must be an ISO-8601 timestamp' }
    from = d
  }
  if (rawTo) {
    const d = new Date(rawTo)
    if (Number.isNaN(d.getTime())) return { error: 'to must be an ISO-8601 timestamp' }
    to = d
  }
  return { from, to }
}

export function readSafeString(url: URL, name: string, max = 128): { value?: string; error?: string } {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return {}
  if (raw.length > max) return { error: `${name} must be <= ${max} chars` }
  return { value: raw }
}
