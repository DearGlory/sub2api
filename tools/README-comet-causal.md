# 独立因果裁判（先验判据，2026-10-12）

仅新增 tools 探针，不修改被测实现。默认时序与 flightTiming.ts 一致：travel=6.5s、gather=1.4s、hold=3.0s、scatter=1.1s、coalesce=.62。

## 判据先于实测

- 可见点：最终 geometry `color.w * material.opacity >= 0.01`，且 Points/祖先 visible、处于 drawRange。不以 RGB 闪烁判定位移。此 alpha 是精灵中心的几何可见性代理，不是屏幕逐像素覆盖率。
- 收拢完成（scatter .62 的首个实际积分帧，时间误差不超过固定步长）：所有可见形态 P95 距实际 head source <=1.5u；距核 >3u 的点数必须为0。后续仅排除已证实当次 departure 后真实新生的尾粒子；未知出生契约不能据此排除。
- 出发时间为当腿 scatter 起点 + .62*1.1s。出生不得早于出发（最多一个积分步的测量分辨率）；记录 birth 元数据与实际最终位置、alpha，不能拿 birthPosition/理想轨迹代替渲染位置。旧 pool 的 tailAge 在 scatter 冻结，不能把 `当前时间-age` 冒充真实出生时间。
- C2：保持 hold 3.0s；scatter 最后0.2s至 travel 最初0.2s不能停顿/速度重置到0/teleport。数值零阈值仅为浮点鉴别 `1e-6 u/s`，不规定美学速度。记录前后位移、速度、加速度和共享粒子（固定旧帧权重）质心位移。非零但突兀的速度/加速度交由父助手人工判断，不伪造数学硬阈值。
- C4：独立正常 run、真实 rAF + PerformanceObserver longtask/resource；目标55fps。采样自身耗时、页面可见性、刷新/HMR、请求活动均记录。仅相关性，不从低fps编造产品阻塞、网络或GPU原因。全系统低频只报告原始数值。
- C3：数据与实际截图提供人工证据，不从FPS/PNG字节数/分位数判定“像彗星”。探针通过不等于完整视觉验收；父助手仍须完整页面/隔离画面、桌面/窄屏、深浅主题、双向至少2beat真实录屏及发布版复验。

## 观测原则

真实链：`advanceClock(dt) -> writeEmissionTable() -> integrate(dt*60,time) -> upload() -> advanceCamera()`，截图帧调用真实 renderer。所有步长相同，不跳 phase，不手写 state，不改 tailAge，不设置理想 positions。正常 rAF 与确定性采样严格隔离。

默认只在已验证的旧契约上自动识别 `points + scratch.tailAge/tailLife/tailReady/tailBirthPosition`；主 geometry 仍观察。新增 Points 必须识别为背景或显式配置尾对象。未知对象、无法映射出生/身份/核心范围时为 instrument-invalid，绝不无声只测旧主 geometry。

## 命令与输出接口

主入口：`node E:/Global-session/xiao-20261012-184927/judge/tools/comet-causal-probe.mjs --url http://127.0.0.1:5321/home --out E:/Global-session/xiao-20261012-184927/evidence/judge/baseline-verified --port 10131 --profile E:/Global-session/xiao-20261012-184927/evidence/judge/chrome-final-10131 --w 1440 --h 900 --theme dark --label baseline-f110b9ffc`。

支持 `--key value` / `--key=value`；`--theme dark|light`，`--perf-seconds` 默认32且至少26；`--label` 是操作者声明，工具另外保存运行时方法源码及SHA256，URL本身不能证明git版本。CDP仅10131/10132，已占用直接报错。若Git Bash的node包装器在后台报 `stdin is not a tty`，使用 `node -p process.execPath` 得到原生node.exe后调用。所有路径使用原生绝对路径。

`--self-check` 运行长尾/零速/停顿判据负控；`node tools/comet-causal-adapter-selfcheck.mjs` 验证未知对象、漏观测尾Points、无alpha、缺生命周期、范围遗漏/重叠均不可跳绿，并验证独立尾Points及同buffer分池。这些fixture明确是裁判测试，不冒充网页实测。

