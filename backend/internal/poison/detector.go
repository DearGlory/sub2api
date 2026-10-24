// Package poison 检测上游返回内容中是否被注入了盗用提示文案。
//
// 设计要点：
//   - 判定只依赖关键词，抗模型改写；veto 级关键词单独命中即判定。
//   - 流式采用「按字符回退保留」而非「按 SSE 区块计数保留」：关键词长度以字符计，
//     与区块划分无关，因此回退 maxKeywordLen-1 个字符即可保证任何关键词都不会
//     先于判定被写给客户端。
//   - 全部状态在内存中，无外部依赖，便于整体删除。
package poison

import (
	"strings"
	"unicode/utf8"
)

// Level 是关键词在判定中的权重级别。
type Level int

// LevelWeak 只作陪衬，不单独构成判定；LevelStrong 计入阈值；LevelVeto 单独命中即判定。
const (
	LevelWeak Level = iota
	LevelStrong
	LevelVeto
)

// Verdict 是一次喂入后的处置结论。
type Verdict int

const (
	// VerdictPass 未命中，允许放行可安全释放的部分。
	VerdictPass Verdict = iota
	// VerdictBlock 判定为投毒，调用方必须丢弃全部未释放内容并中止响应。
	VerdictBlock
)

// Result 是非流式整体检测的结论。
type Result struct {
	Poisoned bool
	// Reason 命中原因，用于日志与运维排查：veto 词或累计词数与阈值。
	Reason string
	// Matched 命中的关键词原文，按配置顺序。
	Matched []string
}

type word struct {
	text  string
	lower string
	level Level
}

// Detector 是无状态的判定器，可被并发复用。流式状态由 NewStreamGuard 持有。
type Detector struct {
	words    []word
	vetoIdx  []int
	maxRunes int
	// threshold 是 strong+weak 去重后触发判定的词数下限。
	threshold int
	// headRunes 是流式响应开头必须扣留、不写给客户端的字符数。
	//
	// 投毒文案固定在开头，扣住开头意味着判定可以在任何字节发出之前完成：
	// 一旦命中，响应头尚未提交，仍能改成完整的错误状态码，客户端看不到任何
	// 投毒内容。超过该窗口后不再能回滚状态码，只能靠 holdback 保证关键词
	// 本身不泄露。
	headRunes int
}

// Config 是构造 Detector 的输入。
type Config struct {
	// Veto 单独命中即判定，例如 kedaya / kedaya.ai。
	Veto []string
	// Strong 计入阈值，例如 盗取 / 窃取。
	Strong []string
	// Weak 只作陪衬，例如 Key / 密钥。
	Weak []string
	// Threshold 为 strong+weak 去重命中数达到即判定；小于 1 时取 3。
	Threshold int
	// HeadBufferRunes 是开头扣留字符数；小于 1 时取默认值。
	HeadBufferRunes int
}

// NewDetector 构造判定器。空关键词会被忽略，同一词出现在多级时以更高一级为准。
func NewDetector(cfg Config) *Detector {
	d := &Detector{threshold: cfg.Threshold, headRunes: cfg.HeadBufferRunes}
	if d.threshold < 1 {
		d.threshold = 3
	}
	if d.headRunes < 1 {
		d.headRunes = DefaultHeadBufferRunes
	}

	add := func(list []string, level Level) {
		for _, raw := range list {
			text := strings.TrimSpace(raw)
			if text == "" {
				continue
			}
			lower := strings.ToLower(text)
			if d.indexOfLower(lower) >= 0 {
				continue
			}
			idx := len(d.words)
			d.words = append(d.words, word{text: text, lower: lower, level: level})
			if level == LevelVeto {
				d.vetoIdx = append(d.vetoIdx, idx)
			}
			if n := utf8.RuneCountInString(lower); n > d.maxRunes {
				d.maxRunes = n
			}
		}
	}
	// 先加 veto，再 strong、weak，使高一级优先占位。
	add(cfg.Veto, LevelVeto)
	add(cfg.Strong, LevelStrong)
	add(cfg.Weak, LevelWeak)

	return d
}

func (d *Detector) indexOfLower(lower string) int {
	for i := range d.words {
		if d.words[i].lower == lower {
			return i
		}
	}
	return -1
}

// MaxKeywordRunes 返回最长关键词的字符数，流式回退保留长度据此计算。
func (d *Detector) MaxKeywordRunes() int { return d.maxRunes }

