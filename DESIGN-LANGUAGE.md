# Sub2API × x.ai 设计语言规范

> 本文件是**唯一真相源**。所有 SubAgent、所有页面重构都以此为准。
> 任何偏离都必须先改这里，再改代码。

---

## 0. 最高规则（不可违反）

| # | 规则 | 含义 |
|---|---|---|
| 1 | **不动后端逻辑** | 只碰 `frontend/`。禁止改 `backend/` 下的任何 `.go`。 |
| 2 | **完全兼容原有前端组件** | 所有既有 CSS 类名（`btn-*` / `card*` / `page-header` / `tab*` / `badge*` / `stat-*` / `table` …）**必须保留**。只改它们的**实现**，不改名字、不改调用方。 |
| 3 | **优先走配置入口** | 已有配置项（`home_content` 等）能表达的，走配置；只有写死在源码里、配置无法触及的才改代码。 |
| 4 | **保留布局与面板结构** | 只改 UI 与组件样式。不动 DOM 层级、不动栅格结构、不动路由。 |
| 5 | **统一设计语言，不得割裂** | 所有页面消费同一套 token。禁止页面级自造配色。 |

### 硬约束（会被测试拦下）

- `make test-frontend` 必须绿：`lint:check` + `typecheck` + 29 个 critical spec。
- `src/features/channel-monitor-v2/__tests__/designSystem.structure.spec.ts` 直接断言工具类名字符串存在（`page-header`、`page-title`、`card`、`btn btn-secondary`、`tab`、`tab-active`、`badge badge-warning`、`rounded-3xl`、`ring-1 ring-gray-900/5`、`monitor-toolbar`…）。**这些字符串不能删。**
- `src/i18n/__tests__/localeKeyCompleteness.spec.ts` 要求 en/zh 键完全对齐。新增文案必须**同时**加 en 和 zh。
- `pnpm-lock.yaml` 不得变更（用 pnpm **9.15.9**，`--frozen-lockfile`）。

---

## 1. 设计立场

x.ai 的设计不是"某种风格"，是**极度克制的中性灰阶 + 唯一一个暖橙 accent**。

三个词概括：**neutral（中性）、precise（精确）、quiet（安静）**。

- **中性主导**：界面 95% 是灰阶。颜色是稀缺资源。
- **单一强调色**：全站只有一个暖橙。它出现在"该被点的地方"——主按钮、当前项、关键数字、焦点环。不出现的地方：装饰、边框、背景块、图标底色。
- **精度而非华丽**：用字号/字重/间距/对齐建立层级，**不用**渐变、发光、光斑、彩色描边。
- **安静**：动效是过渡，不是表演。无弹跳、无脉冲、无呼吸光。

### 反面（本项目现状，必须清除）

- ❌ 青绿/teal 作为主色 → 中性灰阶 + 暖橙
- ❌ `bg-mesh-gradient` 背景光斑 → 纯色背景
- ❌ `shadow-glow` / `glow-lg` 发光 → 极轻的分层阴影或无阴影
- ❌ 按钮渐变 `bg-gradient-to-r from-primary-500 to-primary-600` → 纯色
- ❌ `text-gradient` 文字渐变 → 纯色文字
- ❌ 紫色 `purple-*`（464 处）/ 靛蓝 `indigo-*`（216 处）/ `violet-*`（131 处）→ 收敛到中性或语义色
- ❌ 彩色图标底块（`stat-icon-primary` 的彩色圆角块）→ 中性底 + 语义色仅用于图标本身

---

## 2. 色板

采纳 x.ai 的 **HSL 三元组**体系（`H S% L%`，不含 `hsl()` 包裹），便于 Tailwind 里做 `/opacity`。

### 2.1 原始色阶（Raw）

