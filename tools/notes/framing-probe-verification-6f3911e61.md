# Verification record for `6f3911e61` — and a correction to its own commit message

## What that commit claimed, and what the runs actually show

The commit message says: *"three consecutive full runs on trunk agreed check-for-check
(102/0/11)"*. **That is not what the artifacts show, and the claim is corrected here.**

Three consecutive full runs on trunk (`shots/lk-verify/run{1,2,3}`):

| run | pass | fail | skip | exit |
|---|---|---|---|---|
| 1 | 102 | 0 | 11 | 0 |
| 2 | 102 | 0 | 11 | 0 |
| 3 | 101 | 0 | 12 | 0 |

One verdict differs between them: **`V3 measured spread is a brand effect` is
PASS / PASS / SKIP.**

That variation is the *criterion's own subject matter*, not instability in the repair.
The gate is `max(fh) - min(fh) > 0.01` over whatever brands the sweep draws, and the
draw is not controlled:

- runs 1-2 drew three groups (claude, gemini, grok) and the whole-sweep range cleared
  0.01 (0.052% and 0.0203%) → PASS;
- run 3 drew two same-height groups (claude 0.45%, gemini 0.43%) with a range of
  0.0044 → NOT ANSWERED.

Both outcomes are correct and neither is a FAIL. So the honest statement about
stability is **"no run FAILed, and every run exited 0"** — NOT "the verdict sets were
identical". The distinction matters because the identical-verdict-set claim is exactly
the kind of thing a later reader would use to conclude the criterion is deterministic,
and then treat a PASS/SKIP flip as a regression.

## Corrected summary of this repair

- The two repaired criteria contribute **zero FAILs** on trunk across all runs.
- `V3 brand effect` legitimately varies between PASS and NOT ANSWERED with the draw.
  That is inherent to a criterion whose precondition comes from the sample; the fix
  made the unanswerable case say so instead of FAILing.
- Discriminating power is established by the mutants, not by trunk runs:
  - **A** (routes genuinely disagree, `dfw + 0.3`) → **4 × V6 cross-check FAIL** ✓
  - **B** (tolerance blown, `0.30 > 0.25`) → **SKIP / NOT ANSWERED**, not FAIL ✓
  - **C** (de-confounding impossible, forced `false`) → **V3 FAIL** ✓
  Mutants live only in `shots/lk-mutants/`; the committed file was never modified.
- Each mutant run also reports one unrelated FAIL —
  `V7/V8 asset probe results present` — because the mutant harness does not run
  `framing-probe-assets.mjs` first. Recorded so those FAILs are not mistaken for
  mutation effects.
