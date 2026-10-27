package poison

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// ProbeResponseOptions describes one fully-read upstream response belonging to a
// poison probe. Body must be the complete raw bytes the upstream sent; the probe
// must not hand over a partially consumed reader.
type ProbeResponseOptions struct {
	Detector    *Detector
	HTTPStatus  int
	ContentType string
	Body        []byte
	// ReadErr is the terminal read error, if any. A short response is not proof.
	ReadErr error
	// Truncated reports that Body was cut at the probe's size cap.
	Truncated bool
	// ExpectStream reports that the request asked for a streamed response.
	ExpectStream bool
}

// ProbeInspection is the read-only verdict for one probe response.
//
// Verdict is poison (definite keyword hit), clean (complete, non-empty, provable
// response with no hit) or inconclusive (anything that cannot prove either way).
// Reason is a short category and never contains upstream text or credentials.
type ProbeInspection struct {
	Verdict        string
	Reason         string
	Matched        []string
	Lane           string
	InspectedRunes int
	Terminal       bool
}

type probeLane struct {
	guard *StreamGuard
}

type probeScan struct {
	detector  *Detector
	lanes     map[string]*probeLane
	hit       bool
	reason    string
	matched   []string
	lane      string
	inspected int
	terminal  bool
	failed    bool
}

// InspectProbeResponse judges a complete upstream body with the same lane parser
// the gateway guard uses (sseFrameParts / decodedResponseParts / StreamGuard).
//
// It is deliberately read-only: it never creates a responseGuard, because that
// type owns a wire spool (which spills to a temp file), a client writer and the
// Dispatch path. A probe must not filter, spool or dispatch anything; it only
// reads bytes that were already received.
//
// Keywords are checked before any status/shape rule so that an explicit hit
// always wins; nothing that fails a completeness rule can ever be reported clean.
func InspectProbeResponse(opts ProbeResponseOptions) ProbeInspection {
	if opts.Detector == nil {
		return ProbeInspection{Verdict: "inconclusive", Reason: "detector_unavailable"}
	}
	if len(strings.TrimSpace(string(opts.Body))) == 0 {
		return ProbeInspection{Verdict: "inconclusive", Reason: "empty_body"}
	}

	mode := probeResponseMode(opts.ContentType)
	if mode != responseSSE && probeLooksLikeSSE(opts.Body) {
		mode = responseSSE
	}

	scan := &probeScan{detector: opts.Detector, lanes: make(map[string]*probeLane)}
	var parseErr error
	if mode == responseSSE {
		parseErr = scan.feedSSE(opts.Body)
	} else {
		parseErr = scan.feedWhole(opts.Body)
	}
	scan.flush()

	if scan.hit {
		return ProbeInspection{
			Verdict:        "poison",
			Reason:         scan.reason,
			Matched:        append([]string(nil), scan.matched...),
			Lane:           scan.lane,
			InspectedRunes: scan.inspected,
			Terminal:       scan.terminal,
		}
	}

	inconclusive := func(reason string) ProbeInspection {
		return ProbeInspection{
			Verdict:        "inconclusive",
			Reason:         reason,
			InspectedRunes: scan.inspected,
			Terminal:       scan.terminal,
		}
	}

	switch {
	case opts.ReadErr != nil:
		return inconclusive("read_error")
	case opts.Truncated:
		return inconclusive("truncated_body")
	case opts.HTTPStatus < 200 || opts.HTTPStatus >= 300:
		return inconclusive("http_status")
	case opts.ExpectStream && mode == responseRaw:
		// A streaming request answered with unstructured bytes proves nothing;
		// finalized JSON is still a complete non-stream body.
		return inconclusive("not_stream")
	case scan.failed:
		return inconclusive("upstream_failure")
	case parseErr != nil:
		return inconclusive("parse_error")
	case scan.inspected == 0:
		return inconclusive("empty_body")
	case (mode == responseSSE || mode == responseJSON) && !scan.terminal:
		return inconclusive("incomplete_stream")
	}

	return ProbeInspection{
		Verdict:        "clean",
		Reason:         "complete_response",
		InspectedRunes: scan.inspected,
		Terminal:       scan.terminal,
	}
}

// probeResponseMode mirrors newResponseGuard's content-type classification.
func probeResponseMode(contentType string) responseMode {
	ct := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch {
	case ct == "text/event-stream":
		return responseSSE
	case ct == "application/json" || strings.HasSuffix(ct, "+json"):
		return responseJSON
	default:
		return responseRaw
	}
}

func probeLooksLikeSSE(body []byte) bool {
	for _, line := range probeLines(string(body)) {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, ":") {
			continue
		}
		return strings.HasPrefix(trimmed, "data:") || strings.HasPrefix(trimmed, "event:")
	}
	return false
}

func probeLines(text string) []string {
	return strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n")
}

// feedWhole handles non-SSE bodies. Decoded JSON is split into lanes; anything
// else is treated as one raw lane so keywords in HTML/plain error pages still hit.
func (s *probeScan) feedWhole(body []byte) error {
	var parseErr error
	parts, err := decodedResponseParts(body)
	if err != nil {
		parseErr = err
		parts = []responseText{{lane: "raw", text: string(body)}}
	}
	s.feed(parts)
	if probeJSONTerminal(body) {
		s.terminal = true
	}
	var envelope map[string]any
	if json.Unmarshal(body, &envelope) == nil && probePayloadFailed(envelope) {
		s.failed = true
	}
	return parseErr
}