```
--color-jet:       0 0% 4%       /* 近黑，dark 背景 */
--color-umbra:     221 12% 14%   /* dark 卡片/边框 */
--color-charcoal:  0 0% 10%      /* dark 卡片面 */
--color-ash:       216 5% 19%    /* dark 次级面 */
--color-steel:     216 4% 22%    /* dark 分隔 */
--color-evenfall:  214 16.1% 28% /* dark 中间调 */
--color-midnight:  214 58.3% 9.4%/* 深蓝黑（图表面） */
--color-ink:       213 11% 16%   /* 深墨（文字 on light） */

--color-fog:       216 4% 51%    /* 中性中灰（次要文字） */
--color-pewter:    213 12% 70%   /* 中性浅灰（禁用/占位） */
--color-dove:      222 19% 86%   /* 极浅灰（light 边框） */
--color-nimbus:    228 21.74% 95.49% /* 浅灰面（light 次级底） */
--color-ivory:     40 18% 97%    /* 暖白（light 卡片面） */
--color-white:     0 0% 100%

--color-sunset:    22 100% 51.6% /* ★ 唯一 accent：暖橙 */
--color-dawn:      37 100% 76%   /* accent hover（更亮） */
--color-dusk:      263 70% 50.4% /* 保留：图表第 N 色 */
--color-twilight:  255 92% 76%   /* 保留：图表第 N 色 */
--color-breeze:    214 48.9% 73.9% /* info */

--color-codeblock: 0 0% 7%       /* 代码块底 */
```

### 2.2 语义层（Semantic）——**页面只准用这一层**

| Token | Light | Dark |
|---|---|---|
| `background` | `white` | `jet` |
| `background-hover` | `dove` | `umbra` |
| `foreground` | `jet` | `dove` |
| `foreground-hover` | `umbra` | `white` |
| `card` | `ivory` | `charcoal` |
| `border` | `dove` | `umbra` |
| `input` | `white` | `fog` |
| `primary` | `jet` | `white` |
| `primary-hover` | `ivory` | `umbra` |
| `secondary` | `fog` | `pewter` |
| `secondary-hover` | `pewter` | `ash` |
| **`accent`** | **`sunset`** | **`sunset`** |
| **`accent-hover`** | **`dawn`** | **`dawn`** |
| `success` | `142 71% 45%` | `142 69% 58%` |
| `error` | `0 84% 60%` | `0 72% 65%` |
| `info` | `breeze` | `breeze` |

> **注意 `primary` 在 x.ai 里是"主按钮"= 黑/白，`accent` 才是橙。** 这与 Sub2API 现在的 `primary` = 品牌青绿 正好错位。
>
> **本项目的映射决策**：把 Sub2API 的 `primary-*` 色阶**整体重定义为暖橙阶**（保号不改名），这样 95 个 `bg-primary-*`、120 个 `text-primary-*` 文件自动跟随，且不破坏任何类名。
> 中性灰阶则接管 `gray-*`（light）与 `dark-*`（dark）。

### 2.3 Tailwind 色阶映射（关键）

**`primary` 从 teal 改为暖橙**，色阶值（HSL → HEX，按 x.ai sunset 22° 展开）：

| 步 | HEX | 用途 |
|---|---|---|
| `primary-50` | `#FFF4ED` | 极浅底（选中行） |
| `primary-100` | `#FFE6D5` | 浅底（badge） |
| `primary-200` | `#FFC9AA` | 边框（选中态） |
| `primary-300` | `#FFA87A` | — |
| `primary-400` | `#FF8447` | dark 模式主色（提亮） |
| `primary-500` | `#FF6708` | **基准 accent**（= sunset 22 100% 51.6%） |
| `primary-600` | `#EB5A00` | hover |
| `primary-700` | `#C24A00` | active |
| `primary-800` | `#9A3B00` | — |
| `primary-900` | `#7A3000` | dark 深底 |
| `primary-950` | `#431800` | — |

**`accent` 从 slate 改为中性灰阶**（原 `accent-*` = slate 复制品，全站 0 处使用，可安全重定义为中性辅助阶）：

沿用 x.ai `nimbus/steel/evenfall/fog` 一脉，保持与 `gray` 一致的 Tailwind 步进。

**`gray` / `dark` 中性阶**：

- `gray-*`：保持 Tailwind 默认（已经足够中性，且 10575 处使用——不动最安全）
- `dark-*`：保持现有值不变（3130 处使用）。**dark 模式的层次靠 `dark-950/900/800/700/600`，已经接近 x.ai 的 jet/charcoal/umbra 关系，不重定义。**

> **为什么不动 gray/dark 的数值**：它们已经被 13705 处引用且语义正确。重定义数值只会制造无收益的风险。设计语言的统一靠**改组件类的组合方式**达成，不是靠改底层灰阶。

