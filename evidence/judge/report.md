# 独立三维材质与爆炸坍缩裁判

本轮基线结论：FAIL（实跑 exit 1）。原 world 验收保持 PASS（exit 0）。未修改 frontend/backend、运动实现、配置或产品阈值；旧 world probe 只有 drawCalls 6→10 一处修改，geometryBytes 仍为 3500000。

工作树：E:/Global-session/xiao-20261013-010435/judge
起点：492661412d4c735c826ad54a4d620da6ce15edc5
第一阶段工具提交：d3e16b10dbae5254e12ac2215f5cae2895f722b8
仅本地提交，无 push、部署。

## 基线保存

在实现裁判前，baseline-freeze 保存了 5210 served 模块和 SHA256，以及左右两程 travel .45/.7 的 body、tail、both、empty 共 16 张分离 PNG。每张冻结 head/camera/phase；同一浏览器测试后恢复对象 visibility 和 DOM style。baseline-freeze/baseline.json 保存 manifest。

实际 ParticleEngine served SHA256：ada335812ed53d51278a5cc5f06a26103d97f57ed4f696e3d5ad2add4a375cd1。ParticleEngine、emittedTail 以及所有本次采集的冻结运动模块，从最初截图到最终基线均一致。未使用的 cometVisual served 模块期间发生变化，但 Network 实际加载清单中没有 cometVisual/cometSurface/cometVolume，场景也没有 Mesh；不能把未使用模块视为产品已接入。

最终证据：baseline-final/result.json（实际采集），baseline-final/verdict.json（当前裁判从压缩原始几何重新判定）。原始每相位全粒子数据为独立 .json.gz，manifest 含 SHA256。第一次未压缩的大 JSON 写入触发 Invalid string length，已改逐相位压缩；该失败不作为验收结果。早期 baseline/result.json 内未扣除内部 flow 的 glyph 终点 FAIL 已被最终基线更正，最终结论以 baseline-final 为准。

## 实测结论

- 四个 travel 相位均无三角 Mesh、无法线表面、无体积 draw：FAIL。识别不依赖 Mesh 名称，也不以旧 tailPoints opacity 决定新尾是否存在。
- 同相位尺寸比为 1，低于 1.35..1.75；曝光未下降：FAIL。相同 PNG 差分阈值为 8，使用空场对照。
- 左程 .45/.7 核+发等效 bbox 直径分别约 80.486/87.994 px；右程约 79.994/88.487 px。亮度均值约 27.39..27.71，高分位约 69.75..72.11，饱和白占比均为 0。零白饱和不能当作三维材质通过。
- gather q=.1：径向位移中位数约 -0.000228，方向余弦中位数约 -0.278，Z 厚度比约 .9973：没有内部外爆，FAIL。
- scatter：三种 dt 的后半/前半收缩速度比分别 .42067、.42365、.41907，均小于 1.8，且后段存在半径回升：FAIL。
- 每组使用同一个 source/glyph、相对每帧实际 head。gather 终点扣除实际 iconOrbitOffsets 后 RMS 约 5.6e-7，PASS。内部 flow 不作世界漂移。
- hold 无新生尾，既有尾池继续衰减；世界锚点固定；scatter .62 完成原核收拢：PASS。无真实体积时，体积密度衰减项为 instrument-invalid，不能以旧尾数据链代替新体积证明。
- baseline-world：42 项 PASS，四程 hold 3 秒、XZ 同启停、camera 正 Z、世界 hold 收缩等全部保留。draw 6，全 geometry 含 index 1052304 bytes。
- baseline-final 正常 rAF 实录 37.027 秒，CDP 页面录制跨度 37.025 秒；1776 次 rAF，平均 20.832ms，P50 20.8ms，P95 20.9ms，0 longtask。console/WebGL 错误观测为 0。视频保存为 normal-page.mp4 和 normal-canvas.webm。

## 工具覆盖和自证

comet-material-probe.mjs 参数化 url/out/port/w/h/theme，可直接复跑候选；profile 固定落其 out/profile。端口占用即拒绝，不连接其他浏览器。默认三种 cadence：1/60、1/30、.008/.024/.016。

