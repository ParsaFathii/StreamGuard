// StreamGuard — live stream mini-service (socket.io relay), port 3003.
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Pure relay: the Next.js backend POSTs {channel, payload} to the internal
// HTTP endpoint (POST /emit) and this service io.emit()s it to all connected
// browsers. Browsers connect with io("/?XTransformPort=3003").
//
// socket.io owns path '/' (required by the Caddy gateway). Because engine.io
// intercepts every request whose URL starts with '/', we take over the
// httpServer "request" dispatch and special-case GET /health and POST /emit
// in front of the socket.io listener.
//
// "Internal only" binding logic for /emit (single machine, Caddy gateway in
// front): the request must originate from a loopback address AND must not have
// arrived through the external gateway (requests forwarded by Caddy carry
// X-Forwarded-For — those are browser requests and are rejected for /emit).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Server, type Socket } from 'socket.io'

const PORT = 3003
const startedAt = Date.now()
let connections = 0

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'use GET /health or POST /emit' } }))
}

// base handler: fallback for anything socket.io does not claim
const httpServer = createServer((req, res) => {
  notFound(res)
})

const io = new Server(httpServer, {
  // DO NOT change the path — Caddy uses it to forward to this port
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

function isLoopback(remote: string | undefined): boolean {
  if (!remote) return false
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handleEmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // internal only: loopback + not forwarded through the external gateway
  if (!isLoopback(req.socket.remoteAddress) || req.headers['x-forwarded-for'] !== undefined) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: '/emit is internal-only (loopback, non-proxied)' } }))
    return
  }
  try {
    const body = JSON.parse(await readBody(req)) as { channel?: unknown; payload?: unknown }
    const channel = body.channel
    if (typeof channel !== 'string' || channel.length < 1 || channel.length > 64 || !/^[\w:. -]+$/.test(channel)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'INVALID_CHANNEL', message: 'channel must be a short identifier string' } }))
      return
    }
    io.emit(channel, body.payload ?? null)
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, channel, connections }))
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'INVALID_BODY', message: 'body must be JSON {channel, payload}' } }))
  }
}

function handleHealth(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, connections, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }))
}

// take over request dispatch: /health + /emit in front of socket.io
const sioListener = httpServer.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void
httpServer.removeAllListeners('request')
httpServer.on('request', (req, res) => {
  const pathname = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && pathname === '/health') {
    handleHealth(res)
    return
  }
  if (req.method === 'POST' && pathname === '/emit') {
    void handleEmit(req, res).catch(() => {
      if (!res.writableEnded) notFound(res)
    })
    return
  }
  sioListener.call(httpServer, req, res)
})

io.on('connection', (socket: Socket) => {
  connections += 1
  console.log(`[stream] connect ${socket.id} (total ${connections})`)
  socket.on('disconnect', (reason) => {
    connections = Math.max(0, connections - 1)
    console.log(`[stream] disconnect ${socket.id} (${reason}; total ${connections})`)
  })
  socket.on('error', (err) => {
    console.warn(`[stream] socket error ${socket.id}:`, err)
  })
})

// Internal-only relay: binds loopback by default (CONTRACT §Real-time "internal only").
// Set STREAM_BIND=0.0.0.0 to listen on all interfaces (container/remote demos);
// the host gateway (e.g. Caddy) still proxies to 127.0.0.1:3003 by default.
const BIND: string = process.env.STREAM_BIND ?? '127.0.0.1'
httpServer.listen(PORT, BIND, () => {
  console.log(`[stream] StreamGuard live stream service listening on ${BIND}:${PORT} (socket.io path '/', HTTP /health + /emit)`)
})

process.on('SIGTERM', () => {
  console.log('[stream] SIGTERM — shutting down')
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  console.log('[stream] SIGINT — shutting down')
  httpServer.close(() => process.exit(0))
})