### 2.4 颜色使用纪律

**允许用 accent（橙）的地方**（穷举）：
1. 主按钮 `.btn-primary` 底色
2. 当前激活项（`.sidebar-link-active`、`.tab-active` 的文字/指示条）
3. 焦点环 `focus:ring`
4. 关键数字/连接状态指示
5. 链接 hover 的文字色

**禁止用 accent 的地方**：
- 大面积背景、卡片底、页面底色
- 装饰性边框、分隔线
- 图标底色块（`stat-icon-*`）
- 任何渐变
- 中性操作（次级按钮、输入框）

**语义色（success/error/warning/info）**：只用于**状态**，不用于装饰，不做大面积填充（badge 的浅底例外）。

### 2.5 紫色的例外条款（重要，别误删）

`purple-*` / `violet-*` / `indigo-*` 在本项目里有**两类用法**，处理方式相反：

**✅ 保留 —— 语义标识色**：
- `PlatformTypeBadge.vue`：`antigravity` 平台 = purple，`grok` = zinc
- `PlatformTypeBadge.vue`：Grok Heavy plan = purple，SuperGrok = cyan
- `GroupBadge.vue` / `MonitorQuotaView.vue`：分组颜色区分
- 图表多序列区分色（`dusk` / `twilight` 同理）

这些是**信息载体**——同一系统里用不同色区分不同平台/分组/序列。改成中性会让它们无法区分。**保留原色。**

**❌ 清除 —— 装饰性用色**：
- 统计卡图标的彩色底块（`bg-purple-100 p-2` + `text-purple-600`）→ 中性底 + 语义色图标
- 无信息含义的强调文字、装饰边框、背景色块

**判断标准**：这个颜色是否在**区分**某个具体对象（平台/分组/状态/序列）？
- 是 → 保留
- 否，只是"让画面丰富点" → 清除，中性化

**例外条款对 `teal` / `cyan` 也不适用（订正）**：`teal` 是旧主色，任何**装饰性**位置都要清除。但 `teal` **同样可能被用作标识色**，此时与 purple 同理保留。

已核实的真实用法（**这些保留原色**）：

| 位置 | 用途 | 性质 |
|---|---|---|
| `components/common/GroupBadge.vue` | 16 个分组区分色之一（amber/orange/emerald/blue/purple/pink/indigo/**teal**/rose/cyan/violet…） | ✅ 保留 |
| `components/account/CreateAccountModal.vue` `cnAccentActiveClass` / `cnAccentIconClass` | **deepseek 平台**标识色（kimi=pink、zhipu=indigo、**deepseek=teal**、minimax=rose、opencode_go=amber） | ✅ 保留 |
| `components/account/CreateAccountModal.vue:211` | 同上，平台切换 tab 的选中态 | ✅ 保留 |
| `components/common/PlatformTypeBadge.vue` | antigravity=purple、grok=zinc、SuperGrok=cyan | ✅ 保留 |
| `components/admin/usage/UsageTable.vue` | `native-compaction-badge` 语义标签（**有 data-testid**） | ✅ 保留 |

**要清除的**：装饰性 `bg-teal-*` / `text-teal-*` 图标底块、无信息含义的强调色、旧主色残留（例：`OpsSwitchRateTrendChart.vue:134` 的 `text-teal-500` 图标色；`AccountStatsModal.vue` 的 `bg-teal-100` 图标底块）。

**最终判断规则（统一适用于 purple/violet/indigo/teal/cyan）**：

> 这个颜色是否在**区分某个具体对象**（平台、分组、状态、图表序列、语义标签）？
> - **是** → 保留原色
> - **否**，只是让画面丰富 → 清除并中性化

**有 `data-testid` 或落在 `switch (form.platform)` / `if (props.platform === ...)` 这类分支里的颜色，一律视为语义色，保留。**

---

## 3. 字体

x.ai 用专有字体 `xVf`（拿不到 license）。**替身策略**：

| 用途 | 选择 | 理由 |
|---|---|---|
| 无衬线（UI） | `"Inter Tight", "Inter", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` | xVf 是紧凑几何体；Inter Tight 是最接近的开放替代。**保留中文字体栈**（本项目是中文站）。 |
| 等宽 | `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` | x.ai 同款，开源可自托管 |

