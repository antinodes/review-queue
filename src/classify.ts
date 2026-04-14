import type { SearchPR, PRDetail } from './github.ts'

export type Bucket = 'ready' | 'blocked' | 'skipped'

export interface ClassifiedPR {
  number: number
  title: string
  url: string
  author: string
  repo: string
  daysOpen: string
  bucket: Bucket
  unresolvedThreads: number
}

export function classifyPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): { ready: ClassifiedPR[]; blocked: ClassifiedPR[]; skippedCount: number } {
  const ready: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  let skippedCount = 0

  for (const pr of searchResults) {
    if (pr.isDraft) {
      skippedCount++
      continue
    }

    const repoDetails = detailsByRepo.get(pr.repo)
    const detail = repoDetails?.find((d) => d.number === pr.number)
    if (!detail) {
      skippedCount++
      continue
    }

    if (detail.ciState !== 'SUCCESS') {
      skippedCount++
      continue
    }

    const classified: ClassifiedPR = {
      number: pr.number,
      title: truncateTitle(pr.title),
      url: pr.url,
      author: pr.author,
      repo: pr.repo,
      daysOpen: calcDaysOpen(pr.createdAt, detail.timelineEvents),
      bucket: detail.unresolvedThreads > 0 ? 'blocked' : 'ready',
      unresolvedThreads: detail.unresolvedThreads,
    }

    if (classified.bucket === 'ready') {
      ready.push(classified)
    } else {
      blocked.push(classified)
    }
  }

  return { ready, blocked, skippedCount }
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

  // If the first event is ReadyForReview with no preceding ConvertToDraft,
  // the PR was created as a draft — treat createdAt as draft start.
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

  // If still in draft (shouldn't happen — drafts are filtered), count to now
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
  // Sort repos alphabetically
  const sorted = new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
  // Sort PRs within each repo by days open descending (oldest first)
  for (const [, prs] of sorted) {
    prs.sort((a, b) => parseDays(b) - parseDays(a))
  }
  return sorted
}

function parseDays(pr: ClassifiedPR): number {
  return pr.daysOpen === '<1d' ? 0 : parseInt(pr.daysOpen, 10)
}