live inventory 保存 triangle/normal/span/material，以及 gl.getShaderSource 和所有 gl.getUniform 数组条目。Mesh position/normal 从实际 GPU buffer 回读。每个对象单独截图证明可见贡献；空场、主体和全彗星分离保存。核受光通过原光向/反光向冻结 PNG 对照，恢复原 uniform。体积适配器针对已只读检查的 A shader（IS_COMA、uBins/uDensities）验证真实 pool birthTime/age/position 到加权采样中心，再核对实际 GPU uniform。未知布局 instrument-invalid。

selftest/selftest.json：synthetic positive，以及不爆炸、线性坍缩、世界漂移、无 Mesh、仅 Points/无体积、opacity=0、过曝、缩小等负控，全部按预期拒绝；增加无出生预铺密度、GPU 密度位置脱链负控。synthetic 仅裁判自证。

gpu-selftest/result.json：合成真实三角表面 GPU 回读 PASS；正控贡献 3238 pixels，反光向差分 3104 pixels，opacity=0 为 0 pixels；带此额外 Mesh 的旧 __SPACE_PROBE.audit() 仍 PASS，body/tail 实际指针保持原位。该证明检验 scene.clone(false) 不包含其他 mesh 的旧 stock 审计行为，不改旧审计代码。

## 父助手复跑

以下命令在主树合入 tools 后运行；绝对 evidence 路径指向本轮现存证据。候选 URL 若仍为 5210 可直接使用，否则只改 --url。不要把 --out 指向基线目录。

    command node tools/comet-material-probe.mjs --url http://127.0.0.1:5210/ --out E:/Global-session/xiao-20261013-010435/judge/evidence/judge/candidate-desktop-dark --port 10331 --w 1440 --h 900 --theme dark --baseline E:/Global-session/xiao-20261013-010435/judge/evidence/judge/baseline-final/result.json --record-seconds 37

    command node tools/space-pursuit-probe.mjs --url http://127.0.0.1:5210/ --out E:/Global-session/xiao-20261013-010435/judge/evidence/judge/candidate-world --profile E:/Global-session/xiao-20261013-010435/judge/evidence/judge/candidate-world/profile --port 10332 --width 1440 --height 900 --record-seconds 37

    command node tools/comet-material-selftest.mjs E:/Global-session/xiao-20261013-010435/judge/evidence/judge/selftest-rerun

    command node tools/comet-material-gpu-selftest.mjs --url http://127.0.0.1:5210/ --out E:/Global-session/xiao-20261013-010435/judge/evidence/judge/gpu-selftest-rerun --port 10332 --w 1440 --h 900 --theme dark

    command node tools/comet-material-rescore.mjs --input E:/Global-session/xiao-20261013-010435/judge/evidence/judge/baseline-final/result.json --out E:/Global-session/xiao-20261013-010435/judge/evidence/judge/baseline-final/rescore-rerun.json

    command node tools/comet-material-pixels.mjs --image E:/Global-session/xiao-20261013-010435/judge/evidence/judge/baseline-final/travel-leg1-p0.7-body.png --empty E:/Global-session/xiao-20261013-010435/judge/evidence/judge/baseline-final/travel-leg1-p0.7-empty.png --out E:/Global-session/xiao-20261013-010435/judge/evidence/judge/pixels-rerun.json

Exit：pass=0、fail=1、instrument-invalid=2、skip=3。存在已证实 FAIL 时总结果 FAIL，详细 criteria 保留 invalid/skip，不抹平未知项。

## 尚未完成的产品验收

本车道交付的是工具、旧基线和证据，未声称候选已通过。候选实际体积 shader/其 uniform 映射仍需主树复跑；当前 A 专用适配器有数值自证，尚无候选实景 PASS。真实体积外观是否塑料锥/光环、爆炸坍缩的感知连续性，需要父助手审看实际 PNG 与 normal-rAF 视频，静态数值不替代审看。

本次只完成 desktop dark 基线录制。desktop/mobile × light/dark 的发布版四格 >=36 秒录像由父助手复用本轮 record-space 工具完成，裁判明确标 skip。尺寸/曝光比较须匹配 viewport/theme；本车道没有另三格旧像素基线，不能用 desktop dark 冒充。程序在未知布局或无匹配观测时报告 instrument-invalid。候选未运行前不放宽任何判据。

保留的本地证据包含 profile 和逐帧 JPEG，但这些浏览器缓存不提交；提交源码快照、PNG、压缩 geometry、结论/性能 manifest 和视频。旧中间 baseline 目录仅供历史排障，最终报告不使用其早期 glyph 误判。