> ⚠️ **不引入外部 CDN 字体链接**。若要用 Inter Tight，用 `@fontsource` 或自托管 woff2。**第一轮先用系统栈**（去掉 `Arial`，Inter 放最前），字体自托管作为独立子任务。

**排版尺度**（x.ai 特征：字重克制在 400/500，很少 700）：

| 元素 | 字号 | 字重 | 行高 | 字距 |
|---|---|---|---|---|
| `h1` / `.page-title` | 24px (text-2xl) | 600 | 1.25 | -0.01em |
| `h2` | 20px | 600 | 1.3 | -0.005em |
| `h3` | 16px | 600 | 1.4 | normal |
| body | 14px (text-sm) | 400 | 1.5 | normal |
| small / meta | 12px (text-xs) | 400 | 1.45 | normal |
| 代码 | 13px | 400 | 1.5 | normal |

> **重要**：`font-bold`(700) 在本项目里被大量滥用（`stat-value`、`page-title` 等）。新语言里**大字号用 600 而非 700**，700 只留给极少数强调。

---

## 4. 形状与间距

| Token | 值 | 说明 |
|---|---|---|
| 基础圆角 | **8px** (`rounded-lg`) | x.ai `--radius: .5rem` |
| 卡片圆角 | **12px** (`rounded-xl`) | 从 `rounded-2xl` 降下来 |
| 大面板/模态 | 16px (`rounded-2xl`) | 封顶，不再往上是 `4xl` |
| 小控件（badge/tag） | 6px 或 full | badge 保持 full |
| 按钮 | 8px | 从 `rounded-xl` 降到 `rounded-lg` |

> **现状问题**：全站大量 `rounded-2xl` 卡片 + `rounded-xl` 按钮 + `rounded-4xl` 自定义值，圆角过大是"AI 味"来源之一。**收敛到 8/12/16 三档。**

**间距**（保持 4px 基数，收紧大间距）：

- 卡片内边距：`p-5`（现 `p-6`）
- 卡片间距：`gap-4`（现常为 `gap-6`）
- 页面内边距：`p-4 md:p-6`（现 `p-4 md:p-6 lg:p-8`）
- 分区间：`space-y-5`
- 表单项：`space-y-4`

---

## 5. 层次建立方式（替代渐变与发光）

x.ai 几乎不用阴影，用**边框 + 面差**建立层次。**优先级顺序**：

1. **边框**：1px `border`（light: `gray-200`；dark: `dark-800`）
2. **面差**：背景 `gray-50` → 卡片 `white`；dark: `dark-950` → `dark-900/800`
3. **阴影**（仅浮层）：弹窗/dropdown/toast 用一层极轻阴影
   ```css
   --shadow-pop: 0 4px 12px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.06);
   ```
   dark 模式靠边框而非阴影。

**彻底删除**：`shadow-glow`、`shadow-glow-lg`、`shadow-glass`、`shadow-glass-sm`、`bg-mesh-gradient`、`text-gradient`，以及页面上那些 `blur-3xl` 的彩色光斑 `div`。

**焦点态**（无障碍必需，保留）：`focus-visible:ring-2 ring-primary-500/40 ring-offset-2`。
—— 这里 `primary` 是橙，即 x.ai 的 focus 也是 accent 色，一致。

---

## 6. 动效

| 项 | 规定 |
|---|---|
| 时长 | 150ms（微交互）/ 200ms（过渡）/ 250ms（浮层） |
| 缓动 | `cubic-bezier(0.4, 0, 0.2, 1)` — **禁止 bounce / elastic / spring** |
| 允许 | 淡入、位移 4-8px 的滑入、颜色/边框过渡 |
| 禁止 | 缩放弹跳、脉冲呼吸光、hover 图片放大、跑马灯、闪烁光标 |
| 无障碍 | 必须保留 `prefers-reduced-motion` 分支 |

---

## 7. 深色模式

- 通过 `.dark` class 切换（Tailwind `darkMode: 'class'`，**已是如此，不动**）。
- 每个颜色决策**必须同时给 light 和 dark**。不允许只写 light。
- dark 模式**不用阴影**，用边框 + 面差。
- dark 模式 accent 用 `primary-400`（提亮），不是 `primary-500`（在深底上不够亮）。

