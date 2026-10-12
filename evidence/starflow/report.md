# V5 独立星流复核

结论：实际星流向内。7 秒 / 7 px 最近邻测量存在跨星误配，不能据其向外中位数判页面坏；甚至故意向外时也会给出向内。未修改 frontend/backend、星实现、尺寸、资产或 causal 判据。原 framing-probe 与两份历史 FAIL 保留，不伪写为 PASS。

## 最短可复跑

工作目录 E:/Global-session/xiao-20261012-184927/judge；独占现有 CDP 10161。

```sh
command node tools/star-flow-probe.mjs --out=evidence/starflow/recheck
command node tools/star-flow-probe.mjs --control=stopped --out=evidence/starflow/recheck-stopped
command node tools/star-flow-probe.mjs --control=outward --out=evidence/starflow/recheck-outward
command node tools/star-flow-probe.mjs --control=dark --out=evidence/starflow/recheck-dark
command node tools/star-flow-evidence-check.mjs
```

独立工具仅跑星流，不跑 25 分钟完整 probe。正常组覆盖 scatter/travel/gather/hold；每个对照只需一对 7 秒截图。最后一条校验提交的 verified-* 证据及当前工具 hash。不要并发使用同一 CDP。

## 同帧实证与错误配对

首轮 baseline/，真实进程 exit 0、source hash 前后相同：

| 起始 phase | 同 ID 像素匹配数 | 向内数 | 像素半径差中位数 px | 严格门槛 px | 原算法中位数 px | 原匹配中已辨识的错 ID |
|---|---:|---:|---:|---:|---:|---:|
| scatter | 133 | 133 | -2.727238 | 0.276385 | +1.3000 | 6/6 |
| travel | 177 | 177 | -2.807982 | 0.255966 | +0.3265 | 8/8 |
| gather | 200 | 200 | -3.094092 | 0.287553 | +0.3750 | 9/9 |
| hold | 114 | 114 | -2.913493 | 0.384319 | +0.5780 | 7/7 |

原法并非所有正值都达到其 resolved 标准；travel 原 se=0.554，不能把它描述为 resolved 向外。gather 原 se=0，属于错误地 resolved。新法四组均超过自己的正确 MAD 门槛。

travel 明确错配实例（坐标为原 detector 的像素索引质心）：A=(1315.2201,620.5423)，原 B=(1318.3468,614.6465)，径向投影 +1.382 px。A 的 geometry UUID d8995619-83f3-41a7-a8ff-60792b934810，index 538；原 B 是同层 index 423。真正 index 538 的 B=(1327.7211,533.5143)，离 A 87.9213 px。详见 baseline/result.json 的 runs[1].legacy.matches 与两帧 state、PNG。全组同星位移中位数约 65–67 px；7 px 窗排除了真伴星，却收下另一颗星。

首轮真实 rAF 内逐颗比较，限定前后都在画面、颜色非零、未重生、camera dz>0、同 phase：scatter 312540/312540、travel 2017602/2017602、gather 391406/391406、hold 861723/861723 次观察向内，向外均为 0。这是逐帧观察次数，不是独立星数。重生分别排除 3/39/11/19 次，另有出画计数；零亮度排除数均为 0。

## 最终方法复验与故障注入

verified-baseline 与 verified-stopped/outward/dark 采用最终工具版本；每组真实进程 exit 0。证据检查实际执行 PASS。正常四组通过，逐帧四 phase 向外均为 0。最终 gather 的 219 颗像素星全部向内，median -2.985915 px；hold 125 颗全部向内，median -3.086620 px。

| 对照 | 实际注入 | 截图结果 | V5 星流判定 |
|---|---|---|---|
| stopped | advanceCamera 停止，spin/twinkle 继续 | camera dz=0；真实半径差为浮点零附近 | 拒绝 |
| outward | camera 正常后撤，星场额外向相机移动 | camera dz=+0.902044；127 颗全向外，median +8.953351 px，floor 1.181049 | 拒绝 |
| dark | 星层不可见，camera 正常后撤 | camera dz=+0.902247；两帧均无阈值亮点 | 拒绝 |

outward 是关键反证：旧法 median -1.6145 px，匹配 8 对，已辨识 8 对全部错 ID。新法在 camera 仍后撤时也拒绝，排除了仅靠状态猜测像素的假通过。

## 测量方法与边界

- 读取 debugScene 实际四层 position/color buffer、object.matrixWorld、camera.matrixWorldInverse/projectionMatrix；不修改正常样本的星或相机状态。geometry UUID + vertex index + generation 标识粒子，position 改变就登记重生。
- 正常运行期间每个真实 rAF 逐颗跟踪；出画、颜色零、重生分别计数。保存截图时复用已有 freezeAndSettle/RESUME_RAF，短暂排队 rAF，让截图与实际矩阵对应，并核对 capture 前后状态不动；两端之间恢复真实 rAF。没有合成图片、虚拟时间或调用数学模型替代渲染。
- 真实 Page.captureScreenshot PNG 使用原 components/detectStars，thr=60、size=2..200、外场半径门槛 0.35、原双帧 mask 原样保留。像素中心 +0.5 与 projected 位置核对：最近星误差 <=1.5 px，另一星必须 >2.5 px；一星一亮点双向唯一，歧义拒绝。
- 用 projected 位置只建立身份；最终位移是两张真实截图质心的 radiusB-radiusA。每条明细保存像素、投影、误差与真实位移。截图已视觉核查为隔离星空，无前景/UI。
- n>=8、camera dz>0.2、abs(median)>max(实测噪声,2*SE) 不放宽。噪声取新旧 estimator 实测绝对中位数的较大值。正确排序 MAD，且额外要求多数同 ID 像素星向内。无亮点为失败，不用相机状态代替像素证据。
- 原 radialFlow 中 median 要求预排序，却收到未排序 absolute deviations，部分 SE=0；独立方法修正这一误差。有限旋转时旧 dot(displacement,radialA) 还含 rB*(cos(theta)-1) 项，纯 spin 并不严格为零；半径差消除这项。
- 7 秒截图对按起始 phase 标名，可跨 phase；每 phase 方向另由实际 rAF 内同 phase 对支持，不谎称 7 秒全在一个 phase。
- 所有运行保存 sourceBefore/After、runtime 方法 hash、工具 hash。最终组同时核对 source、engine identity、runtime hash；HMR 导致非零退出，应重测。首轮服务端 starfield.ts SHA256=f7f0bf043dac35aa764b9d501782a0577bb5667bbf79723266f9b9cfc6c4dc9c；starfield.update runtime SHA256=fbe13028fb5f12887b81daa5def235131ff3dacbf25f26c36f681a3bc53ee1af。

历史 evidence/framing-repair/full-5210 与 evidence/framing-repeat 两次 FAIL 本身不能事后恢复真实 ID，因为旧证据未存 buffer。保留这些历史失败，只能以本次同帧、同原 estimator 的明确错配证明其不可靠，不能声称已逐对重建历史截图身份。无需旧 5321 对比便已有同帧阳性与故障阴性证据。

本交付为独立 V5 星流替代判据；不宣称原完整 framing-probe 已通过。父助手可独立采纳工具结果或后续整合入口，其余 V5 相机与尺寸/资产/causal 验证均不改变。
