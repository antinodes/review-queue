import type { SearchPR, PRDetail } from './github.ts'

export type Bucket = 'ready' | 'blocked' | 'skipped' | 'failing' | 'needsReview' | 'draft'

export interface ClassifiedPR {
  number: number
  title: string
  url: string
  author: string
  repo: string
  daysOpen: string
  bucket: Bucket
  unresolvedThreads: number
  ciState: string | null
}

// ── Review queue classification (PRs requesting my review) ──

export interface ReviewResult {
  ready: ClassifiedPR[]
  blocked: ClassifiedPR[]
  skippedCount: number
}

export function classifyReviewPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): ReviewResult {
  const ready: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  let skippedCount = 0

  for (const pr of searchResults) {
    if (pr.isDraft) { skippedCount++; continue }

    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail) { skippedCount++; continue }
    if (detail.viewerReviewState === 'APPROVED') { skippedCount++; continue }
    if (detail.ciState !== 'SUCCESS') { skippedCount++; continue }

    const classified = buildClassified(pr, detail, detail.unresolvedThreads > 0 ? 'blocked' : 'ready')

    if (classified.bucket === 'ready') ready.push(classified)
    else blocked.push(classified)
  }

  return { ready, blocked, skippedCount }
}

// ── My PRs classification ──

export interface MyPRsResult {
  readyToMerge: ClassifiedPR[]
  needsReview: ClassifiedPR[]
  blocked: ClassifiedPR[]
  failing: ClassifiedPR[]
  drafts: ClassifiedPR[]
}

export function classifyMyPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): MyPRsResult {
  const readyToMerge: ClassifiedPR[] = []
  const needsReview: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  const failing: ClassifiedPR[] = []
  const drafts: ClassifiedPR[] = []

  for (const pr of searchResults) {
    if (pr.isDraft) {
      drafts.push(buildClassified(pr, null, 'draft'))
      continue
    }

    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail) continue

    if (detail.ciState !== 'SUCCESS') {
      failing.push(buildClassified(pr, detail, 'failing'))
      continue
    }

    if (detail.unresolvedThreads > 0) {
      blocked.push(buildClassified(pr, detail, 'blocked'))
      continue
    }

    if (detail.reviewDecision === 'APPROVED') {
      readyToMerge.push(buildClassified(pr, detail, 'ready'))
    } else {
      needsReview.push(buildClassified(pr, detail, 'needsReview'))
    }
  }

  return { readyToMerge, needsReview, blocked, failing, drafts }
}

// ── Dependabot classification ──

export interface DependabotResult {
  ready: ClassifiedPR[]
  blocked: ClassifiedPR[]
  failing: ClassifiedPR[]
}

export function classifyDependabotPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): DependabotResult {
  const ready: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  const failing: ClassifiedPR[] = []

  for (const pr of searchResults) {
    if (pr.isDraft) continue

    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail) continue

    if (detail.ciState !== 'SUCCESS') {
      failing.push(buildClassified(pr, detail, 'failing'))
      continue
    }

    if (detail.unresolvedThreads > 0) {
      blocked.push(buildClassified(pr, detail, 'blocked'))
    } else {
      ready.push(buildClassified(pr, detail, 'ready'))
    }
  }

  return { ready, blocked, failing }
}

// ── Helpers ──

function buildClassified(pr: SearchPR, detail: PRDetail | null, bucket: Bucket): ClassifiedPR {
  return {
    number: pr.number,
    title: truncateTitle(pr.title),
    url: pr.url,
    author: pr.author,
    repo: pr.repo,
    daysOpen: calcDaysOpen(pr.createdAt, detail?.timelineEvents ?? []),
    bucket,
    unresolvedThreads: detail?.unresolvedThreads ?? 0,
    ciState: detail?.ciState ?? null,
  }
}

function truncateTitle(title: string): string {
  return title.length > 60 ? title.slice(0, 57) + '...' : title
}

interface TimelineEvent {
  type: 'ReadyForReviewEvent' | 'ConvertToDraftEvent'
  createdAt: string
}

function calcDaysOpen(createdAt: string, events: TimelineEvent[]): string {
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

  const activeMs = now - created - draftMs
  const activeDays = Math.floor(activeMs / 86_400_000)
  return activeDays < 1 ? '<1d' : `${activeDays}d`
}

export function groupByRepo(prs: ClassifiedPR[]): Map<string, ClassifiedPR[]> {
  const groups = new Map<string, ClassifiedPR[]>()
  for (const pr of prs) {
    const list = groups.get(pr.repo) ?? []
    list.push(pr)
    groups.set(pr.repo, list)
  }
  const sorted = new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
  for (const [, list] of sorted) {
    list.sort((a, b) => parseDays(b) - parseDays(a))
  }
  return sorted
}

function parseDays(pr: ClassifiedPR): number {
  return pr.daysOpen === '<1d' ? 0 : parseInt(pr.daysOpen, 10)
}

// ── Filters ──

export function isDependabot(pr: SearchPR): boolean {
  return pr.author === 'dependabot[bot]'
}
