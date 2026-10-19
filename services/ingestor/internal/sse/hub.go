// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package sse implements a small Server-Sent Events hub: subscribe/
// unsubscribe with per-client buffered channels (drop-slowest on overflow),
// a bounded replay ring for Last-Event-ID and a connection counter.
package sse

import (
	"sync"
	"sync/atomic"
)

// Message is one hub message with a monotonically increasing id.
type Message struct {
	ID      int64
	Channel string
	Payload any
}

// ringSize is the Last-Event-ID replay buffer size.
const ringSize = 100

// clientBuf is the per-client buffer; on overflow the oldest message for
// that client is dropped (drop-slowest policy).
const clientBuf = 64

// Subscriber is a hub client.
type Subscriber struct {
	ID    uint64
	ch    chan Message
	done  chan struct{}
	once  sync.Once
	hub   *Hub
}

// Chan returns the message channel (never closes; read until Unsubscribed).
func (s *Subscriber) Chan() <-chan Message { return s.ch }

// Done is closed when the subscriber is unsubscribed.
func (s *Subscriber) Done() <-chan struct{} { return s.done }

// Unsubscribe removes the subscriber from the hub. Idempotent.
func (s *Subscriber) Unsubscribe() {
	s.once.Do(func() {
		close(s.done)
		if s.hub != nil {
			s.hub.remove(s)
		}
	})
}

// Hub fans out messages to subscribers.
type Hub struct {
	mu     sync.Mutex
	nextID atomic.Uint64
	seq    atomic.Int64
	subs   map[uint64]*Subscriber
	ring   []Message
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{subs: make(map[uint64]*Subscriber)}
}

// Subscribe registers a new subscriber.
func (h *Hub) Subscribe() *Subscriber {
	s := &Subscriber{
		ID:   h.nextID.Add(1),
		ch:   make(chan Message, clientBuf),
		done: make(chan struct{}),
		hub:  h,
	}
	h.mu.Lock()
	h.subs[s.ID] = s
	h.mu.Unlock()
	return s
}

func (h *Hub) remove(s *Subscriber) {
	h.mu.Lock()
	delete(h.subs, s.ID)
	h.mu.Unlock()
}

// Publish sends a message on a channel to every subscriber, appending it to
// the replay ring. A client whose buffer is full drops its oldest message.
func (h *Hub) Publish(channel string, payload any) Message {
	msg := Message{ID: h.seq.Add(1), Channel: channel, Payload: payload}
	h.mu.Lock()
	h.ring = append(h.ring, msg)
	if len(h.ring) > ringSize {
		h.ring = h.ring[len(h.ring)-ringSize:]
	}
	for _, s := range h.subs {
		select {
		case s.ch <- msg:
		default:
			// drop the oldest buffered message for this client
			select {
			case <-s.ch:
			default:
			}
			select {
			case s.ch <- msg:
			default:
			}
		}
	}
	h.mu.Unlock()
	return msg
}

// Replay returns ring messages with id > afterID (for Last-Event-ID).
func (h *Hub) Replay(afterID int64) []Message {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []Message
	for _, m := range h.ring {
		if m.ID > afterID {
			out = append(out, m)
		}
	}
	return out
}

// Clients returns the current subscriber count.
func (h *Hub) Clients() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}
