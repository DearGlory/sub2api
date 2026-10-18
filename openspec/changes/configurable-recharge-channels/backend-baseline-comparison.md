# 后端 service 全量失败基线对照

目标及干净基线均为 HEAD `50ec1808b70faa1186cfa6831f0bca6d93687064`。目标包含本次充值未提交修改；基线目录 `E:/Global-session/xiao-20261016-sub2api-v0217/integration` 的 `git status --porcelain -- backend` 为空。本次只在基线运行测试，没有写源码。

- 目标全量 `go test -json -tags=unit ./internal/service -count=1` 退出码 1，JSON action 统计为 pass=16664、skip=5、fail=26。这些包括父测试/子测试/包事件，不是 16664 个独立业务场景。
- 同一 Windows 环境对两个工作树执行相同失败测试选择器后，均退出码 1，失败名集合完全一致。
- 选择器：`Test(OpenAIPassthroughReplayWriteFailureKeepsNamedResidueReservation|OllamaProbeCallback_StaleLongDoesNotOverrideNewShort|NormalForwardReplayCancelPriorityDeadlineAfterReleaseContract|RootcauseNormalForwardLargeCompact.*Acceptance|NormalForwardCompactReplay)`。
- 比较每项 Error / Messages 文本：除两个 replay 子测试打印的函数运行时内存地址不同外，完全一致。仅归一化该函数指针地址，不移除断言结果和数值。
- 主要断言：期望 `file already closed`，Windows 实际为 `The handle is invalid`；write-failure fixture 期望 nil 却得到 size=32 的内存 replay；Ollama stale callback 期望 CAS 计数 0 实际 1。
- 结论：本次观察到的这组失败已在干净基线复现，不是充值补丁新增。但 service 全量仍非全绿，不能把基线对照说成全量通过；不在充值任务中改动这些转发/Ollama测试。

## 失败测试（父测试与子用例分列）

父测试 15 项；子用例 10 项；另含 1 个包失败事件。

- `TestNormalForwardCompactReplayCancelAfterDiskReadMustNotReturnRetryBody`
- `TestNormalForwardCompactReplayCancelBeforeRestoreSkipsDiskRead`
- `TestNormalForwardCompactReplayCancelDuringCleanupMustStopSecondDoWindows`
- `TestNormalForwardCompactReplayCleanupCloseFailureHoldsReservation`
- `TestNormalForwardCompactReplayReadHookFailureStopsBeforeSecondDo`
- `TestNormalForwardCompactReplayReadOnlyWriteFailureStopsAfterFirst200`
- `TestNormalForwardCompactReplayResponseReadCancelKeepsCancellation`
- `TestNormalForwardCompactReplayRestoreEntryCanceledSkipsDiskRead`
- `TestNormalForwardCompactReplayShortDiskReadStopsBeforeSecondDo`
- `TestNormalForwardCompactReplaySuccessReleasesSpillAndReservation`
- `TestNormalForwardReplayCancelPriorityDeadlineAfterReleaseContract`
- `TestNormalForwardReplayCancelPriorityDeadlineAfterReleaseContract/decision/cleanup_failure`
- `TestNormalForwardReplayCancelPriorityDeadlineAfterReleaseContract/decision/cleanup_success`
- `TestNormalForwardReplayCancelPriorityDeadlineAfterReleaseContract/restore/cleanup_failure`
- `TestNormalForwardReplayCancelPriorityDeadlineAfterReleaseContract/restore/cleanup_success`
- `TestOllamaProbeCallback_StaleLongDoesNotOverrideNewShort`
- `TestOpenAIPassthroughReplayWriteFailureKeepsNamedResidueReservation`
- `TestOpenAIPassthroughReplayWriteFailureKeepsNamedResidueReservation/empty`
- `TestOpenAIPassthroughReplayWriteFailureKeepsNamedResidueReservation/residue`
- `TestRootcauseNormalForwardLargeCompactEncryptedRecoverySessionAcceptance`
- `TestRootcauseNormalForwardLargeCompactEncryptedRecoverySessionAcceptance/nonstream`
- `TestRootcauseNormalForwardLargeCompactEncryptedRecoverySessionAcceptance/stream`
- `TestRootcauseNormalForwardLargeCompactFallbackAcceptance`
- `TestRootcauseNormalForwardLargeCompactFallbackAcceptance/nonstream`
- `TestRootcauseNormalForwardLargeCompactFallbackAcceptance/stream`
