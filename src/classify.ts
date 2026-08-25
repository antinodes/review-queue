import type { SearchPR, PRDetail, StackRef } from './github.ts'
import { buildStacks, stackMemberKeys, prKey } from './stacks.ts'
import type { StackGroup } from './stacks.ts'

export type Bucket = 'ready' | 'blocked' | 'skipped' | 'failing' | 'building' | 'needsReview' | 'draft' | 'merged'

// StatusState is SUCCESS | FAILURE | ERROR | PENDING | EXPECTED, or null when the commit has no
// rollup at all. Null means nothing ran, which is not the same as failing — a repo with no
// workflows (docs, prompt libraries, config repos) must not land in Failing CI.
const CI_FAILING = new Set(['FAILURE', 'ERROR'])
const CI_IN_FLIGHT = new Set(['PENDING', 'EXPECTED'])

export function isCIFailing(state: string | null): boolean {
  return CI_FAILING.has(state ?? '')
}

export function isCIInFlight(state: string | null): boolean {
  return CI_IN_FLIGHT.has(state ?? '')
}

/**
 * How long a build may run before the queue calls it stuck. Deliberately several times a normal
 * run (a typical Seerist suite finishes in under ten minutes) so that a slow build is not
 * mistaken for a hung one. Raise it if a repo legitimately runs long jobs.
 */
export const STALLED_BUILD_MINUTES = 30

export function isStalledBuild(pr: ClassifiedPR): boolean {
  return pr.buildMinutes !== null && pr.buildMinutes >= STALLED_BUILD_MINUTES
}

export interface ClassifiedPR {
  number: number
  title: string
  url: string
  author: string
  repo: string
  headRefName: string
  baseRefName: string
  daysOpen: string
  bucket: Bucket
  unresolvedThreads: number
  ciState: string | null
  /** Minutes the still-running part of CI has been going, or null when nothing is running. */
  buildMinutes: number | null
  hasConflicts: boolean
  deployedEnvs: string[]
  version: string | null
  ageMinutes: number
  stack: StackRef | null
  mergeStateStatus: string | null
  reviewDecision: string | null
  headRepo: string
}

// ── Review queue classification (PRs requesting my review) ──

export interface ReviewResult {
  ready: ClassifiedPR[]
  blocked: ClassifiedPR[]
  stacks: StackGroup[]
  skippedCount: number
}

/**
 * Pulls stacked PRs out of the flat buckets so a stack renders once, in order, instead of
 * being scattered across sections by whatever each member's individual CI/review state is.
 */
function partitionStacks<T extends Record<string, ClassifiedPR[]>>(
  buckets: T,
  bucketNames: Array<keyof T>,
  linkOnly: ClassifiedPR[] = [],
): { stacks: StackGroup[]; buckets: T } {
  const all = bucketNames.flatMap((name) => buckets[name])
  const stacks = buildStacks(all, linkOnly)

  const claimed = stackMemberKeys(stacks)
  for (const name of bucketNames) {
    buckets[name] = buckets[name].filter((pr) => !claimed.has(prKey(pr.repo, pr.number))) as T[keyof T]
  }
  return { stacks, buckets }
}

export function classifyReviewPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): ReviewResult {
  const ready: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  // Skipped-but-open PRs still hold their chains together, so they join the stack graph without
  // ever being rendered. Approving the middle of a stack is the common case.
  const linkOnly: ClassifiedPR[] = []
  let skippedCount = 0

  const skip = (pr: SearchPR, detail: PRDetail | null): void => {
    skippedCount++
    if (detail) linkOnly.push(buildClassified(pr, detail, 'skipped'))
  }

  for (const pr of searchResults) {
    const detail = findDetail(pr, detailsByRepo) ?? null

    if (pr.isDraft) { skip(pr, detail); continue }
    if (!detail) { skippedCount++; continue }
    if (detail.viewerReviewState === 'APPROVED') { skip(pr, detail); continue }
    if (isCIInFlight(detail.ciState) || isCIFailing(detail.ciState)) { skip(pr, detail); continue }

    // Conflicts deliberately don't block here: they stop a merge, not a review. They still show
    // as an inline pill on the row so you can see one without switching tabs.
    const classified = buildClassified(pr, detail, detail.unresolvedThreads > 0 ? 'blocked' : 'ready')

    if (classified.bucket === 'ready') ready.push(classified)
    else blocked.push(classified)
  }

  const partitioned = partitionStacks({ ready, blocked }, ['ready', 'blocked'], linkOnly)
  return { ...partitioned.buckets, stacks: partitioned.stacks, skippedCount }
}

