ALTER TABLE groups
    ADD COLUMN IF NOT EXISTS model_plaza_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN groups.model_plaza_enabled IS
    'Whether the group renders in the model plaza from its own configuration (platform + model_pricing + allowlist) instead of only through a bound channel. Lets unbounded groups such as composite image/video groups publish prices.';
