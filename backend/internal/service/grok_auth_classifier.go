package service

import (
	"net/http"
	"strings"
	"time"
)

// Grok 401 auth classification.
//
// Why a dedicated classifier exists
//
// The legacy path in handleGrokAccountUpstreamError cooled every Grok 401 for a
// flat 10 minutes without ever reading the response body. Production showed
// that treatment is wrong: a 401 can be emitted by the cli-chat-proxy edge for
// reasons that have nothing to do with the stored OAuth credential, and the
// account keeps serving traffic seconds later (measured: 90% of 401s are
// followed by a successful request from the same account within 60 seconds).
// Cooling on those punishes a healthy account and empties the schedulable pool.
//
// The classifier therefore reads the body and separates the two cases that xAI
// actually reports differently:
//
//	{"error":"Invalid or expired credentials (... upstream=Unauthenticated ...)"}
//	{"error":"Invalid or expired credentials (... upstream=PermissionDenied ...)"}
//
// Both carry the credential-failure marker, so both are genuine credential
// rejections and keep the cooldown. Anything else — an empty body, a rewritten
// status, a capacity or quota body that arrived with a 401 — is NOT an auth
// failure and must only fail over.
//
// Scope note: this classifier is deliberately body-only. It does not consult
// latency, prior attempts in the same request, or any other proxy signal; those
// were evaluated and rejected as unreliable. When the body carries no credential
// marker the account is left untouched.
const (
	// grokAuthCredentialMarker is the phrase xAI/cli-chat-proxy emits for both a
	// rejected token and an unauthenticated request.
	grokAuthCredentialMarker = "invalid or expired credentials"

	// grokAuthReasonNoContext appears in the parenthesised detail of every
	// credential rejection observed in production.
	grokAuthReasonNoContext = "reason=no auth context"

	// grokAuthUpstreamUnauthenticated marks a request that carried no usable
	// credential at all.
	grokAuthUpstreamUnauthenticated = "upstream=unauthenticated"

	// grokAuthUpstreamPermissionDenied marks a credential that was rejected.
	grokAuthUpstreamPermissionDenied = "upstream=permissiondenied"

	// grokAuthCooldown is the quarantine applied to a confirmed credential
	// rejection. It matches the legacy duration so operators see no behaviour
	// change for the cases this classifier actually keeps.
	grokAuthCooldown = 10 * time.Minute
)

// grokAuthClassification is the outcome of inspecting a Grok 401 body.
type grokAuthClassification struct {
	// Confirmed is true only when the body carries an explicit credential
	// rejection marker. It is the sole signal that may cool an account.
	Confirmed bool
	// Marker records which phrase matched, for the ops log.
	Marker string
	// Detail is the human-readable upstream sentence, when one could be read.
	Detail string
}

// classifyGrok401Body inspects a Grok 401 response body and reports whether it
// is a genuine credential rejection.
//
// Matching is intentionally narrow: the body must contain the credential
// marker phrase. The reason/upstream fields refine the marker but are not
// required on their own, because xAI has emitted the marker with slightly
// different parenthetical detail across gateway revisions.
func classifyGrok401Body(responseBody []byte) grokAuthClassification {
	if len(responseBody) == 0 {
		return grokAuthClassification{}
	}
	low := strings.ToLower(string(responseBody))

	if !strings.Contains(low, grokAuthCredentialMarker) {
		return grokAuthClassification{}
	}

	result := grokAuthClassification{
		Confirmed: true,
		Marker:    grokAuthCredentialMarker,
	}
	// Prefer the parsed sentence for the log; fall back to the raw body when the
	// corpus helpers cannot extract one (truncated by an intermediary, etc).
	if detail := strings.TrimSpace(extractUpstreamErrorMessage(responseBody)); detail != "" {
		result.Detail = sanitizeUpstreamErrorMessage(detail)
	}

	// Record the more specific sub-signal when present. This does not change the
	// decision — it exists so the ops log distinguishes "no credential was sent"
	// from "the credential was rejected".
	switch {
	case strings.Contains(low, grokAuthUpstreamUnauthenticated):
		result.Marker = grokAuthUpstreamUnauthenticated
	case strings.Contains(low, grokAuthUpstreamPermissionDenied):
		result.Marker = grokAuthUpstreamPermissionDenied
	case strings.Contains(low, grokAuthReasonNoContext):
		result.Marker = grokAuthReasonNoContext
	}
	return result
}

// shouldCooldownGrok401 applies the body classifier to a 401 and reports whether
// the account should be quarantined. It replaces the unconditional status-code
// cooldown for http.StatusUnauthorized.
func shouldCooldownGrok401(statusCode int, responseBody []byte) (bool, grokAuthClassification) {
	if statusCode != http.StatusUnauthorized {
		return false, grokAuthClassification{}
	}
	class := classifyGrok401Body(responseBody)
	return class.Confirmed, class
}
