# Home acceptance fix handoff

Workdir: E:/Global-session/xiao-20261013-185958/home
Branch: ui/cosmos-home-20261013
Base: cfe0c914e

## Changes

- frontend/src/views/home/HeroSection.vue:64: change only the shared supporting-copy container from dark:text-dark-400 to dark:text-dark-200. All three real paragraphs (home.heroDescription, home.sections.hero.integration, home.sections.hero.assurance) inherit #e2e8f0, as defined by the existing Tailwind palette. Titles, copy, wrapping, layout and spacing are unchanged. No new surface, scrim or text shadow.
- frontend/src/views/HomeView.vue:19: remove the home-compact-sky class and its entire scoped ::before style, including desktop/mobile static galaxy references. Compact remains locally .dark, transparent and isolated, with the existing layout, orange actions and branch priority. It relies on App's existing shared UniverseBackground; no standalone compact background is required.
- frontend/src/views/__tests__/HomeView.compact.spec.ts:87: remove the old sky-class assertion while retaining dark/transparent/white, theme-toggle and orange-action assertions.
- frontend/src/views/home/__tests__/homeSections.spec.ts:64: assert the brighter class and the exact three translated supporting paragraphs for both English and Chinese.

No changes to App.vue, particle engine, useHomeMotion, image assets, other components, translations or dependencies.

## Executed verification

From frontend, using the existing dependencies and command node:

    command node node_modules/vitest/vitest.mjs run src/views/__tests__/HomeView.compact.spec.ts src/views/home/__tests__ src/features/universe/__tests__/AppUniverse.spec.ts

Result: exit 0; 6 test files passed, 77 tests passed. Final execution duration: 3.56s.
Covers saved light/dark preferences, compact/default/custom priority, orange actions, 20 SectionReveal units, the three real translated paragraphs, frozen motion/shell behavior, and App mounting exactly one shared universe background for compact.
Full output: evidence/home-fix/focused-home-tests.log (local ignored log).

    command node node_modules/eslint/bin/eslint.js src/views/HomeView.vue src/views/home/HeroSection.vue src/views/__tests__/HomeView.compact.spec.ts src/views/home/__tests__/homeSections.spec.ts --max-warnings=0

Result: exit 0; no lint diagnostics. Final invocation captured via Node spawnSync with these same arguments.
Output: evidence/home-fix/changed-eslint.log (local ignored log).

    git diff --check

Result: passed after removing the empty trailing line left by deleting the scoped style.
Additional executed checks passed: exactly the four allowed code/test files changed; App.vue, particle engine and useHomeMotion unchanged from cfe0c914e; no compact sky class, pseudo-element or static galaxy reference remains in HomeView.vue.

Vitest output includes Node localStorage, Browserslist age and missing-prop warnings; no test failures. No dependency installation or unrelated warning cleanup.

## Integration boundary

No typecheck or full build was run, as requested; parent handles these after merge. No new browser screenshots were produced in this small fix. Parent's previously completed desktop/mobile light/dark and overflow acceptance is supplied context, not claimed as a new browser run here.