// ── My PRs classification ──

export interface MyPRsResult {
  readyToMerge: ClassifiedPR[]
  needsReview: ClassifiedPR[]
  blocked: ClassifiedPR[]
  building: ClassifiedPR[]
  failing: ClassifiedPR[]
  drafts: ClassifiedPR[]
  stacks: StackGroup[]
  recentlyMerged: ClassifiedPR[]
}

export function classifyMyPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): MyPRsResult {
  const readyToMerge: ClassifiedPR[] = []
  const needsReview: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  const building: ClassifiedPR[] = []
  const failing: ClassifiedPR[] = []
  const drafts: ClassifiedPR[] = []

  for (const pr of searchResults) {
    const detail = findDetail(pr, detailsByRepo)

    if (pr.isDraft) {
      drafts.push(buildClassified(pr, detail ?? null, 'draft'))
      continue
    }

    if (!detail) continue

    if (isCIInFlight(detail.ciState)) {
      building.push(buildClassified(pr, detail, 'building'))
      continue
    }

    if (isCIFailing(detail.ciState)) {
      failing.push(buildClassified(pr, detail, 'failing'))
      continue
    }

    if (detail.unresolvedThreads > 0 || detail.mergeable === 'CONFLICTING') {
      blocked.push(buildClassified(pr, detail, 'blocked'))
      continue
    }

    if (detail.reviewDecision === 'APPROVED') {
      readyToMerge.push(buildClassified(pr, detail, 'ready'))
    } else {
      needsReview.push(buildClassified(pr, detail, 'needsReview'))
    }
  }

  const partitioned = partitionStacks(
    { readyToMerge, needsReview, blocked, building, failing, drafts },
    ['readyToMerge', 'needsReview', 'blocked', 'building', 'failing', 'drafts'],
  )
  return { ...partitioned.buckets, stacks: partitioned.stacks, recentlyMerged: [] }
}

export interface PRMergedMetadata {
  envs: string[]
  version: string | null
}

export function classifyMergedPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
  cutoffMs: number,
  metadataByPR: Map<string, PRMergedMetadata>,
): ClassifiedPR[] {
  const merged: ClassifiedPR[] = []
  for (const pr of searchResults) {
    const detail = findDetail(pr, detailsByRepo)
    if (!detail?.mergedAt) continue
    const mergedAtMs = new Date(detail.mergedAt).getTime()
    if (mergedAtMs < cutoffMs) continue

    // Age here is time since merge, not time open — hence the overrides.
    const elapsedMs = Math.max(0, Date.now() - mergedAtMs)
    const meta = metadataByPR.get(`${pr.repo}#${pr.number}`)
    merged.push({
      ...buildClassified(pr, detail, 'merged'),
      daysOpen: formatElapsed(elapsedMs),
      ageMinutes: Math.floor(elapsedMs / 60_000),
      deployedEnvs: meta?.envs ?? [],
      version: meta?.version ?? null,
    })
  }
  merged.sort((a, b) => a.ageMinutes - b.ageMinutes)
  return merged
}

// Mon → previous Fri. Tue–Fri → yesterday. Sat/Sun → previous Fri.
export function lastBusinessDayCutoff(now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  do {
    d.setDate(d.getDate() - 1)
  } while (d.getDay() === 0 || d.getDay() === 6)
  return d
}

// ── Dependabot classification ──

export interface DependabotResult {
  ready: ClassifiedPR[]
  blocked: ClassifiedPR[]
  building: ClassifiedPR[]
  failing: ClassifiedPR[]
}

