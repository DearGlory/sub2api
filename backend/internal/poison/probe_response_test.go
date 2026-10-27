package poison

import (
	"errors"
	"strings"
	"testing"
)

const probePoisonText = "您好，这里是  https://kedaya.ai  中转站，您正在使用一个被盗取的key"

func probeSSE(payloads ...string) string {
	var b strings.Builder
	for _, p := range payloads {
		b.WriteString("data: ")
		b.WriteString(p)
		b.WriteString("\n\n")
	}
	return b.String()
}

func probeInspect(t *testing.T, status int, contentType, body string) ProbeInspection {
	t.Helper()
	return InspectProbeResponse(ProbeResponseOptions{
		Detector:     NewDetector(testConfig()),
		HTTPStatus:   status,
		ContentType:  contentType,
		Body:         []byte(body),
		ExpectStream: true,
	})
}

func TestProbeResponsePoisonInStreamIsPoison(t *testing.T) {
	body := probeSSE(
		`{"type":"content_block_delta","index":0,"delta":{"text":"`+probePoisonText+`"}}`,
		`{"type":"message_stop"}`,
	)
	got := probeInspect(t, 200, "text/event-stream", body)
	if got.Verdict != "poison" {
		t.Fatalf("verdict=%q reason=%q, want poison", got.Verdict, got.Reason)
	}
	if len(got.Matched) == 0 {
		t.Fatal("poison verdict must carry matched keywords")
	}
	if got.Reason == "" || strings.Contains(got.Reason, "kedaya.ai  中转站") {
		t.Fatalf("reason must be a short category, got %q", got.Reason)
	}
}

// A clean stream must end with a protocol terminal event; text alone is not enough.
func TestProbeResponseCleanCompleteStreams(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{
			name: "anthropic message_stop",
			body: probeSSE(
				`{"type":"content_block_delta","index":0,"delta":{"text":"hello"}}`,
				`{"type":"message_stop"}`,
			),
		},
		{
			name: "openai responses completed",
			body: probeSSE(
				`{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hello"}`,
				`{"type":"response.completed","response":{"status":"completed"}}`,
			),
		},
		{
			name: "openai chat done",
			body: probeSSE(`{"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}`) + "data: [DONE]\n\n",
		},
		{
			name: "gemini finishReason",
			body: probeSSE(`{"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}`),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := probeInspect(t, 200, "text/event-stream", tc.body)
			if got.Verdict != "clean" {
				t.Fatalf("verdict=%q reason=%q, want clean", got.Verdict, got.Reason)
			}
			if !got.Terminal {
				t.Fatal("clean stream must record a terminal event")
			}
			if got.InspectedRunes == 0 {
				t.Fatal("clean stream must record non-empty inspected text")
			}
		})
	}
}

// The existing handler parsers return success early; a body cut after the text is not clean.
func TestProbeResponseTruncatedStreamIsInconclusive(t *testing.T) {
	body := probeSSE(`{"type":"content_block_delta","index":0,"delta":{"text":"hello"}}`)
	got := probeInspect(t, 200, "text/event-stream", body)
	if got.Verdict != "inconclusive" {
		t.Fatalf("verdict=%q, want inconclusive", got.Verdict)
	}
	if got.Reason != "incomplete_stream" {
		t.Fatalf("reason=%q, want incomplete_stream", got.Reason)
	}
}

func TestProbeResponseEmptyBodyIsInconclusive(t *testing.T) {
	for _, body := range []string{"", "  \n\n"} {
		got := probeInspect(t, 200, "text/event-stream", body)
		if got.Verdict != "inconclusive" || got.Reason != "empty_body" {
			t.Fatalf("body=%q verdict=%q reason=%q, want inconclusive/empty_body", body, got.Verdict, got.Reason)
		}
	}
}

// A poisoned HTTP error body is still a positive hit.
func TestProbeResponseErrorBodyPoisonBeatsStatus(t *testing.T) {
	body := `{"error":{"message":"` + probePoisonText + `"}}`
	got := probeInspect(t, 500, "application/json", body)
	if got.Verdict != "poison" {
		t.Fatalf("verdict=%q reason=%q, want poison", got.Verdict, got.Reason)
	}
	raw := `upstream said ` + probePoisonText
	got = probeInspect(t, 502, "text/html", raw)
	if got.Verdict != "poison" {
		t.Fatalf("raw error body verdict=%q, want poison", got.Verdict)
	}
}

