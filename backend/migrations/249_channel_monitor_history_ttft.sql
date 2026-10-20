-- First-token latency for one monitor probe.
--
-- latency_ms measures the whole non-streamed request and ping_latency_ms only
-- measures the TCP handshake to the origin, so neither is a first-token
-- measurement. The channel status page shows 首字时间, so probes that stream a
-- short reply record the real time to the first delta here.
--
-- NULL means "this probe could not measure a first token": a failed probe, or a
-- provider/mode that cannot stream. The page renders NULL as '-' rather than
-- falling back to end-to-end latency, which would overstate it.
ALTER TABLE channel_monitor_histories
    ADD COLUMN IF NOT EXISTS ttft_ms INTEGER;
