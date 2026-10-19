// Copyright © 2026 Parsa Fathi — Apache-2.0

// The SSE live stream: GET /api/stream. event:new messages are coalesced
// into ~400ms batches ({events,count,ts}); other channels pass through
// immediately; a 15s keepalive comment keeps proxies from closing idle
// connections; Last-Event-ID replays from the hub ring (replayed event:new
// messages go through the same batching path so the data shape is stable).
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// stream intervals.
const (
	eventBatchInterval = 400 * time.Millisecond
	keepaliveInterval  = 15 * time.Second
	maxPendingEvents   = 128
)

// handleStream implements GET /api/stream (any authenticated role).
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "streaming not supported by this connection")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()

	sub := s.hub.Subscribe()
	defer sub.Unsubscribe()

	var lastID int64 // highest hub sequence seen; batch event id
	pending := make([]sse.LiveEventPayload, 0, 64)

	// writeEvent flushes the pending event batch (if any).
	writeEvent := func() {
		if len(pending) == 0 {
			return
		}
		payload := map[string]any{
			"events": pending,
			"count":  len(pending),
			"ts":     sse.FormatTime(s.Now()),
		}
		s.writeRawSSE(w, flusher, "event:new", lastID, payload)
		pending = pending[:0]
	}
	wrote := time.Now()
	// handleMsg routes one hub message (live or replayed).
	handleMsg := func(m sse.Message) {
		lastID = m.ID
		if m.Channel == sse.ChannelEventNew {
			if lep, ok := m.Payload.(sse.LiveEventPayload); ok {
				pending = append(pending, lep)
				if len(pending) >= maxPendingEvents {
					writeEvent()
				}
			}
			return
		}
		writeEvent() // flush before an out-of-band message
		s.writeSSEMessage(w, flusher, m, m.ID)
		wrote = time.Now()
	}

	// Last-Event-ID replay from the bounded hub ring.
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		if afterID, err := strconv.ParseInt(v, 10, 64); err == nil && afterID > 0 {
			for _, m := range s.hub.Replay(afterID) {
				handleMsg(m)
			}
		}
	}

	batchTicker := time.NewTicker(eventBatchInterval)
	defer batchTicker.Stop()
	keepalive := time.NewTicker(keepaliveInterval)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.Done():
			return
		case m := <-sub.Chan():
			handleMsg(m)
		case <-batchTicker.C:
			writeEvent()
			wrote = time.Now()
		case <-keepalive.C:
			if time.Since(wrote) >= keepaliveInterval-time.Second {
				fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
				wrote = time.Now()
			}
		}
	}
}

// writeSSEMessage writes one hub message as an SSE event.
func (s *Server) writeSSEMessage(w http.ResponseWriter, f http.Flusher, m sse.Message, id int64) {
	s.writeRawSSE(w, f, m.Channel, id, m.Payload)
}

// writeRawSSE writes an SSE frame with the given channel, id and payload.
func (s *Server) writeRawSSE(w http.ResponseWriter, f http.Flusher, channel string, id int64, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", id, channel, data)
	f.Flush()
}
