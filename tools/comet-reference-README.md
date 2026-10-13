# comet-reference 独立验收（C）

运行（Node ESM，已就绪的 Chrome、ffmpeg、three；不安装依赖）：

```
node tools/comet-reference-probe.mjs --url http://127.0.0.1:5210/ --out E:/Global-session/xiao-20261013-111729/evidence/judge/d85-reference --port 10533 --w 1440 --h 900 --theme dark --reference C:/Users/28147/Pictures/star.png
```

`--url --out --port --w --h --theme --reference` 均为必选项。输出必须置于本轮 evidence/judge 下且用新的 --out 目录，避免覆盖既有证据。5210 是 d85 负控；生产 8080 不提供 dev handle，不能用几何测试对其作通过判定。每个浏览器诊断独占 CDP 端口。原 star.png 实为 WebP RIFF；仅对只读源作 ffmpeg 到证据目录的 PNG 解码，记录原文件 SHA-256，不改写源。

产物：reference/reference-crop.png 和 reference-mask.png 展示排除机身、时间、日期和水印后的屏幕区；reference/reference.json 有 sRGB 分段、头尾投影、暖冷统计，不能解释为相似度百分比。截图有原页面、黑底隔离、头尾隔离、gather/scatter 和逐 mesh 贡献；`*.json.gz` 是原始全点阵、真实 GPU buffer/uniform、birth/age/life 等采样，result.json 保存记录与判定。reference-comparison.png 是同向同尺度并排图，但对齐仅旋转和等比缩放，不替代原始截图或视觉审查。形态、连接、细粒剥离和有无盘必须对真实截图人工复核；未测只能 skip 或 instrument-invalid，不能 pass。

注意：首轮 d85 负控执行已在 scatter 阶段遭页面级探针消失（`__MATERIAL_PROBE is not defined`）；该轮 result.json 中明确为 instrument-invalid，先前已保存的参考测量与帧仍可供检查。不可将未采满的 scatter/负控自证说成完成。合并 A/B 后须在稳定的目标页重跑全工具，并独立重跑旧 `space-pursuit-probe` 的冻结 hash、相机、三秒世界静止矩阵和正常时钟长录制。性能预算仍为 10 draw / 3.5 MB，55 FPS 为目标；此短循环不测 FPS，不宣称 100% 视觉一致。
