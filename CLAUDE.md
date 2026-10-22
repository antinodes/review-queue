# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — `tsc` type-check then `vite build`; deploy by serving `dist/`
- `npm run preview` — Preview built output

No test suite, no linter. TypeScript strict-ish flags (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`) run via `tsc --noEmit` during build.

Deployment is automated: push to `main` triggers `.github/workflows/deploy.yml`, which builds with `--base /review-queue/` and publishes to GitHub Pages. The Pages build sets no OAuth env vars, so it runs in PAT-only mode. OAuth-enabled builds live on hosts that provide a token-exchange backend (contract in the README); each such host needs its own OAuth App because the `redirect_uri` derives from the build's `BASE_URL`.

## Architecture

Single-page vanilla-TS PWA. No framework. DOM is built imperatively. Data flows through a fixed pipeline:

```
github.ts         → classify.ts            → stacks.ts        → render.ts
(search + batch     (bucket by CI/threads/   (group stacked     (group by repo,
 GraphQL per repo)   review state)            PRs into chains)   render tables)
```

**`main.ts`** owns lifecycle: token prompt → fetch → classify → render → 3-minute auto-refresh. Caches `cachedReviews`/`cachedMyPRs`/`cachedDependabot` so theme and tab switches re-render from memory without refetching.

**`github.ts`** opens each refresh cycle with four parallel fetches: `searchReviewing` (the union of `review-requested:@me` and `reviewed-by:@me`, because submitting any review clears the request), `searchAuthored`, `searchMergedAuthored`, `fetchViewerLogin`. Then batched GraphQL queries per repo, `PRS_PER_QUERY` PRs each, packed into aliased fragments (`pr123: pullRequest(number: 123) {...}`). GitHub enforces a per-query resource limit ("Resource limits for this query exceeded"), so `fetchPRChunk` halves any batch that trips it and keeps the partial data that did come back. Merged PRs use the same fragment with `$full: false`, which `@include`-skips CI, reviews, threads, stacks, and mergeability. Adding a new GraphQL field? Add it to `buildPRFragment` and the `RawPRDetail`/`PRDetail` types — the mapping in `toPRDetail` is hand-written, not generated; fields inside the `$full` block are optional on `RawPRDetail`. All GraphQL goes through `graphqlPartial()` (or `graphql<T>()`, which also throws on any `errors[]`). The fragment is a GraphQL document, so comments in it use `#`, not `//`.

`fetchPRDetails` re-queries once for any PR whose `mergeable` came back `UNKNOWN`. GitHub computes mergeability lazily and answers `UNKNOWN` while it works, so a cold PR's conflicts are invisible on first load without this (measured: 8 of 40 cold PRs, two of them genuinely conflicting). The retry is best-effort and never fails the refresh.

The merged section costs more on top of that: `fetchRepoDeployments` (paginated, capped at 10 pages) per repo with merged PRs, plus one `isAncestor` compare call per PR-per-environment and per candidate release until a version matches. Compare results are cached across cycles (`settledAncestry`), since ancestry between two fixed SHAs never changes; `loadQueue` still awaits `computePRMetadata` before first paint.

**Rate limits.** Every request goes through `apiFetch`, which caps concurrency at `MAX_CONCURRENT_REQUESTS` and turns 403/429 rate-limit responses into a `RateLimitError` carrying `retryAt`. A fetch `TypeError` while `navigator.onLine` is treated the same way: secondary-limit responses omit CORS headers, so the browser reports them as network failures. The pause is module state in `github.ts`, so once one request is limited every queued request fails fast instead of reaching GitHub; sign-out clears it. `loadQueue` is single-flight per session and skips while paused or while the tab is hidden. Only a 401 signs the user out. `fetchPRChunk` bisects on resource-limit errors and 502/504 timeouts but throws on any other GraphQL error, so PRs never vanish silently.

**`classify.ts`** has three independent classifiers. They share `buildClassified` and differ only in bucket rules:
- `classifyReviewPRs` — drops drafts and PRs the viewer has already APPROVED, splits the rest into `ready` vs `blocked` (unresolved threads, or CI failing/in flight). Merge conflicts deliberately do **not** block here: they stop a merge, not a review.
- `classifyMyPRs` — keeps everything including drafts and failing CI, buckets by `ciState` → `unresolvedThreads`/conflicts → `reviewDecision`.
- `classifyDependabotPRs` — filtered upstream via `isDependabot` (matches `dependabot[bot]` author), keeps failing/blocked/ready.

**CI state is three-valued, and null is not failure.** `isCIFailing` (`FAILURE`/`ERROR`) and `isCIInFlight` (`PENDING`/`EXPECTED`) are the only two predicates; a null rollup means no checks ran at all and must fall through to the thread and review checks. A repo with no workflows landing in Failing CI is the bug this prevents.

**`stacks.ts`** groups stacked PRs so a chain renders once, in order, instead of scattering across buckets. Two sources: GitHub's native stack API (`stack`/`stackEntry`, and `stack.entries` for the rungs we can't otherwise see) and a fallback that infers chains from branch bases. Three invariants worth preserving:
- Head branches are keyed by **owner plus branch** (`headKey`). Fork PRs are routinely opened from `main`, and an unqualified key makes every PR targeting `main` a child of some stranger's fork PR.
- Each member records its **real parent**, not the previous row. Inferred chains branch, so siblings share a rung and the row above is not necessarily what you are waiting on.
- Native stacks must read `stack.entries`, not `size`/`position` arithmetic. Merged rungs keep their positions and still count toward `size`, so arithmetic invents a parent that already landed.