---

## 8. 组件改造映射表

> 只改 `style.css` 里这些类的**实现**。类名、调用方不变。

| 类 | 现状 | 改为 |
|---|---|---|
| `.btn` | `rounded-xl` + `active:scale-[0.98]` | `rounded-lg`，去掉 scale 缩放 |
| `.btn-primary` | teal 渐变 + `shadow-md` | **纯色 `bg-primary-600`**（橙），hover `primary-700`，无阴影 |
| `.btn-secondary` | 白底 + 灰边框 | 保持结构，边框收紧到 `gray-200/dark-700` |
| `.btn-ghost` | 透明 + 灰字 | 保持 |
| `.btn-danger/success/warning` | 渐变 + 阴影 | 纯色，无阴影 |
| `.card` | `rounded-2xl` + `shadow-card` | `rounded-xl` + **无阴影**，靠边框 |
| `.card-hover` | `-translate-y-0.5` + 阴影 | 只改边框色，**不位移** |
| `.stat-icon-*` | 彩色底块 | 中性底（`gray-100`/`dark-800`）+ 语义色图标 |
| `.badge-*` | 保持 | 保持（浅底 + 深字，语义正确） |
| `.input` | `rounded-xl` + ring | `rounded-lg`，focus 边框 `primary-500`（橙） |
| `.sidebar-link-active` | `bg-primary-50` 青绿 | 橙的极浅底 `bg-primary-50`（自动跟随新阶）+ 左指示条 |
| `.toast` | `border-l-4` 彩色 | 保留语义色左边条（信息传达有效） |
| `.progress-bar` | teal 渐变 | 纯色 `bg-primary-500` |
| `.text-gradient` | 渐变文字 | **删除**，改纯色 |
| `.glass` / `.card-glass` | 毛玻璃 | 保留（header 毛玻璃是 x.ai 特征），但去 `shadow-glass` |

---

## 9. 页面级注意事项

### 首页（`HomeView.vue`）
三个分支：`home_content`（配置优先）→ `compactHomeEnabled` → 默认首页。
- **保留全部三个分支**（规则 3）。
- 默认首页是重头戏：现在是青绿光斑 + 网格底纹 + 渐变按钮，要改成 x.ai 那种**大留白、强排版层级、单一橙 CTA** 的结构（但**保留其 DOM 骨架**，规则 4）。
- 光斑 `div`（4 个 `blur-3xl`）和网格底纹 `bg-[linear-gradient(...)]` → 删除。

### 布局壳（`AppLayout` / `AppHeader` / `AppSidebar`）
- `AppLayout.vue` 里的 `bg-mesh-gradient` → 删除。
- `AppSidebar` 42KB，是导航主体；只改类实现，不动结构与路由映射。
- `AppHeader` 18KB，保留毛玻璃，去发光阴影。

### 图表（chart.js）
- 图表配色要重新映射到新语义层。`dusk`/`twilight`（紫/蓝紫）保留作多序列区分色，但**主序列用橙**。

### `channel-monitor-v2`
- **有结构断言测试**（见 §0 硬约束）。改动前先读 `designSystem.structure.spec.ts`。
- `rounded-3xl` + `ring-1 ring-gray-900/5` 是断言要求，**必须保留**。

---

## 10. 验收清单（每个页面自查）

- [ ] 只用 §2.2 语义色 / 现有 `gray-*` `dark-*` / 新 `primary-*`(橙)。无 `teal/cyan/purple/violet/indigo` 残留（语义色除外）。
- [ ] 无渐变按钮、无渐变文字、无发光阴影、无背景光斑。
- [ ] 圆角只有 8/12/16 三档。
- [ ] 大字号用 600 而非 700。
- [ ] light + dark **都**给了。
- [ ] 所有既有类名保留。
- [ ] 无 `bounce`/`pulse`/缩放弹跳动效；`prefers-reduced-motion` 分支在。
- [ ] 文字对比度 ≥ 4.5:1（正文）/ 3:1（大字）。
- [ ] `detect` 扫描无新增 AI 味告警。
- [ ] `make test-frontend` 绿。
