package poison

import "testing"

func TestProbeResponseFailedEnvelopesNeverClean(t *testing.T) {
	for name, body := range map[string]string{
		"failed_after_text":      probeSSE(`{"type":"response.output_text.delta","delta":"hello"}`, `{"type":"response.failed","response":{"status":"failed","error":{"message":"ordinary unavailable"}}}`, `{"type":"response.completed"}`),
		"error_after_terminal":   probeSSE(`{"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}`, `{"error":{"message":"quota exhausted"}}`, "[DONE]"),
		"nonterminal_json":       `{"status":"in_progress","output":[{"type":"message","content":[{"type":"output_text","text":"partial"}]}]}`,
		"json_error_description": `{"status":"completed","error_description":"service unavailable"}`,
	} {
		t.Run(name, func(t *testing.T) {
			ct := "text/event-stream"
			if body[0] == '{' {
				ct = "application/json"
			}
			got := probeInspect(t, 200, ct, body)
			if got.Verdict != "inconclusive" {
				t.Fatalf("failed/unfinished envelope reported %s (%s)", got.Verdict, got.Reason)
			}
		})
	}
}
