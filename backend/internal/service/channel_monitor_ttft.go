package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// probeFirstTokenTimeout bounds the extra streaming probe. A probe that has not
// produced a first token by then is reported as unmeasured rather than holding
// the whole check cycle open.
const probeFirstTokenTimeout = 20 * time.Second

// probeFirstTokenMaxTokens keeps the streaming probe to a couple of tokens: the
// measurement is the first delta, so the rest of the completion is wasted cost.
const probeFirstTokenMaxTokens = 8

// probeFirstTokenPattern mirrors the challenge the regular check already sends,
// so the streaming probe exercises the same upstream path and prompt shape.
const probeFirstTokenPattern = "Reply with only the digit 1, nothing else."

// ProbeUserAgent marks a request as a channel-monitor probe.
//
// Probes are real requests through this gateway, so the gateway records them in
// usage_logs like any customer traffic. Channel monitor V2 aggregates usage_logs,
// which would make a probed group look like it has organic traffic and the status
// page would stop falling back to active probing. The marker lets the V2
// aggregation filter probes out at the source.
const ProbeUserAgent = "GloryCode-ChannelMonitor-Probe/1.0"

// measureFirstToken sends one short streaming request and returns the time to the
// first content or reasoning delta.
//
// The regular check reads the whole non-streamed body, so its latency is
// end-to-end and overstates first-token latency. This probe exists only to get a
// real TTFT sample for the channel status page.
//
// A nil result with a non-nil error means the probe could not measure a first
// token: the caller stores NULL rather than substituting end-to-end latency.
// Providers that reject streaming simply yield an error, and the page shows '-'.
func measureFirstToken(ctx context.Context, provider, endpoint, apiKey, model string, opts *CheckOptions) (*int, error) {
	requestedAPIMode := checkAPIMode(opts)
	if err := validateAPIMode(provider, requestedAPIMode); err != nil {
		return nil, err
	}
	adapter, apiMode, ok := providerAdapterFor(provider, requestedAPIMode)
	if !ok {
		return nil, fmt.Errorf("unsupported provider %q", provider)
	}
	body, err := buildStreamingProbeBody(adapter, provider, apiMode, model)
	if err != nil {
		return nil, err
	}
	headers := mergeHeaders(adapter.buildHeaders(apiKey), opts)
	full := joinURL(endpoint, monitorRequestPath(provider, endpoint, adapter, model))

	probeCtx, cancel := context.WithTimeout(ctx, probeFirstTokenTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(probeCtx, http.MethodPost, full, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build probe request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", ProbeUserAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	start := time.Now()
	resp, err := monitorHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do probe request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("probe HTTP %d", resp.StatusCode)
	}

	ttft, err := readFirstTokenDelta(resp.Body, start)
	if err != nil {
		return nil, err
	}
	if ttft == nil {
		return nil, fmt.Errorf("probe stream produced no first token")
	}
	ms := int(*ttft / time.Millisecond)
	return &ms, nil
}

// buildStreamingProbeBody serialises the default probe body and forces a stream.
// It works off the adapter's own body so provider-specific fields (max output
// tokens, reasoning options) stay intact.
func buildStreamingProbeBody(adapter providerAdapter, provider, apiMode, model string) ([]byte, error) {
	defaultBody, err := adapter.buildBody(model, probeFirstTokenPattern)
	if err != nil {
		return nil, fmt.Errorf("marshal probe body: %w", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(defaultBody, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal probe body: %w", err)
	}
	raw["stream"] = true
	// Keep the probe cheap on both wire shapes.
	if _, ok := raw["max_tokens"]; ok {
		raw["max_tokens"] = probeFirstTokenMaxTokens
	}
	if _, ok := raw["max_output_tokens"]; ok {
		raw["max_output_tokens"] = probeFirstTokenMaxTokens
	}
	body, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("marshal streaming probe body: %w", err)
	}
	return body, nil
}

// readFirstTokenDelta consumes an SSE body only until the first content or
// reasoning delta and returns its elapsed time. Reading stops there, so the probe
// costs a couple of tokens instead of a full completion.
func readFirstTokenDelta(body io.Reader, start time.Time) (*time.Duration, error) {
	reader := bufio.NewReaderSize(body, 4096)
	for {
		line, err := reader.ReadString('\n')
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			if elapsed, ok := firstTokenFromSSELine(trimmed, start); ok {
				return &elapsed, nil
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil, nil
			}
			return nil, fmt.Errorf("read probe stream: %w", err)
		}
	}
}

// firstTokenFromSSELine reports whether one SSE line carries the first token.
// Reasoning deltas count: on thinking models they are the first emitted token,
// which is what a user waits for.
//
// Three wire shapes are supported because the probe runs against whichever API
// mode the monitor is configured for, and a provider fronted by this gateway does
// not always answer in the shape its endpoint name suggests:
//   - chat_completions: choices[].delta.{content,reasoning_content,reasoning}
//   - responses:        {"type":"response.output_text.delta"|..., "delta":"..."}
//   - anthropic native: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
//
// delta is decoded as raw JSON, not as a string. Anthropic sends it as an object
// while the OpenAI shapes send a string, and a struct that pins it to one type
// fails to unmarshal the other completely — losing even the choices branch — so
// the whole stream reads as "no first token" and the page shows "-" forever.
func firstTokenFromSSELine(line string, start time.Time) (time.Duration, bool) {
	payload, ok := strings.CutPrefix(line, "data:")
	if !ok {
		return 0, false
	}
	payload = strings.TrimSpace(payload)
	if payload == "" || payload == "[DONE]" {
		return 0, false
	}
	var chunk struct {
		// chat_completions
		Choices []struct {
			Delta struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
			} `json:"delta"`
		} `json:"choices"`
		// responses: delta is a string.
		// anthropic: delta is an object; content_block is an object.
		Type         string          `json:"type"`
		Delta        json.RawMessage `json:"delta"`
		ContentBlock json.RawMessage `json:"content_block"`
	}
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		return 0, false
	}
	for _, choice := range chunk.Choices {
		if choice.Delta.Content != "" || choice.Delta.ReasoningContent != "" || choice.Delta.Reasoning != "" {
			return time.Since(start), true
		}
	}
	switch chunk.Type {
	case "response.output_text.delta",
		"response.reasoning_text.delta",
		"response.reasoning_summary_text.delta":
		if deltaCarriesToken(chunk.Delta) {
			return time.Since(start), true
		}
	case "content_block_delta":
		// Every delta kind counts: text_delta, thinking_delta, input_json_delta
		// (tool use) all mean the upstream started producing output.
		if deltaCarriesToken(chunk.Delta) {
			return time.Since(start), true
		}
	case "content_block_start":
		// Often an empty placeholder block; only counts once it holds text.
		if deltaCarriesToken(chunk.ContentBlock) {
			return time.Since(start), true
		}
	}
	return 0, false
}

// deltaCarriesToken reports whether a delta payload holds any emitted output.
// It accepts both wire shapes: a bare JSON string, or an object. Anthropic names
// the payload by delta kind — "text" for text_delta, "thinking" for
// thinking_delta, "partial_json" for input_json_delta — and an object with none
// of those is an empty placeholder, not a token.
func deltaCarriesToken(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text != ""
	}
	var obj struct {
		Text        string `json:"text"`
		Content     string `json:"content"`
		Thinking    string `json:"thinking"`
		PartialJSON string `json:"partial_json"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return false
	}
	return obj.Text != "" || obj.Content != "" || obj.Thinking != "" || obj.PartialJSON != ""
}
