# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — `tsc` type-check then `vite build`; deploy by serving `dist/`
- `npm run preview` — Preview built output

No test suite, no linter. TypeScript strict-ish flags (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`) run via `tsc --noEmit` during build.

Deployment is automated: push to `main` triggers `.github/workflows/deploy.yml`, which builds with `--base /review-queue/` and publishes to GitHub Pages.

## Architecture

Single-page vanilla-TS PWA. No framework. DOM is built imperatively. Data flows through a fixed pipeline:

```
github.ts         → classify.ts            → render.ts
(search + batch     (bucket by CI/threads/   (group by repo,
 GraphQL per repo)   review state)            render tables)
```

**`main.ts`** owns lifecycle: token prompt → fetch → classify → render → 3-minute auto-refresh. Caches `cachedReviews`/`cachedMyPRs`/`cachedDependabot` so theme and tab switches re-render from memory without refetching.

**`github.ts`** makes exactly three fetches per refresh cycle: `searchReviewRequested`, `searchAuthored`, `fetchViewerLogin` (run in parallel). Then one batched GraphQL query **per repo** that packs all PR numbers into aliased fragments (`pr123: pullRequest(number: 123) {...}`). Adding a new GraphQL field? Add it to `buildPRFragment` and the `RawPRDetail`/`PRDetail` types — the mapping in `fetchPRDetails` is hand-written, not generated.

**`classify.ts`** has three independent classifiers. They share `buildClassified` and differ only in bucket rules:
- `classifyReviewPRs` — drops PRs the viewer has already APPROVED, drops non-SUCCESS CI, splits SUCCESS PRs into `ready` vs `blocked` (unresolved threads).
- `classifyMyPRs` — keeps everything including drafts and failing CI, buckets by `ciState` → `unresolvedThreads` → `reviewDecision`.
- `classifyDependabotPRs` — filtered upstream via `isDependabot` (matches `dependabot[bot]` author), keeps failing/blocked/ready.

Dependabot PRs are stripped from the review tab before classification in `main.ts`, not inside the classifier.

**Days-open excludes draft time.** `calcDaysOpen` walks `ReadyForReviewEvent` / `ConvertToDraftEvent` timeline items and subtracts time spent in draft. If you touch this, preserve the invariant that the first event being `ReadyForReviewEvent` means the PR was *created* as a draft.

**`themes.ts`** is the only source of user-facing strings. Themes swap labels (tabs, section headers, column headers, conventional-commit-type names) and toggle `typeIconMode` between text badges and `rpg-awesome` icons. The RPG theme also provides a `threadBadgeFn` to render hazard tiers. Adding UI copy means adding it to `ThemeConfig` and every theme — there is no fallback chain.

**`render.ts`** is theme-driven. `renderSection` takes `RenderColumnOpts` (`showThreads`/`showCI`/`showAuthor`) so one function covers all buckets across all three tabs. `extractType` parses conventional-commit prefixes from PR titles for the type column.

## Conventions worth knowing

- Token sent only to `api.github.com`. On 401 the app clears the token from localStorage and re-prompts.
- Service worker (`public/sw.js`) never caches `api.github.com` — PR data is always fresh.
- App badge (`navigator.setAppBadge`) reflects the count of ready review PRs only.
- `variations/` holds standalone HTML prototypes for theme ideas (bloomberg, brutalist, dataviz, dense, newspaper, rpg). They are not wired into the app — treat as design references.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions` + `verbatimModuleSyntax`). Type-only imports must use `import type`.
