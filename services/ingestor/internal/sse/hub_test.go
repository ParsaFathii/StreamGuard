// Copyright © 2026 Parsa Fathii — Apache-2.0

package sse

import (
        "testing"
        "time"
)

func drain(s *Subscriber) []Message {
        var out []Message
        for {
                select {
                case m := <-s.Chan():
                        out = append(out, m)
                default:
                        return out
                }
        }
}

func TestPublishSubscribe(t *testing.T) {
        h := NewHub()
        s := h.Subscribe()
        h.Publish(ChannelEventNew, map[string]any{"id": "e1"})
        h.Publish(ChannelDetectionNew, map[string]any{"id": "d1"})
        msgs := drain(s)
        if len(msgs) != 2 {
                t.Fatalf("got %d messages, want 2", len(msgs))
        }
        if msgs[0].ID != 1 || msgs[1].ID != 2 || msgs[0].Channel != ChannelEventNew || msgs[1].Channel != ChannelDetectionNew {
                t.Fatalf("bad messages: %+v", msgs)
        }
        if h.Clients() != 1 {
                t.Fatalf("clients = %d", h.Clients())
        }
        s.Unsubscribe()
        if h.Clients() != 0 {
                t.Fatalf("clients after unsubscribe = %d", h.Clients())
        }
}

func TestUnsubscribeIdempotent(t *testing.T) {
        h := NewHub()
        s := h.Subscribe()
        s.Unsubscribe()
        s.Unsubscribe() // must not panic
        select {
        case <-s.Done():
        default:
                t.Fatalf("done not closed")
        }
        // hub still works
        s2 := h.Subscribe()
        h.Publish("x", 1)
        if len(drain(s2)) != 1 {
                t.Fatalf("hub broken after unsubscribe")
        }
}

func TestDropOldestOnOverflow(t *testing.T) {
        h := NewHub()
        s := h.Subscribe()
        // Publish more than the 64-slot buffer without reading.
        const total = 100
        for i := 0; i < total; i++ {
                h.Publish("stats", i)
        }
        msgs := drain(s)
        if len(msgs) > clientBuf {
                t.Fatalf("client buffer overflowed: %d messages", len(msgs))
        }
        if len(msgs) == 0 {
                t.Fatalf("all messages dropped")
        }
        last := msgs[len(msgs)-1]
        if last.ID != int64(total) {
                t.Fatalf("newest message lost: last id = %d, want %d", last.ID, total)
        }
        // ids must be increasing (oldest dropped, order preserved)
        for i := 1; i < len(msgs); i++ {
                if msgs[i].ID <= msgs[i-1].ID {
                        t.Fatalf("message order broken")
                }
        }
}

func TestReplayRing(t *testing.T) {
        h := NewHub()
        s := h.Subscribe()
        for i := 0; i < 150; i++ { // ring keeps last 100
                h.Publish("event:new", i)
        }
        msgs := drain(s)
        _ = msgs
        replay := h.Replay(140)
        if len(replay) != 10 { // ids 141..150
                t.Fatalf("replay len = %d, want 10", len(replay))
        }
        if len(replay) > 0 && replay[0].ID != 141 {
                t.Fatalf("replay starts at %d, want 141", replay[0].ID)
        }
        all := h.Replay(0)
        if len(all) != 100 {
                t.Fatalf("ring keeps %d, want 100", len(all))
        }
        if h.Replay(999) != nil {
                t.Fatalf("replay beyond head should be empty")
        }
}

func TestConcurrentPublish(t *testing.T) {
        h := NewHub()
        s1 := h.Subscribe()
        s2 := h.Subscribe()
        done := make(chan struct{})
        go func() {
                defer close(done)
                for i := 0; i < 500; i++ {
                        h.Publish("event:new", i)
                }
        }()
        <-done
        total := len(drain(s1)) + len(drain(s2))
        if total < 2*clientBuf-clientBuf/2 {
                t.Fatalf("suspiciously few messages delivered: %d", total)
        }
}

func TestTruncateMessage(t *testing.T) {
        long := ""
        for i := 0; i < 50; i++ {
                long += "سلام" // 4 runes each -> 200 runes
        }
        if got := TruncateMessage(long, 140); len([]rune(got)) != 140 {
                t.Fatalf("truncate failed: %d runes", len([]rune(got)))
        }
        if got := TruncateMessage("short", 140); got != "short" {
                t.Fatalf("short message altered: %q", got)
        }
}

func TestFormatTime(t *testing.T) {
        ts := time.Date(2026, 1, 15, 12, 0, 0, 123000000, time.UTC)
        if got := FormatTime(ts); got != "2026-01-15T12:00:00.123Z" {
                t.Fatalf("FormatTime = %q", got)
        }
}
