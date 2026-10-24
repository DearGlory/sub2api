package poison

import (
	"errors"
	"testing"
)

func TestParseDefaultsWhenNoValues(t *testing.T) {
	snap := parse(nil)
	if snap.Enabled {
		t.Fatal("must default to disabled")
	}
	if snap.Detector == nil || snap.Scope == nil {
		t.Fatal("detector and scope must always be built")
	}
	if snap.RotateMax != 3 {
		t.Fatalf("RotateMax=%d want 3", snap.RotateMax)
	}
	if snap.BlockMsg != DefaultBlockMessage {
		t.Fatalf("BlockMsg=%q want %q", snap.BlockMsg, DefaultBlockMessage)
	}
	if !snap.EgressProbe {
		t.Fatal("EgressProbe must default on")
	}
	if snap.Active() {
		t.Fatal("disabled snapshot must not be active")
	}
}

func TestParseEnabledAndCustomKeywords(t *testing.T) {
	snap := parse(map[string]string{
		SettingEnabled:        "true",
		SettingKeywordsVeto:   `["kedaya"]`,
		SettingKeywordsStrong: "盗取,窃取",
		SettingKeywordsWeak:   "Key",
		SettingThreshold:      "2",
	})
	if !snap.Active() {
		t.Fatal("expected active")
	}
	if res := snap.Detector.Inspect("这个 key 被盗取了"); !res.Poisoned {
		t.Fatalf("threshold 2 must trigger, got %q", res.Reason)
	}
	// veto 仍然单独命中。
	if res := snap.Detector.Inspect("kedaya"); res.Poisoned == false {
		t.Fatal("veto must still trigger")
	}
}

func TestParseThresholdFallbackOnGarbage(t *testing.T) {
	snap := parse(map[string]string{SettingThreshold: "abc"})
	if snap.Detector.threshold != 3 {
		t.Fatalf("threshold=%d want fallback 3", snap.Detector.threshold)
	}
}

func TestParseNegativeRotateMaxClampedToZero(t *testing.T) {
	snap := parse(map[string]string{SettingRotateMax: "-5"})
	if snap.RotateMax != 0 {
		t.Fatalf("RotateMax=%d want 0", snap.RotateMax)
	}
}

func TestParseCommaSeparatedPrefixes(t *testing.T) {
	snap := parse(map[string]string{
		SettingUpstreamPrefixes: "https://kedaya.ai, http://1.2.3.4:8080",
	})
	if !snap.Scope.Match("https://kedaya.ai/v1", true) {
		t.Fatal("comma-separated prefixes must parse")
	}
	if !snap.Scope.Match("http://1.2.3.4:8080", true) {
		t.Fatal("second prefix must parse")
	}
}

func TestStoreReloadHotSwap(t *testing.T) {
	values := map[string]string{SettingEnabled: "false"}
	st := NewStore(func() (map[string]string, error) { return values, nil })
	if st.Current().Active() {
		t.Fatal("must start disabled")
	}

	values[SettingEnabled] = "true"
	if err := st.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !st.Current().Active() {
		t.Fatal("must become active after reload")
	}

	values[SettingEnabled] = "false"
	if err := st.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if st.Current().Active() {
		t.Fatal("must become inactive after reload")
	}
}

func TestStoreReloadKeepsOldSnapshotOnError(t *testing.T) {
	fail := false
	st := NewStore(func() (map[string]string, error) {
		if fail {
			return nil, errors.New("db down")
		}
		return map[string]string{SettingEnabled: "true"}, nil
	})
	if err := st.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !st.Current().Active() {
		t.Fatal("expected active")
	}

	fail = true
	if err := st.Reload(); err == nil {
		t.Fatal("expected error")
	}
	// 配置读取失败不应让功能静默失效。
	if !st.Current().Active() {
		t.Fatal("failed reload must keep previous snapshot")
	}
}

func TestAllSettingsListsEveryKey(t *testing.T) {
	keys := AllSettings()
	want := map[string]bool{
		SettingEnabled:          true,
		SettingUpstreamPrefixes: true,
		SettingKeywordsVeto:     true,
		SettingKeywordsStrong:   true,
		SettingKeywordsWeak:     true,
		SettingThreshold:        true,
		SettingRotateMax:        true,
		SettingEgressProbe:      true,
		SettingBlockMessage:     true,
		SettingHeadBuffer:       true,
	}
	if len(keys) != len(want) {
		t.Fatalf("AllSettings len=%d want %d", len(keys), len(want))
	}
	for _, k := range keys {
		if !want[k] {
			t.Fatalf("unexpected key %q", k)
		}
		if !hasPrefix(k, "poison_guard_") {
			t.Fatalf("key %q must carry the poison_guard_ prefix for clean removal", k)
		}
	}
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