export function classifyDependabotPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): DependabotResult {
  const ready: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  const building: ClassifiedPR[] = []
  const failing: ClassifiedPR[] = []

  for (const pr of searchResults) {
    if (pr.isDraft) continue

    const detail = findDetail(pr, detailsByRepo)
    if (!detail) continue

    if (isCIInFlight(detail.ciState)) {
      building.push(buildClassified(pr, detail, 'building'))
      continue
    }

    if (isCIFailing(detail.ciState)) {
      failing.push(buildClassified(pr, detail, 'failing'))
      continue
    }

    if (detail.unresolvedThreads > 0 || detail.mergeable === 'CONFLICTING') {
      blocked.push(buildClassified(pr, detail, 'blocked'))
    } else {
      ready.push(buildClassified(pr, detail, 'ready'))
    }
  }

  return { ready, blocked, building, failing }
}

// ── Helpers ──

function findDetail(pr: SearchPR, detailsByRepo: Map<string, PRDetail[]>): PRDetail | undefined {
  return detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
}

function buildClassified(pr: SearchPR, detail: PRDetail | null, bucket: Bucket): ClassifiedPR {
  const age = calcActiveAge(pr.createdAt, detail?.timelineEvents ?? [])
  return {
    number: pr.number,
    title: truncateTitle(pr.title),
    url: pr.url,
    author: pr.author,
    repo: pr.repo,
    headRefName: detail?.headRefName ?? '',
    baseRefName: detail?.baseRefName ?? '',
    daysOpen: age.display,
    ageMinutes: age.minutes,
    bucket,
    unresolvedThreads: detail?.unresolvedThreads ?? 0,
    ciState: detail?.ciState ?? null,
    buildMinutes: elapsedMinutes(detail?.buildStartedAt ?? null),
    hasConflicts: detail?.mergeable === 'CONFLICTING',
    deployedEnvs: [],
    version: null,
    stack: detail?.stack ?? null,
    mergeStateStatus: detail?.mergeStateStatus ?? null,
    reviewDecision: detail?.reviewDecision ?? null,
    headRepo: detail?.headRepo ?? '',
  }
}

function elapsedMinutes(since: string | null): number | null {
  if (!since) return null
  const started = new Date(since).getTime()
  if (Number.isNaN(started)) return null
  return Math.max(0, Math.floor((Date.now() - started) / 60_000))
}

function truncateTitle(title: string): string {
  return title.length > 60 ? title.slice(0, 57) + '...' : title
}

interface TimelineEvent {
  type: 'ReadyForReviewEvent' | 'ConvertToDraftEvent'
  createdAt: string
}

function calcActiveAge(createdAt: string, events: TimelineEvent[]): { display: string; minutes: number } {
  const created = new Date(createdAt).getTime()
  const now = Date.now()

  let draftMs = 0
  let draftStart: number | null = null

  if (events.length > 0 && events[0].type === 'ReadyForReviewEvent') {
    draftStart = created
  }

  for (const event of events) {
    const ts = new Date(event.createdAt).getTime()
    if (event.type === 'ConvertToDraftEvent') {
      draftStart = ts
    } else if (event.type === 'ReadyForReviewEvent' && draftStart !== null) {
      draftMs += ts - draftStart
      draftStart = null
    }
  }

  if (draftStart !== null) {
    draftMs += now - draftStart
  }

  const activeMs = Math.max(0, now - created - draftMs)
  return { display: formatElapsed(activeMs), minutes: Math.floor(activeMs / 60_000) }
}

function formatElapsed(elapsedMs: number): string {
  const mins = Math.floor(elapsedMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(elapsedMs / 3_600_000)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(elapsedMs / 86_400_000)
  return `${days}d`
}

export function groupByRepo(prs: ClassifiedPR[], order: 'asc' | 'desc' = 'desc'): Map<string, ClassifiedPR[]> {
  const groups = new Map<string, ClassifiedPR[]>()
  for (const pr of prs) {
    const list = groups.get(pr.repo) ?? []
    list.push(pr)
    groups.set(pr.repo, list)
  }
  const sorted = new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
  for (const [, list] of sorted) {
    list.sort((a, b) => order === 'asc' ? a.ageMinutes - b.ageMinutes : b.ageMinutes - a.ageMinutes)
  }
  return sorted
}

// ── Filters ──

export function isDependabot(pr: SearchPR): boolean {
  return pr.author === 'dependabot[bot]'
}
