package poison

import (
	"bytes"
	"fmt"
	"strings"
	"unicode/utf8"
)

type responseMode uint8

const (
	responseRaw responseMode = iota
	responseJSON
	responseSSE
)

type textCheckpoint struct {
	lane string
	end  int
}

type guardedFrame struct {
	wire   []byte
	stored bool
	offset int64
	length int64
	ends   []textCheckpoint
}

type responseLane struct {
	guard *StreamGuard
	end   int
}

// responseGuard keeps the original wire bytes separate from decoded text.
// Only whole SSE frames at or before the inspected text frontier may be sent.
type responseGuard struct {
	mode         responseMode
	detector     *Detector
	text         *StreamGuard
	input        []byte
	pending      wireSpool
	queued       wireSpool
	frames       []guardedFrame
	queuedMemory int
	lanes        map[string]*responseLane
	scan         int
	line         int
	reason       string
}

func newResponseGuard(d *Detector, contentType string) *responseGuard {
	mode := responseRaw
	ct := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if ct == "text/event-stream" {
		mode = responseSSE
	} else if ct == "application/json" || strings.HasSuffix(ct, "+json") {
		mode = responseJSON
	}
	return &responseGuard{mode: mode, detector: d, text: d.NewStreamGuard(), lanes: make(map[string]*responseLane)}
}

func (g *responseGuard) feed(data []byte, final bool) ([]byte, bool, error) {
	if final {
		defer g.clear()
	}
	if g.reason != "" {
		return nil, true, nil
	}
	if g.mode == responseRaw {
		out, verdict := g.text.Feed(string(data))
		if verdict == VerdictBlock {
			g.reason = g.text.Reason()
			return nil, true, nil
		}
		if final {
			tail, v := g.text.Flush()
			if v == VerdictBlock {
				g.reason = g.text.Reason()
				return nil, true, nil
			}
			out += tail
		}
		return []byte(out), false, nil
	}
	if g.mode == responseJSON {
		if err := g.pending.append(data); err != nil {
			return nil, false, err
		}
		if !final {
			return nil, false, nil
		}
		body, err := g.pending.bytes()
		if err != nil {
			return nil, false, err
		}
		parts, err := decodedResponseParts(body)
		if err != nil {
			parts = []responseText{{lane: "raw", text: string(body)}}
		}
		if g.inspectParts(parts) {
			g.input = nil
			return nil, true, nil
		}
		// Ordinary upstream errors retain their original bytes and status.
		return body, false, nil
	}

	g.input = append(g.input, data...)
	var out []byte
	for {
		end := g.nextFrame(final)
		if end == 0 {
			if len(g.input) > wireMemoryThreshold {
				cut := len(g.input) - 1
				if err := g.pending.append(g.input[:cut]); err != nil {
					return nil, false, err
				}
				g.input = bytes.Clone(g.input[cut:])
				g.scan -= cut
				g.line -= cut
			}
			break
		}
		if err := g.pending.append(g.input[:end]); err != nil {
			return nil, false, err
		}
		frame, err := g.pending.bytes()
		g.pending.close()
		if err != nil {
			return nil, false, err
		}
		g.input = g.input[end:]
		g.scan, g.line = 0, 0
		parts, err := sseFrameParts(frame)
		if err != nil {
			return nil, false, err
		}
		blocked, err := g.appendFrame(frame, parts)
		if err != nil {
			return nil, false, err
		}
		if blocked {
			g.clear()
			return nil, true, nil
		}
		released, err := g.release(false)
		if err != nil {
			return nil, false, err
		}
		out = append(out, released...)
	}
	if final {
		if len(g.input) > 0 || g.pending.size > 0 {
			// A complete final event need not end in a blank line. Its payload
			// must still be valid; do not silently finish an incomplete JSON event.
			if err := g.pending.append(g.input); err != nil {
				return nil, false, err
			}
			frame, err := g.pending.bytes()
			g.pending.close()
			if err != nil {
				return nil, false, err
			}
			parts, err := sseFrameParts(frame)
			if err != nil {
				return nil, false, err
			}
			blocked, err := g.appendFrame(frame, parts)
			if err != nil {
				return nil, false, err
			}
			g.input = nil
			if blocked {
				g.clear()
				return nil, true, nil
			}
		}
		for _, lane := range g.lanes {
			if _, verdict := lane.guard.Flush(); verdict == VerdictBlock {
				g.reason = lane.guard.Reason()
				g.clear()
				return nil, true, nil
			}
		}
		released, err := g.release(true)
		if err != nil {
			return nil, false, err
		}
		out = append(out, released...)
	}
	return out, false, nil
}

