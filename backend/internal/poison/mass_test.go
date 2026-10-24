package poison

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// TestMassVariantsNoLeak 用真实投毒文案派生大量改写变体，验证判定不依赖固定模板。
//
// 真实的投毒文案不是逐字固定的：模型可能改标点、加空格、把「盗取」换成同义词、
// 去掉域名、插入礼貌用语。这里按这些自由度随机组合，每个变体都要求：判定命中，
// 且开头扣留窗口内零泄漏。
func TestMassVariantsNoLeak(t *testing.T) {
	snap := activeSnapshot()

	openers := []string{
		"您好，这里是",
		"您好这里是",
		"您好, 这里是",
		"你好，这里是",
		"Hi，这里是",
		"您好，",
		"您好！这里是",
	}
	middles := []string{
		" https://kedaya.ai ",
		" https://kedaya.ai",
		"https://kedaya.ai",
		" https://sub.kedaya.xyz ",
		" 某中转站 ",
		" 中转站 ",
		"",
	}
	cores := []string{
		"中转站，您正在使用一个被盗取的key",
		"中转站，您正在使用一个被盗用的密钥",
		"中转站，此key已被限流，因为此key已被盗取",
		"中转站，您的密钥已被窃取",
		"中转站，该key已被偷取",
		"中转站，当前密钥被盗用",
	}
	suffixes := []string{
		"",
		"，请更换",
		"。",
		"，请联系管理员",
	}

	rng := rand.New(rand.NewSource(20261024))
	var total, detected int
	var maxLeak int

	for i := 0; i < 30000; i++ {
		text := openers[rng.Intn(len(openers))] +
			middles[rng.Intn(len(middles))] +
			cores[rng.Intn(len(cores))] +
			suffixes[rng.Intn(len(suffixes))]
		total++

		// 非流式：整体必须命中
		if !snap.Detector.Inspect(text).Poisoned {
			t.Fatalf("variant %d undetected: %q", i, text)
		}

		// 流式：随机分片逐段喂入，统计泄漏
		guard := snap.Detector.NewStreamGuard()
		var leaked strings.Builder
		hit := false
		pos := 0
		for pos < len(text) {
			n := 1 + rng.Intn(9)
			if pos+n > len(text) {
				n = len(text) - pos
			}
			out, v := guard.Feed(text[pos : pos+n])
			pos += n
			if v == VerdictBlock {
				hit = true
				break
			}
			leaked.WriteString(out)
		}
		if !hit {
			if out, v := guard.Flush(); v == VerdictBlock {
				hit = true
			} else {
				leaked.WriteString(out)
			}
		}
		if !hit {
			t.Fatalf("variant %d stream never blocked: %q", i, text)
		}
		detected++

		got := leaked.String()
		assertNoPoisonLeak(t, fmt.Sprintf("v%d", i), got)
		if n := len([]rune(got)); n > maxLeak {
			maxLeak = n
		}
	}

	t.Logf("variants=%d detected=%d maxLeakedRunes=%d", total, detected, maxLeak)
	if maxLeak != 0 {
		t.Fatalf("expected zero leakage, worst case %d runes", maxLeak)
	}
}

// TestMassCleanNoFalsePositive 用大量正常文本变体验证不误拦。
func TestMassCleanNoFalsePositive(t *testing.T) {
	snap := activeSnapshot()

	// 正常业务里常见、容易踩到弱关键词的正经文本。
	cleans := []string{
		"您好，请问有什么可以帮您？",
		"这里是您要的代码示例，请查收。",
		"您好，这里是正常的技术说明文档内容。",
		"这段代码演示了如何校验 key 的格式。",
		"您的密钥需要妥善保管，不要泄露给他人。",
		"请检查 API key 是否已正确配置在环境变量中。",
		"您好，这里是项目说明：使用前请先执行 npm install。",
		"函数 calcSum 接收两个整数并返回它们的和。",
		"数据库连接失败，请检查 host 与 port 配置。",
		"如果您需要重置密码，请前往设置页面操作。",
		"这段 JSON 的 message 字段包含错误详情。",
		"您好，这里是服务端返回的 400 错误说明：参数 missing_field 缺失。",
	}

	for _, text := range cleans {
		if res := snap.Detector.Inspect(text); res.Poisoned {
			t.Errorf("false positive on clean text (%s): %q", res.Reason, text)
		}
		// 流式也不应拦
		guard := snap.Detector.NewStreamGuard()
		var got strings.Builder
		pos := 0
		for pos < len(text) {
			out, v := guard.Feed(text[pos : pos+1])
			pos++
			if v == VerdictBlock {
				t.Fatalf("false block on clean text: %q", text)
			}
			got.WriteString(out)
		}
		out, v := guard.Flush()
		if v == VerdictBlock {
			t.Fatalf("false block on flush: %q", text)
		}
		got.WriteString(out)
		if got.String() != text {
			t.Errorf("clean text altered:\n got=%q\nwant=%q", got.String(), text)
		}
	}
}

// TestVetoAloneBlocks 单独出现 kedaya 或 kedaya.ai 就必须判定，不依赖阈值。
func TestVetoAloneBlocks(t *testing.T) {
	snap := activeSnapshot()
	for _, text := range []string{
		"请访问 https://kedaya.ai 获取更多信息",
		"see kedaya for details",
		"KEDAYA.AI",
		"Kedaya",
	} {
		if res := snap.Detector.Inspect(text); !res.Poisoned {
			t.Errorf("veto word must block on its own: %q", text)
		}
	}
}
