//go:build unit

package service

import (
	"net/http"
	"testing"
)

// TestGrok401ClassifierRealBodies 用生产实测到的真实 body 形态验证分类器。
// 语料来源：authshape.sh 实打上游（篡改 token / 伪造 token / 空 token）。
func TestGrok401ClassifierRealBodies(t *testing.T) {
	cases := []struct {
		name          string
		body          string
		wantConfirmed bool
		wantMarker    string
	}{
		{
			name:          "real_rejected_token",
			body:          `{"error":"Invalid or expired credentials (auth_kind=bearer, x_xai_token_auth=*** upstream=PermissionDenied, reason=no auth context)"}`,
			wantConfirmed: true,
			wantMarker:    grokAuthUpstreamPermissionDenied,
		},
		{
			name:          "real_no_credential",
			body:          `{"error":"Invalid or expired credentials (auth_kind=other, upstream=Unauthenticated, reason=no auth context)"}`,
			wantConfirmed: true,
			wantMarker:    grokAuthUpstreamUnauthenticated,
		},
		{
			// 生产里 526/533 条 401 记录属于这种：上游有 body，但旧提取器读不到，
			// 落库时变成了占位符。分类器必须仍然认得出这是鉴权失败。
			name:          "credential_marker_without_detail",
			body:          `{"error":"Invalid or expired credentials"}`,
			wantConfirmed: true,
			wantMarker:    grokAuthCredentialMarker,
		},
		{
			name:          "case_insensitive",
			body:          `{"error":"INVALID OR EXPIRED CREDENTIALS (upstream=Unauthenticated)"}`,
			wantConfirmed: true,
			wantMarker:    grokAuthUpstreamUnauthenticated,
		},
		{
			// 空 body：最常见的一类误冷却来源，必须不冷却。
			name:          "empty_body",
			body:          ``,
			wantConfirmed: false,
		},
		{
			// 代理改写了状态码，body 是 429 队列满 —— 不是鉴权失败。
			name:          "gateway_queue_full_rewritten_to_401",
			body:          `{"error":"gateway_queue_full","message":"upstream queue is full, retry later"}`,
			wantConfirmed: false,
		},
		{
			// 容量/限流正文配 401：瞬态，不冷却。
			name:          "capacity_body_on_401",
			body:          `{"error":{"message":"model is at capacity, please retry","type":"server_error"}}`,
			wantConfirmed: false,
		},
		{
			name:          "non_json_html_edge_error",
			body:          `<html><body>502 Bad Gateway</body></html>`,
			wantConfirmed: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyGrok401Body([]byte(tc.body))
			if got.Confirmed != tc.wantConfirmed {
				t.Fatalf("Confirmed = %v, want %v (body=%q)", got.Confirmed, tc.wantConfirmed, tc.body)
			}
			if tc.wantConfirmed && tc.wantMarker != "" && got.Marker != tc.wantMarker {
				t.Fatalf("Marker = %q, want %q", got.Marker, tc.wantMarker)
			}
			if tc.wantConfirmed && got.Detail == "" && tc.body != "" {
				t.Fatalf("expected a non-empty Detail for confirmed case, body=%q", tc.body)
			}
		})
	}
}

// TestGrok401DecisionOnlyFor401 确认非 401 状态码永远不由此路径冷却。
func TestGrok401DecisionOnlyFor401(t *testing.T) {
	body := []byte(`{"error":"Invalid or expired credentials (upstream=Unauthenticated)"}`)
	for _, code := range []int{http.StatusOK, 402, 403, 429, 500, 502} {
		if cooldown, _ := shouldCooldownGrok401(code, body); cooldown {
			t.Fatalf("status %d must not be cooled by the 401 classifier", code)
		}
	}
	if cooldown, class := shouldCooldownGrok401(http.StatusUnauthorized, body); !cooldown || !class.Confirmed {
		t.Fatalf("401 with credential marker must cool; got cooldown=%v class=%+v", cooldown, class)
	}
}

// TestExtractUpstreamErrorMessageStringError 验证提取器能读到 error 为字符串的形态。
func TestExtractUpstreamErrorMessageStringError(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "xai_error_string",
			body: `{"error":"Invalid or expired credentials (auth_kind=bearer, upstream=PermissionDenied, reason=no auth context)"}`,
			want: "Invalid or expired credentials (auth_kind=bearer, upstream=PermissionDenied, reason=no auth context)",
		},
		{
			name: "claude_error_object",
			body: `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`,
			want: "invalid x-api-key",
		},
		{
			name: "chatgpt_detail",
			body: `{"detail":"Unauthorized"}`,
			want: "Unauthorized",
		},
		{
			name: "top_level_message",
			body: `{"message":"boom"}`,
			want: "boom",
		},
		{
			name: "nested_json_inside_error_string",
			body: `{"error":"{\"error\":{\"message\":\"inner boom\"}}"}`,
			want: "inner boom",
		},
		{
			name: "empty_body",
			body: ``,
			want: "",
		},
		{
			// error 是对象但没 message：不能把整段 Raw JSON 当消息。
			name: "error_object_without_message",
			body: `{"error":{"code":500,"type":"server_error"}}`,
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractUpstreamErrorMessage([]byte(tc.body))
			if got != tc.want {
				t.Fatalf("extractUpstreamErrorMessage = %q, want %q", got, tc.want)
			}
		})
	}
}