// nextFrame recognizes LF, CRLF and CR without changing the original bytes.
func (g *responseGuard) nextFrame(final bool) int {
	for g.scan < len(g.input) {
		i := g.scan
		if g.input[i] != '\n' && g.input[i] != '\r' {
			g.scan++
			continue
		}
		end := i + 1
		if g.input[i] == '\r' {
			if end == len(g.input) && !final {
				return 0
			}
			if end < len(g.input) && g.input[end] == '\n' {
				end++
			}
		}
		blank := i == g.line
		g.scan, g.line = end, end
		if blank {
			return end
		}
	}
	return 0
}

func (g *responseGuard) clear() {
	g.pending.close()
	g.queued.close()
	g.input = nil
	g.frames = nil
	g.queuedMemory = 0
	g.lanes = nil
	g.text = nil
}

func (g *responseGuard) inspectParts(parts []responseText) bool {
	for _, part := range parts {
		if part.final {
			for key, lane := range g.lanes {
				if key == part.lane || strings.HasPrefix(key, part.lane+"/") {
					if _, verdict := lane.guard.Flush(); verdict == VerdictBlock {
						g.reason = lane.guard.Reason()
						return true
					}
				}
			}
			continue
		}
		if part.text == "" {
			continue
		}
		lane := g.lanes[part.lane]
		if lane == nil {
			lane = &responseLane{guard: g.detector.NewStreamGuard()}
			g.lanes[part.lane] = lane
		}
		lane.end += utf8.RuneCountInString(part.text)
		if _, verdict := lane.guard.Feed(part.text); verdict == VerdictBlock {
			g.reason = lane.guard.Reason()
			return true
		}
	}
	return false
}

func (g *responseGuard) appendFrame(wire []byte, parts []responseText) (bool, error) {
	if g.inspectParts(parts) {
		return true, nil
	}
	frame := guardedFrame{wire: wire}
	if len(wire)+g.queuedMemory > wireMemoryThreshold {
		frame.offset = g.queued.size
		frame.length = int64(len(wire))
		if err := g.queued.spill(); err != nil {
			return false, err
		}
		if err := g.queued.append(wire); err != nil {
			return false, err
		}
		frame.stored = true
		frame.wire = nil
	} else {
		g.queuedMemory += len(wire)
	}
	for _, part := range parts {
		if part.final || part.text == "" {
			continue
		}
		frame.ends = append(frame.ends, textCheckpoint{lane: part.lane, end: g.lanes[part.lane].end})
	}
	g.frames = append(g.frames, frame)
	return false, nil
}

func (g *responseGuard) release(final bool) ([]byte, error) {
	opened := final
	for _, lane := range g.lanes {
		if lane.guard.ReleasedRunes() > 0 {
			opened = true
			break
		}
	}
	if !opened {
		return nil, nil
	}
	var out []byte
	n := 0
	for n < len(g.frames) {
		ready := true
		if !final {
			for _, checkpoint := range g.frames[n].ends {
				if g.lanes[checkpoint.lane].guard.ReleasedRunes() < checkpoint.end {
					ready = false
					break
				}
			}
		}
		if !ready {
			break
		}
		if frame := &g.frames[n]; frame.stored {
			wire, err := g.queued.readRange(frame.offset, frame.length)
			if err != nil {
				return nil, err
			}
			out = append(out, wire...)
			frame.stored = false
		} else {
			out = append(out, g.frames[n].wire...)
			g.queuedMemory -= len(g.frames[n].wire)
		}
		g.frames[n].wire = nil
		g.frames[n].ends = nil
		n++
	}
	g.frames = g.frames[n:]
	if len(g.frames) == 0 {
		g.queued.close()
	}
	return out, nil
}

func sseFrameParts(frame []byte) ([]responseText, error) {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(string(frame), "\r\n", "\n"), "\r", "\n"), "\n")
	var data []string
	var unframed []string
	for _, line := range lines {
		if line == "data" {
			data = append(data, "")
		} else if strings.HasPrefix(line, "data:") {
			value := strings.TrimPrefix(line, "data:")
			value = strings.TrimPrefix(value, " ")
			data = append(data, value)
		} else if line != "" && !strings.HasPrefix(line, ":") && !strings.HasPrefix(line, "event:") && !strings.HasPrefix(line, "id:") && !strings.HasPrefix(line, "retry:") {
			unframed = append(unframed, line)
		}
	}
	if len(data) == 0 {
		return []responseText{{lane: "raw", text: strings.Join(unframed, "\n")}}, nil
	}
	payload := strings.Join(data, "\n")
	if strings.TrimSpace(payload) == "" {
		return nil, nil
	}
	if strings.TrimSpace(payload) == "[DONE]" {
		return []responseText{{lane: "response", final: true}}, nil
	}
	parts, err := decodedResponseParts([]byte(payload))
	if err != nil {
		return nil, fmt.Errorf("invalid upstream SSE data: %w", err)
	}
	return parts, nil
}