// Release 在确认放行后交出全部保留内容。
//
// 只有在逐字核对策略允许提前放出时才可用；常规收尾应调用 Flush，由它先做一次
// 整体复核。该方法与 Flush 的区别是不再判定，用于上游已确认干净的场景。
func (g *StreamGuard) Release() string {
	if g == nil || g.blocked || len(g.buf) == 0 {
		return ""
	}
	out := string(g.buf)
	g.released += len(g.buf)
	g.buf = nil
	return out
}

// HoldBackRunes 是流式下必须始终留在缓冲区、尚未写给客户端的字符数。
//
// 取最长关键词长度减一：任何起始于已释放位置之后的关键词，其最后一段字符必然
// 仍落在保留区内，因此判定一定先于该关键词被写出。最长词为 1 个字符时返回 0。
func (d *Detector) HoldBackRunes() int {
	if d.maxRunes <= 1 {
		return 0
	}
	return d.maxRunes - 1
}

// HeadRunes 返回开头扣留窗口的字符数。
func (d *Detector) HeadRunes() int {
	if d == nil || d.headRunes < 0 {
		return 0
	}
	return d.headRunes
}

// Inspect 对完整文本做一次判定，用于非流式响应与错误正文。
func (d *Detector) Inspect(text string) Result {
	if d == nil || len(d.words) == 0 || text == "" {
		return Result{}
	}
	lower := strings.ToLower(text)
	var matched []string
	seen := make(map[int]struct{}, len(d.words))
	counted := 0

	for i := range d.words {
		w := &d.words[i]
		if !strings.Contains(lower, w.lower) {
			continue
		}
		if _, dup := seen[i]; dup {
			continue
		}
		seen[i] = struct{}{}
		matched = append(matched, w.text)
		switch w.level {
		case LevelVeto:
			return Result{Poisoned: true, Reason: "veto:" + w.text, Matched: matched}
		case LevelStrong, LevelWeak:
			counted++
		}
	}
	if counted >= d.threshold {
		return Result{
			Poisoned: true,
			Reason:   "threshold:" + itoa(counted) + "/" + itoa(d.threshold),
			Matched:  matched,
		}
	}
	return Result{Matched: matched}
}

// StreamGuard 持有单次流式响应的判定状态。
//
// 使用方式是每次拿到上游的一段文本就 Feed；只有在 Feed 返回 VerdictPass 时才可
// 把给出的文本写回客户端。返回 VerdictBlock 时必须丢弃缓冲区并把响应改成错误。
type StreamGuard struct {
	d   *Detector
	buf []rune
	// pending 保存上游分片尾部尚未闭合的 UTF-8 字节，等下一段补齐再判定。
	pending  []byte
	released int
	seen     map[int]struct{}
	counted  int
	matched  []string
	blocked  bool
	reason   string
}

// NewStreamGuard 为一次流式响应创建守卫。Detector 为空时返回的守卫恒放行。
func (d *Detector) NewStreamGuard() *StreamGuard {
	g := &StreamGuard{d: d}
	if d != nil {
		g.seen = make(map[int]struct{}, len(d.words))
	}
	return g
}

// Feed 追加一段上游文本，返回本次可安全写给客户端的内容与判定结果。
//
// 返回的字符串一定是缓冲区中「不可能再构成任何关键词」的前缀，因此调用方直接
// 写出即可，不存在关键词先于判定泄露的窗口。
//
// chunk 按字节喂入即可：上游分片可能把一个多字节字符切成两半，因此未闭合的
// 尾部字节会被留在缓冲区等下一段补齐；直接 []rune(chunk) 会把半截 UTF-8 变成
// 替换字符，使中文关键词永久失配。
func (g *StreamGuard) Feed(chunk string) (string, Verdict) {
	if g == nil || g.d == nil || len(g.d.words) == 0 {
		return chunk, VerdictPass
	}
	if g.blocked {
		return "", VerdictBlock
	}
	if chunk != "" {
		g.pending = append(g.pending, chunk...)
		// 只把完整的 UTF-8 序列并入缓冲区，剩余不完整字节等下一段。
		complete := completeRunePrefix(g.pending)
		if complete > 0 {
			g.buf = append(g.buf, []rune(string(g.pending[:complete]))...)
			g.pending = append(g.pending[:0], g.pending[complete:]...)
		}
	}
	if res := g.scanBuffer(); res.Poisoned {
		g.blocked = true
		g.reason = res.Reason
		g.buf = nil
		g.pending = nil
		return "", VerdictBlock
	}
	return g.drain(), VerdictPass
}

