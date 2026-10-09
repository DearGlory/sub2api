package service

import (
	"fmt"
	"strings"

	pluginv1 "github.com/Wei-Shaw/sub2api/pkg/pluginapi/v1"
	"golang.org/x/mod/semver"
)

type PluginHostInfo struct {
	Version   string
	BuildType string
}

func EvaluatePluginCompatibility(manifest PluginManifest, host PluginHostInfo) PluginCompatibility {
	result := PluginCompatibility{
		CurrentSub2API:     host.Version,
		RequiredSub2API:    manifest.Requires.Sub2API,
		RecommendedSub2API: manifest.Requires.RecommendedSub2APIVersion,
		PluginProtocol:     manifest.Requires.PluginProtocol,
		TransportAPI:       manifest.Requires.TransportAPI,
		UIBridge:           manifest.Requires.UIBridge,
	}
	if manifest.Requires.PluginProtocol != pluginv1.ProtocolVersion ||
		manifest.Requires.TransportAPI != pluginv1.TransportAPIVersion ||
		manifest.Requires.UIBridge != pluginv1.UIBridgeVersion {
		result.Status = "incompatible"
		result.Message = "插件协议版本与当前 Sub2API 不兼容"
		return result
	}
	if !matchesSemverRange(host.Version, manifest.Requires.Sub2API) {
		result.Status = "incompatible"
		result.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", host.Version, manifest.Requires.Sub2API)
		return result
	}
	result.Compatible = true
	for _, tested := range manifest.Requires.TestedSub2APIVersions {
		if normalizeSemver(tested) == normalizeSemver(host.Version) {
			result.Tested = true
			break
		}
	}
	if result.Tested {
		result.Status = "compatible"
		result.Message = "当前 Sub2API 版本已由插件声明测试"
	} else {
		result.Status = "untested"
		result.Message = "版本范围兼容，但插件未声明已测试当前 Sub2API 版本"
	}
	return result
}

// vendorVersionSuffix labels a GloryCode build on top of an upstream base
// version. The full scheme is <upstream base>-GloryCode-<our own revision>,
// e.g. "0.2.15-GloryCode-0.0.1" is upstream 0.2.15 plus our patches, at our
// own release 0.0.1.
const vendorVersionSuffix = "-GloryCode"

// normalizeSemver converts a version string into x/mod/semver form.
//
// Everything from the vendor suffix onward is stripped before comparison. In
// semver the first hyphen starts a PRERELEASE, and a prerelease sorts BELOW its
// plain release: x/mod/semver reports
// Compare("v0.2.15-GloryCode-0.0.1", "v0.2.15") == -1. Left in place, a plugin
// requiring ">=0.2.15" would be judged incompatible with a build that is
// 0.2.15 plus extra patches — the suffix is a vendor label on the upstream base
// version, not a statement that this build is older or unfinished.
//
// Stripping from the vendor suffix (not from the first hyphen) keeps the whole
// vendor label — including our own revision segment — out of the comparison,
// so both "0.2.15-GloryCode" and "0.2.15-GloryCode-0.0.1" compare as 0.2.15.
func normalizeSemver(version string) string {
	v := strings.TrimSpace(version)
	if v == "" {
		return ""
	}
	// Case-insensitive match; version strings are ASCII, so the byte offset from
	// the folded copy is valid for the original.
	if idx := strings.Index(strings.ToLower(v), strings.ToLower(vendorVersionSuffix)); idx != -1 {
		v = strings.TrimSpace(v[:idx])
	}
	if v == "" {
		return ""
	}
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	if !semver.IsValid(v) {
		return ""
	}
	return v
}

func matchesSemverRange(version, expression string) bool {
	v := normalizeSemver(version)
	if v == "" {
		return false
	}
	tokens := strings.Fields(strings.ReplaceAll(expression, ",", " "))
	if len(tokens) == 0 {
		return false
	}
	for _, token := range tokens {
		op := "="
		raw := token
		for _, candidate := range []string{">=", "<=", ">", "<", "="} {
			if strings.HasPrefix(token, candidate) {
				op = candidate
				raw = strings.TrimSpace(strings.TrimPrefix(token, candidate))
				break
			}
		}
		bound := normalizeSemver(raw)
		if bound == "" {
			return false
		}
		comparison := semver.Compare(v, bound)
		matched := map[string]bool{
			">=": comparison >= 0,
			"<=": comparison <= 0,
			">":  comparison > 0,
			"<":  comparison < 0,
			"=":  comparison == 0,
		}[op]
		if !matched {
			return false
		}
	}
	return true
}
