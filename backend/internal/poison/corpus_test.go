package poison

import (
	"encoding/csv"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

// corpusEntry 是导出的真实生产语料中的一行。
type corpusEntry struct {
	ID    string
	Label string
	Body  string
	Msg   string
}

const (
	corpusPoisonPath = "testdata/corpus_poison.csv"
	corpusNormalPath = "testdata/corpus_normal.csv"
)

func loadCorpus(t *testing.T, path string) []corpusEntry {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("corpus %s unavailable: %v", path, err)
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var out []corpusEntry
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if len(rec) < 3 {
			continue
		}
		e := corpusEntry{ID: rec[0], Label: rec[1], Body: rec[2]}
		if len(rec) > 3 {
			e.Msg = rec[3]
		}
		out = append(out, e)
	}
	return out
}

// extractBodyText 从上游错误 JSON 中抽出正文文本，模拟 writer 看到的字节流。
func extractBodyText(body string) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err == nil && payload.Error.Message != "" {
		return payload.Error.Message
	}
	return body
}

// TestRealCorpusNoLeakage 用真实生产投毒语料逐条验证：
// 判定必须在客户端收到任何正文之前完成，且下发内容中不含任何投毒特征。
func TestRealCorpusNoLeakage(t *testing.T) {
	entries := loadCorpus(t, corpusPoisonPath)
	if len(entries) == 0 {
		t.Skip("empty poison corpus")
	}

	for _, e := range entries {
		text := extractBodyText(e.Body)
		snap := parse(map[string]string{SettingEnabled: "true"})

		// 非流式路径：整体检测后再决定是否写。
		res := snap.Detector.Inspect(text)
		if !res.Poisoned {
			t.Errorf("id=%s undetected real poison body: %q", e.ID, truncate(text, 120))
			continue
		}

		// 流式路径：逐字节喂入，统计在判定前泄漏了多少。
		guard := snap.Detector.NewStreamGuard()
		var leaked strings.Builder
		blockedAt := -1
		for i := 0; i < len(text); i++ {
			out, verdict := guard.Feed(text[i : i+1])
			if verdict == VerdictBlock {
				blockedAt = i
				break
			}
			leaked.WriteString(out)
		}
		if blockedAt < 0 {
			t.Errorf("id=%s stream never blocked: %q", e.ID, truncate(text, 120))
			continue
		}
		assertNoPoisonLeak(t, e.ID, leaked.String())
	}
}

// TestRealCorpusNoFalsePositive 用 4642 条真实正常 400 正文验证零误报。
func TestRealCorpusNoFalsePositive(t *testing.T) {
	entries := loadCorpus(t, corpusNormalPath)
	if len(entries) == 0 {
		t.Skip("empty normal corpus")
	}

	snap := parse(map[string]string{SettingEnabled: "true"})
	falsePositives := 0
	for _, e := range entries {
		text := extractBodyText(e.Body)
		if res := snap.Detector.Inspect(text); res.Poisoned {
			falsePositives++
			if falsePositives <= 10 {
				t.Errorf("id=%s false positive (%s): %q", e.ID, res.Reason, truncate(text, 160))
			}
		}
	}
	t.Logf("checked %d normal bodies, false positives: %d", len(entries), falsePositives)
	if falsePositives > 0 {
		t.Fatalf("%d/%d false positives", falsePositives, len(entries))
	}
}

// assertNoPoisonLeak 断言下发内容里不含任何一个投毒特征词。
func assertNoPoisonLeak(t *testing.T, id, leaked string) {
	t.Helper()
	lower := strings.ToLower(leaked)
	for _, kw := range []string{"kedaya", "盗取", "盗用", "窃取", "被盗", "key已被限流"} {
		if strings.Contains(lower, strings.ToLower(kw)) {
			t.Errorf("id=%s leaked %q; leaked text=%q", id, kw, truncate(leaked, 200))
		}
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