func TestProbeResponsePlainErrorIsInconclusive(t *testing.T) {
	got := probeInspect(t, 500, "application/json", `{"error":{"message":"upstream unavailable"}}`)
	if got.Verdict != "inconclusive" {
		t.Fatalf("verdict=%q, want inconclusive", got.Verdict)
	}
	if got.Reason != "http_status" {
		t.Fatalf("reason=%q, want http_status", got.Reason)
	}
}

func TestProbeResponseParseErrorIsInconclusive(t *testing.T) {
	body := probeSSE(`{"type":"content_block_delta","index":0,"delta":{`)
	got := probeInspect(t, 200, "text/event-stream", body)
	if got.Verdict != "inconclusive" || got.Reason != "parse_error" {
		t.Fatalf("verdict=%q reason=%q, want inconclusive/parse_error", got.Verdict, got.Reason)
	}
}

func TestProbeResponseNilDetectorIsInconclusive(t *testing.T) {
	got := InspectProbeResponse(ProbeResponseOptions{
		HTTPStatus:  200,
		ContentType: "text/event-stream",
		Body:        []byte(probeSSE(`{"type":"message_stop"}`)),
	})
	if got.Verdict != "inconclusive" || got.Reason != "detector_unavailable" {
		t.Fatalf("verdict=%q reason=%q, want inconclusive/detector_unavailable", got.Verdict, got.Reason)
	}
}

func TestProbeResponseNonStreamJSONIsClean(t *testing.T) {
	body := `{"id":"msg_1","type":"message","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn"}`
	got := probeInspect(t, 200, "application/json", body)
	if got.Verdict != "clean" {
		t.Fatalf("verdict=%q reason=%q, want clean", got.Verdict, got.Reason)
	}
}

// A streaming request answered with printable text but no SSE structure proves nothing.
func TestProbeResponseNonStreamBodyIsNotClean(t *testing.T) {
	got := probeInspect(t, 200, "text/html", "<html><body>hello there</body></html>")
	if got.Verdict != "inconclusive" || got.Reason != "not_stream" {
		t.Fatalf("verdict=%q reason=%q, want inconclusive/not_stream", got.Verdict, got.Reason)
	}
}

func TestProbeResponseTruncatedAndReadErrorAreInconclusive(t *testing.T) {
	body := probeSSE(`{"type":"content_block_delta","index":0,"delta":{"text":"hello"}}`)
	got := InspectProbeResponse(ProbeResponseOptions{
		Detector:     NewDetector(testConfig()),
		HTTPStatus:   200,
		ContentType:  "text/event-stream",
		Body:         []byte(body),
		Truncated:    true,
		ExpectStream: true,
	})
	if got.Verdict != "inconclusive" || got.Reason != "truncated_body" {
		t.Fatalf("verdict=%q reason=%q, want inconclusive/truncated_body", got.Verdict, got.Reason)
	}
	got = InspectProbeResponse(ProbeResponseOptions{
		Detector:     NewDetector(testConfig()),
		HTTPStatus:   200,
		ContentType:  "text/event-stream",
		Body:         []byte(body),
		ReadErr:      errors.New("connection reset by peer"),
		ExpectStream: true,
	})
	if got.Verdict != "inconclusive" || got.Reason != "read_error" {
		t.Fatalf("verdict=%q reason=%q, want inconclusive/read_error", got.Verdict, got.Reason)
	}
}

// Keywords split across protocol lanes must not be stitched together.
func TestProbeResponseLanesStaySeparate(t *testing.T) {
	body := probeSSE(
		`{"type":"content_block_delta","index":0,"delta":{"text":"keda"}}`,
		`{"type":"content_block_delta","index":1,"delta":{"text":"ya.ai"}}`,
		`{"type":"message_stop"}`,
	)
	got := probeInspect(t, 200, "text/event-stream", body)
	if got.Verdict == "poison" {
		t.Fatalf("separate lanes must not be concatenated into a keyword: %q", got.Matched)
	}
}