// completeRunePrefix 返回 b 中可作为完整 UTF-8 序列处理的前缀长度。
func completeRunePrefix(b []byte) int {
	n := len(b)
	if n == 0 {
		return 0
	}
	// 从末尾回退，最多 3 个字节即可确定最后一个 rune 是否完整。
	for back := 1; back <= 4 && back <= n; back++ {
		i := n - back
		if utf8.RuneStart(b[i]) {
			if utf8.FullRune(b[i:]) {
				return n
			}
			return i
		}
	}
	return n
}

// Flush 在上游结束时调用，释放剩余保留内容。上游正常收尾时缓冲区不可能还含有
// 未判定的关键词，因此这里只做最后的整体复核再交出剩余字符。
func (g *StreamGuard) Flush() (string, Verdict) {
	if g == nil || g.d == nil || len(g.d.words) == 0 {
		return "", VerdictPass
	}
	if g.blocked {
		return "", VerdictBlock
	}
	if len(g.buf) == 0 && len(g.pending) == 0 {
		return "", VerdictPass
	}
	// 上游结束时剩下的不完整字节一并按替换字符处理，避免静默丢弃内容。
	if len(g.pending) > 0 {
		g.buf = append(g.buf, []rune(string(g.pending))...)
		g.pending = nil
	}
	if res := g.scanBuffer(); res.Poisoned {
		g.blocked = true
		g.reason = res.Reason
		g.buf = nil
		return "", VerdictBlock
	}
	out := string(g.buf)
	g.released += len(g.buf)
	g.buf = nil
	return out, VerdictPass
}

// Blocked 报告是否已判定为投毒。
func (g *StreamGuard) Blocked() bool { return g != nil && g.blocked }

// Reason 返回判定原因，未判定时为空。
func (g *StreamGuard) Reason() string {
	if g == nil {
		return ""
	}
	return g.reason
}

// ReleasedRunes 返回已经交出的字符数。为 0 时说明尚未向客户端写出任何内容，
// 调用方据此决定能否安全地换账号重试。
func (g *StreamGuard) ReleasedRunes() int {
	if g == nil {
		return 0
	}
	return g.released
}

// scanBuffer 扫描当前缓冲区并累计去重命中数。
func (g *StreamGuard) scanBuffer() Result {
	if len(g.buf) == 0 {
		return Result{}
	}
	lower := strings.ToLower(string(g.buf))
	for i := range g.d.words {
		w := &g.d.words[i]
		if _, dup := g.seen[i]; dup {
			continue
		}
		if !strings.Contains(lower, w.lower) {
			continue
		}
		g.seen[i] = struct{}{}
		g.matched = append(g.matched, w.text)
		if w.level == LevelVeto {
			return Result{Poisoned: true, Reason: "veto:" + w.text, Matched: g.matched}
		}
		g.counted++
	}
	if g.counted >= g.d.threshold {
		return Result{
			Poisoned: true,
			Reason:   "threshold:" + itoa(g.counted) + "/" + itoa(g.d.threshold),
			Matched:  g.matched,
		}
	}
	return Result{Matched: g.matched}
}

// drain 交出不可能再构成关键词的前缀。
//
// 保留长度取 max(开头扣留窗口 - 已交出字符数, 最长关键词长度 - 1)：
//   - 开头窗口保证判定在第一个字节写出之前完成，使响应头仍可改成错误状态码；
//   - 关键词回退保证任何关键词都不会先于判定被写出。
func (g *StreamGuard) drain() string {
	hold := g.d.HoldBackRunes()
	// 开头窗口：还没交出够 headRunes 个字符时，剩余部分全部扣留。
	if remain := g.d.headRunes - g.released; remain > hold {
		hold = remain
	}
	if hold >= len(g.buf) {
		return ""
	}
	cut := len(g.buf) - hold
	out := string(g.buf[:cut])
	g.released += cut
	// 复制剩余部分，避免底层数组被 append 复用后别名到已交出的切片。
	rest := make([]rune, len(g.buf)-cut)
	copy(rest, g.buf[cut:])
	g.buf = rest
	return out
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