退出0：已实现的数值检查未失败，仍需人工C2/C3/C4验收。退出1：真实失败。退出2：instrument-invalid（可同时含已观测失败）。`result.json`含全部判据/原始关联路径；`normal-raf.json`是真实帧间隔、longtask、资源重叠及仪器回调耗时；`motion.jsonl`为每个实际积分帧的head/质心/发射点连续性；`birth-events.jsonl`逐粒子记录出生、旧基线重锁定、回收、消失/重现；`frame-NNN.json.gz`含各池完整实际xyz、RGBA、age、出生时刻、代数与矩阵；同号PNG是完整页面真实合成器截图。每100ms及指定进度均采样，不拼帧为视频。

正常rAF结束后重新加载独占页，在新文档安装rAF队列，构造全新零时钟engine，再从0等间隔1/120s走真实update链。先跑一整beat热身，再观察两个完整beat及后续travel。时间参数从0开始，不依赖截图/CDP耗时；保持hold=3s。phase=1读取跨界前最后真实帧，phase=0读取跨界后首帧，保留实际phase/progress与请求目标的误差（至多一个dt）；不伪造精确边界state。

## 合并版显式观测映射

新实现不猜属性名。先运行得到 `instrument.json` 中的 `engineKeys/scratchKeys/inventory`；父助手读新实现确认字段后创建 `--observe=绝对JSON路径`。只读路径从engine起点，以点分隔（数组下标也写成 `.0`）；不接受函数、计算曲线或替代geometry。完整示例由基线运行的 `instrument.contract` 提供，直接保存即可重放基线。

配置字段：

- `main`：旧主Points路径，通常 `points`；`background`：明确的背景子树路径列表（基线 `starfield.object`），只用于排除真实银河。每个非背景Points必须被池范围完整覆盖。
- `head`：长度3的实际发射源属性路径；`headDescription`：从哪段integrate确认渲染直接消费此源。基线为 `scratch.tailTable.xyz.0/.1/.2`，不能默认当成state；若新实现直接消费state，可明确配置 `choreography.state.headX/headY/headZ` 并说明。工具另外记录state路径与实际geometry，彼此独立。
- `pools`：每项 `id, points, start, end, mode`；end可为整数或 `all`。同Points多个池必须不重叠且完整覆盖。至少一项提供 `core:[start,end]`，这是身份固定的实际主核范围，不能挑亮点追踪。
- `mode:morph`：glyph/nucleus形态池；`mode:emitted`：真正发射池；`mode:legacy-frozen`仅旧冻结年龄契约。发射池必填 `age,life` 及 `active` 或 `generation` 路径；可填 `bornAt,timeBasis,birthPosition`。数组与geometry索引同源，长度至少覆盖end。timeBasis为 `clock`（总编舞秒）、`integrate`（integrate时间参数秒）、`departure`（当次departure后的秒）。
- geometry必须真实非索引position3/color4、标准PointsMaterial；未知shader位置/alpha变换instrument-invalid。跨Points位置通过真实matrix转换至主Points local，保存object/camera矩阵、实际head世界/NDC与核质心NDC。
- lifecycle只在active变化、generation/bornAt变化或age回绕时识别新代；确认age位于本积分步内才算真实出生。旧scatter清tailReady但大age不清，独立记 `legacy-relatch-NOT-birth`。初始已有粒子左截断，先热身一beat，不编造过去的出生时刻。

## 能力边界

RGBA alpha阈值不包含纹理边缘、遮挡、屏幕裁切或blend后的像素亮度。局部坐标距离与世界/NDC质心均保留，不能把RGB/alpha权重改变导致的质心变化当几何移动；位置专用步长使用前帧固定alpha权重。尾回收不纳入同代连续性，只记录旧点消失和新点重现。非零速度的连续性/teleport数值由父助手结合录像判断；未知形态与美学始终不自动通过。

本工具只完成独立基线否决和可参数化数值/静帧采集；不负责发布、浏览器可见屏完整录屏、28品牌回归、生产版或完整视觉成片验收。