// feedSSE walks complete SSE frames and reports the first frame that cannot be
// parsed, without giving up on the frames that follow it.
func (s *probeScan) feedSSE(body []byte) error {
	var parseErr error
	for _, frame := range probeSSEFrames(body) {
		for _, line := range probeLines(string(frame)) {
			value, ok := probeDataValue(line)
			if !ok {
				continue
			}
			var envelope map[string]any
			if json.Unmarshal([]byte(value), &envelope) == nil && probePayloadFailed(envelope) {
				s.failed = true
			}
		}
		if probeFrameTerminal(frame) {
			s.terminal = true
		}
		parts, err := sseFrameParts(frame)
		if err != nil {
			if parseErr == nil {
				parseErr = err
			}
			continue
		}
		s.feed(parts)
		if s.hit {
			return parseErr
		}
	}
	return parseErr
}

// feed applies parts to per-lane guards, exactly like responseGuard.inspectParts,
// so unrelated lanes can never be concatenated into a keyword.
func (s *probeScan) feed(parts []responseText) {
	for _, part := range parts {
		if s.hit {
			return
		}
		if part.final {
			for key, lane := range s.lanes {
				if key == part.lane || strings.HasPrefix(key, part.lane+"/") {
					if _, verdict := lane.guard.Flush(); verdict == VerdictBlock {
						s.record(lane, key)
						return
					}
				}
			}
			continue
		}
		if part.text == "" {
			continue
		}
		lane := s.lanes[part.lane]
		if lane == nil {
			lane = &probeLane{guard: s.detectorGuard()}
			s.lanes[part.lane] = lane
		}
		s.inspected += utf8.RuneCountInString(part.text)
		if _, verdict := lane.guard.Feed(part.text); verdict == VerdictBlock {
			s.record(lane, part.lane)
			return
		}
	}
}

func (s *probeScan) detectorGuard() *StreamGuard {
	return s.detector.NewStreamGuard()
}

// flush releases every lane tail so a keyword ending at the body boundary is still judged.
func (s *probeScan) flush() {
	if s.hit {
		return
	}
	for key, lane := range s.lanes {
		if _, verdict := lane.guard.Flush(); verdict == VerdictBlock {
			s.record(lane, key)
			return
		}
	}
}

func (s *probeScan) record(lane *probeLane, key string) {
	s.hit = true
	s.lane = key
	s.matched = append(s.matched, lane.guard.matched...)
	// StreamGuard.Reason is already a category: "veto:<word>" or "threshold:n/m".
	s.reason = lane.guard.Reason()
	if s.reason == "" {
		s.reason = "poison"
	}
}

// probeSSEFrames splits the body on blank lines, accepting LF, CRLF and bare CR,
// and keeps a trailing frame that was not followed by a blank line.
func probeSSEFrames(body []byte) [][]byte {
	var frames [][]byte
	start, i, lineStart := 0, 0, 0
	for i < len(body) {
		if body[i] != '\n' && body[i] != '\r' {
			i++
			continue
		}
		end := i + 1
		if body[i] == '\r' && end < len(body) && body[end] == '\n' {
			end++
		}
		blank := i == lineStart
		i, lineStart = end, end
		if blank {
			frames = append(frames, body[start:end])
			start = end
		}
	}
	if start < len(body) {
		frames = append(frames, body[start:])
	}
	return frames
}

func probeFrameTerminal(frame []byte) bool {
	for _, line := range probeLines(string(frame)) {
		value, ok := probeDataValue(line)
		if !ok {
			continue
		}
		if strings.TrimSpace(value) == "[DONE]" {
			return true
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(value), &payload); err != nil {
			continue
		}
		if probePayloadTerminal(payload) {
			return true
		}
	}
	return false
}

func probeDataValue(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "data" {
		return "", true
	}
	if !strings.HasPrefix(trimmed, "data:") {
		return "", false
	}
	return strings.TrimPrefix(strings.TrimPrefix(trimmed, "data:"), " "), true
}

// probePayloadTerminal reports a protocol-level end for the three production
// apikey channels plus the shared OpenAI-compatible shapes.
func probePayloadTerminal(payload map[string]any) bool {
	if typ, ok := payload["type"].(string); ok {
		switch typ {
		case "message_stop", "response.completed", "response.done":
			return true
		}
	}
	if status, ok := payload["status"].(string); ok && status == "completed" {
		return true
	}
	if stop, ok := payload["stop_reason"].(string); ok && stop != "" {
		return true
	}
	if choices, ok := payload["choices"].([]any); ok {
		for _, item := range choices {
			choice, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if reason, ok := choice["finish_reason"].(string); ok && reason != "" {
				return true
			}
		}
	}
	if candidates, ok := payload["candidates"].([]any); ok {
		for _, item := range candidates {
			candidate, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if reason, ok := candidate["finishReason"].(string); ok && reason != "" {
				return true
			}
		}
	}
	if response, ok := payload["response"].(map[string]any); ok {
		return probePayloadTerminal(response)
	}
	return false
}

func probePayloadFailed(payload map[string]any) bool {
	if e, ok := payload["error"]; ok && e != nil {
		return true
	}
	if text, ok := payload["error_description"].(string); ok && strings.TrimSpace(text) != "" {
		return true
	}
	if typ, ok := payload["type"].(string); ok {
		switch typ {
		case "error", "response.failed", "response.incomplete", "response.cancelled", "response.canceled":
			return true
		}
	}
	if status, ok := payload["status"].(string); ok {
		switch status {
		case "failed", "incomplete", "cancelled", "canceled":
			return true
		}
	}
	if nested, ok := payload["response"].(map[string]any); ok {
		return probePayloadFailed(nested)
	}
	return false
}

func probeJSONTerminal(body []byte) bool {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	return probePayloadTerminal(payload)
}
