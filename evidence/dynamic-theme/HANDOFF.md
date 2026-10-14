# Dynamic theme UI handoff

## Scope and implementation

Base: cfe0c914e. Worktree: E:/Global-session/xiao-20261013-185958/surfaces. Initial worktree was clean.

Added `frontend/src/features/universe/theme.ts:isDarkSurface()`. It reads the root at call time and returns `typeof document !== 'undefined' && (html.dataset.universeTheme === 'cosmos' || html.classList.contains('dark'))`. It works before component mount, returns false during SSR, and does not change classes, storage, or user preferences.

Replaced only UI color/theme detection in these 12 components:

- `frontend/src/components/account/AccountStatsModal.vue`
- `frontend/src/components/admin/account/AccountStatsModal.vue`
- `frontend/src/components/charts/TokenUsageTrend.vue`
- `frontend/src/views/admin/DashboardView.vue`
- `frontend/src/views/admin/ops/components/OpsErrorDistributionChart.vue`
- `frontend/src/views/admin/ops/components/OpsErrorTrendChart.vue`
- `frontend/src/views/admin/ops/components/OpsLatencyChart.vue`
- `frontend/src/views/admin/ops/components/OpsSwitchRateTrendChart.vue`
- `frontend/src/views/admin/ops/components/OpsThroughputTrendChart.vue`
- `frontend/src/features/channel-monitor-v2/MonitorTrendChart.vue`
- `frontend/src/components/payment/StripePaymentInline.vue`
- `frontend/src/views/user/StripePaymentView.vue`

Existing chart semantic palettes, dark text/grid/tooltip branches, and Stripe appearance values are preserved. Cosmos now selects those existing dark branches even when html.dark is absent and localStorage theme is light. Stripe changes are limited to the appearance theme predicate.

Targeted inspection of Vue chart consumers (chart.js/vue-chartjs/canvas/echarts) under components, views and features found no additional chart color decisions based on localStorage or prefers-color-scheme. Preference controls in HomeView, KeyUsageView and AppSidebar are unchanged. No CSS, backend, API implementation, authentication, payment flow, iframe URL or token policy changes. No dependencies installed.

## Validation and actual results

Commands were run with an explicit workdir. Existing local node_modules were used.

Focused helper tests: `frontend/src/features/universe/__tests__/theme.spec.ts` has 8 passing cases, including cosmos with a saved light preference, cosmos with dark preference, absent/other universe following html.dark, reads before mount without caching, unchanged preference, and SSR with document/window unavailable.

Added/extended component regressions:

- TokenUsageTrend: dark/light legend, ticks and grid; preserved semantic input/output colors.
- OpsErrorScopeCharts: existing dark tooltip colors with cosmos and html.dark absent.
- StripePaymentInline.theme: actual component mounting with mocked Stripe SDK; night on cosmos/light and preference fallback outside cosmos.
- StripePaymentView: night on cosmos/light and preference fallback, asserting the complete elements appearance options and unchanged preference.

From `E:/Global-session/xiao-20261013-185958/surfaces/frontend`:

```text
node.exe node_modules/vitest/vitest.mjs run src/features/universe/__tests__/theme.spec.ts src/features/universe/__tests__/AppUniverse.spec.ts src/components/charts/__tests__/TokenUsageTrend.spec.ts src/components/payment/__tests__/StripePaymentInline.theme.spec.ts src/views/user/__tests__/StripePaymentView.spec.ts src/views/user/__tests__/stripeLazyLoading.spec.ts src/views/admin/__tests__/DashboardView.spec.ts src/views/admin/ops/components/__tests__/OpsErrorScopeCharts.spec.ts src/views/admin/ops/components/__tests__/OpsThroughputTrendChart.spec.ts src/features/channel-monitor-v2/__tests__/designSystem.structure.spec.ts src/features/channel-monitor-v2/__tests__/monitorZoom.spec.ts
```

Initial foreground execution: 9 suites passed; two new regression test issues were found (partial i18n mock missing createI18n; assertion on a disabled legend's absent labels). Fixed only those tests, then reran the affected suites:

```text
node.exe node_modules/vitest/vitest.mjs run src/components/payment/__tests__/StripePaymentInline.theme.spec.ts src/views/admin/ops/components/__tests__/OpsErrorScopeCharts.spec.ts
Test Files 2 passed (2)
Tests 7 passed (7)
```

Final aggregate across the unchanged passing suites and corrected rerun: all 11 selected files and 53 tests passed. This is an aggregate of two runs, not a claim of a subsequent full-suite rerun.

ESLint: Node invoked `node_modules/eslint/bin/eslint.js` with all 18 changed/new .vue/.ts files enumerated using git diff and git ls-files --others. Exit 0. After the test corrections, ESLint reran for those two changed tests and exited 0. `git diff --check` exited 0.

Typecheck was attempted exactly once:

```text
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
```

The terminal killed it at the 60-second execution limit (exit 124), without diagnostics. Typecheck is NOT recorded as passing; a complete project typecheck remains outstanding. No second typecheck attempt was made.

The background invocation through the local `node` shell wrapper exited with `stdin is not a tty` before running tests. Foreground `node.exe` successfully ran the test suite. Node emitted localStorage experimental warnings, and Browserslist reported old data; no dependency changes were made.

## Risks and follow-up boundaries

- Existing nonreactive computed theme readers remain intentionally unchanged in structure. Cosmos is permanently dark in this scope. If runtime surface switching is added later, these computed values and already-created Stripe Elements will need an explicit reactive refresh policy.
- `frontend/src/composables/useSwipeSelect.ts:185` still chooses marquee inline colors from html.dark. The composables directory is frozen for this round; follow up separately for cosmos/light marquee contrast.
- `frontend/src/utils/embedded-url.ts:48` (`detectTheme`, predicate at line 50) still maps html.dark to the embedded theme query. The utils directory and iframe URL/token strategy are frozen. Any later change needs a separate review of the embedding contract; this patch does not alter it.
- Verification uses jsdom and mocked chart/Stripe SDK boundaries. No real payment was submitted and no browser screenshot or live Stripe iframe visual acceptance was performed.
- Complete vue-tsc validation remains outstanding because of the recorded timeout.

All changes in this worktree are owned by this task and are committed together with this handoff. Nothing was pushed.
