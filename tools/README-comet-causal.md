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

将提供 `--observe=绝对JSON路径`，用只读属性路径配置 Points、核心区间与生命周期数组；不接受自写理想位置公式。允许同一 geometry 划池或独立 tail Points。接口及运行结果补充于 evidence/judge/report.md。
