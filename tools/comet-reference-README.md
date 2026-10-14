# comet-reference 独立验收（C，第二阶段）

仅改 tools/；不安装依赖。5223 是独立 judge 树的 d85 负控。5210 已合 A、还会合 B，不能称为 d85；父完成合并并停止修改后再跑。--repo 必须指向被服务的目标仓库，不是判具所在仓库。

在 E:/Global-session/xiao-20261013-010435/judge 执行：

```
node tools/comet-reference-probe.mjs --url http://127.0.0.1:5223/ --repo E:/Global-session/xiao-20261013-010435/judge --out E:/Global-session/xiao-20261013-111729/evidence/judge/d85-reference-new --port 10543 --w 1440 --h 900 --theme dark --reference C:/Users/28147/Pictures/star.png
node tools/comet-reference-space-probe.mjs --url http://127.0.0.1:5223/ --repo E:/Global-session/xiao-20261013-010435/judge --out E:/Global-session/xiao-20261013-111729/evidence/judge/d85-space-new --port 10545 --width 1440 --height 900
```

正控命令将 --url 改为 http://127.0.0.1:5210/，--repo 改为父实际服务树的绝对路径，并使用新的 --out。结果不得覆盖既有目录。状态优先级 invalid > fail > skip > pass；退出码 invalid=2、fail=1、其余=0。skip 原样列出，不是 pass。

核心判具保留12项产品/证据检查，加4项破坏自证，分母16。每次advance后显式sample读取几何；四类mutant放在下一12秒周期的成熟travel。static校验同birth身份；alpha校验实际GPU buffer/uniform及tail-only/empty真实截图；flat校验协方差秩；disc使用DoubleSide真实三角扇并独立截图。d85原尾opacity=0，因此alpha自证先建立明确标记的opacity=1诊断状态，产品原始失败保留。旧event盘由编译片段的径向层结构与uniform识别，scatter各阶段隔离截图比较实际贡献；未知mesh仍需人工复核。

源码证据来自浏览器实际Network响应，按document loader epoch保存原始响应gzip。inline sourcemap的sourcesContent逐字节绑定--repo实际文件，结束再次核验；7个必需runtime文件为ParticleEngine、emittedTail、cometVisual、cometTransition、choreography、spaceMotion、spaceMotionContract，缺失或不匹配为invalid。Vite擦除为空响应的types.ts单独标记skip，不参与runtime绑定通过数。document重载或导航为invalid，不自动重装探针冒充连续采样。

comet-reference-space-page.mjs适配局部出生楔、birthAcceleration固定场、bodyBasis；不改变世界相机、Logo 3秒、XZ同时起停门槛。旧space-pursuit-lib/page.mjs与checks.mjs原样保留。原judge导出40项，旧入口的normal-RAF-recording与served-source-stable两项补齐42；正常时钟长录制在此确定性入口为skip。另列future-head-camera-birth-independence：8组确定性随机未来head/camera/nozzle变化，逐个验证已有birth参数和b+v*age+.5*a*age²不受影响。隔离stock clone设置frustumCulled=false，仍保留真实GPU读取和完整着色器比对证据。

产物：reference/reference-crop.png、reference-mask.png和reference.json；原页面、body/tail隔离、gather/scatter、逐mesh与mutant截图；reference-comparison.png实际由同向等比映射生成，只有旋转与统一缩放，没有拉伸/改色。原参考头尾截断，因此完整bbox、视觉相似、强度对流及正常时钟FPS不作通过声明。原star.png若为WebP，只在证据目录解码，不修改源图。

原始点阵、GPU shader、生命周期和served响应以gzip存储；超过8MB原文分片，解压后依manifest顺序拼接，每个输出文件限制10MB内。result.json/summary只列聚合，不输出完整点阵或shader。Chrome临时profile在本会话scratch，关闭后删除。预算门槛仍为10 draw / 3.5MB，55FPS为目标；短探针不宣称完整性能达标或100%视觉一致。

已实跑空间证据位于 E:/Global-session/xiao-20261013-111729/evidence/judge/stage2-space-d85-final：628个时间样本，原42项为41 pass / 1 skip / 0 fail / 0 invalid，新增future-head-camera-birth-independence为pass，总计43项、exit 0、状态skip。未做正常时钟长录制，不能称42/42 pass。A/B新动力场与bodyBasis的最终浏览器正控须由父在稳定5210执行；此轮不把旧d85通过当成新产品通过。

已实跑证据位于 E:/Global-session/xiao-20261013-111729/evidence/judge/stage2-d85-final：11帧、4类自证，7 pass / 2 fail / 6 skip / 1 measured-not-verdict，0 invalid，exit 1。两个产品失败是实际tail不可见与event盘贡献。stage2-d85-r1保留types空模块处理前的invalid证据，不追认旧失败轮次。首轮__MATERIAL_PROBE消失无法据此归因产品，本轮稳定5223已完整执行并记录loader/source。