Every open rung of a stack renders. `main.ts` `fetchMissingRungs` loads native-stack entries that no search returned, and `buildStacks` takes them (plus approved/draft review PRs) as `context`: they render dimmed and complete the chain, but a stack only appears when at least one of the tab's own PRs is in it. Inferred stacks can only include rungs some search returned.

Dependabot PRs are stripped from the review tab before classification in `main.ts`, not inside the classifier.

**Days-open excludes draft time.** `calcDaysOpen` walks `ReadyForReviewEvent` / `ConvertToDraftEvent` timeline items and subtracts time spent in draft. If you touch this, preserve the invariant that the first event being `ReadyForReviewEvent` means the PR was *created* as a draft.

**`themes.ts`** is the only source of user-facing strings. Themes swap labels (tabs, section headers, column headers, conventional-commit-type names) and toggle `typeIconMode` between text badges and `rpg-awesome` icons. The RPG theme also provides a `threadBadgeFn` to render hazard tiers. Adding UI copy means adding it to `ThemeConfig` and every theme — there is no fallback chain.

**`render.ts`** is theme-driven. `renderSection` takes `RenderColumnOpts` (`showBlockReasons`/`showCI`/`showAuthor`) so one function covers all buckets across all three tabs. `extractType` parses conventional-commit prefixes from PR titles for the type column. Blocked sections render a **Reason** column carrying one pill per cause rather than a bare thread count; conflicts also show as an inline pill in the title cell of every other section. `escapeHtml` escapes quotes as well as angle brackets because its output lands in attribute position and branch names may legally contain `"`.

**Stalled builds.** `buildStartedAt` comes from the oldest still-running check *suite* that actually holds check runs. Filtering on `checkRuns.totalCount > 0` is required: several apps register a suite per push and leave it `QUEUED` forever, which would otherwise read as a permanently hung build. Past `STALLED_BUILD_MINUTES` the CI cell flags it.

## Conventions worth knowing

- Token sent only to `api.github.com`. On 401 (and only 401) the app clears the token from localStorage and re-prompts.
- Service worker (`public/sw.js`) never caches `api.github.com` — PR data is always fresh.
- App badge (`navigator.setAppBadge`) reflects the count of ready review PRs only.
- `variations/` holds standalone HTML prototypes for theme ideas (bloomberg, brutalist, dataviz, dense, newspaper, rpg). They are not wired into the app — treat as design references.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions` + `verbatimModuleSyntax`). Type-only imports must use `import type`.
