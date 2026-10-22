const SEARCH_API = 'https://api.github.com/search/issues'
const GRAPHQL_API = 'https://api.github.com/graphql'
const MAX_CONCURRENT_REQUESTS = 4
const PRS_PER_QUERY = 5
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000

export class RateLimitError extends Error {
  readonly retryAt: number
  constructor(retryAt: number) {
    super('GitHub rate limit exceeded')
    this.retryAt = retryAt
  }
}

export interface SearchPR {
  number: number
  title: string
  url: string
  createdAt: string
  isDraft: boolean
  author: string
  repo: string
}

export interface PRDetail {
  number: number
  headRefName: string
  baseRefName: string
  mergedAt: string | null
  mergeCommitOid: string | null
  ciState: string | null
  unresolvedThreads: number
  reviewDecision: string | null
  viewerReviewState: string | null
  timelineEvents: TimelineEvent[]
  /** Null unless the PR belongs to a native GitHub stack (public preview, same-repo only). */
  stack: StackRef | null
  /** When the still-running part of CI kicked off, for spotting a build that has hung. */
  buildStartedAt: string | null
  /** BEHIND means the head branch needs a restack. UNKNOWN on a cold PR — GitHub computes it lazily. */
  mergeStateStatus: string | null
  /**
   * CONFLICTING | MERGEABLE | UNKNOWN. Kept alongside mergeStateStatus because that field is a
   * single enum: a conflicted draft reports DRAFT and would hide the conflict. This one doesn't.
   */
  mergeable: string | null
  /**
   * Owner/name of the repo the head branch lives in. On a fork this differs from the PR's own
   * repo, and fork head branches are routinely named `main` or `patch-1`, so anything keyed on a
   * bare branch name has to qualify it with this or it will collide.
   */
  headRepo: string
}

export interface StackRef {
  /** Stable per-repo stack identifier — also what `gh stack checkout` accepts. */
  number: number
  size: number
  /** 1 is closest to the base branch. */
  position: number
  /** Every rung GitHub knows about, merged ones included, ascending by position. */
  entries: StackEntry[]
}

export interface StackEntry {
  position: number
  number: number
  /** A merged or closed rung is settled: nothing above it is still waiting on it. */
  settled: boolean
}

export interface RepoDeployment {
  environment: string
  state: string
  createdAt: string
  commitOid: string
  refName: string | null
  description: string | null
}

// Successful states include INACTIVE: a previously-successful deploy that was superseded.
const SUCCESS_STATES = new Set(['SUCCESS', 'ACTIVE', 'INACTIVE'])

// Preview deploys land in real envs and contain main, so they would attribute every recent PR.
// Both repos mark them in the description, e.g. "v1.2.3-pr45.abc1234".
const PR_DEPLOY_RE = /-pr\d+\b|\(PR #\d+\)/i

export function isReleaseDeploy(d: RepoDeployment): boolean {
  return SUCCESS_STATES.has(d.state) && !PR_DEPLOY_RE.test(d.description ?? '')
}

// One repo tags the ref with the version; the other deploys a raw SHA and carries
// the version only in the description. Check the ref first, then fall back.
const SEMVER_RE = /\bv\d+\.\d+\.\d+\S*/

export function releaseVersion(d: RepoDeployment): string | null {
  return SEMVER_RE.exec(d.refName ?? '')?.[0] ?? SEMVER_RE.exec(d.description ?? '')?.[0] ?? null
}

interface DeploymentsResponse {
  data?: {
    repository?: {
      deployments?: {
        pageInfo: { startCursor: string | null; hasPreviousPage: boolean }
        nodes: RawDeployment[]
      }
    }
  }
}

interface RawDeployment {
  environment: string | null
  createdAt: string
  commitOid: string
  description: string | null
  ref: { name: string } | null
  latestStatus: { state: string } | null
}

interface TimelineEvent {
  type: 'ReadyForReviewEvent' | 'ConvertToDraftEvent'
  createdAt: string
}

interface GraphQLError {
  message: string
  type?: string
}

interface GraphQLResult<D> {
  data?: D
  errors?: GraphQLError[]
}

// Fields marked optional are skipped by the slim fragment used for merged PRs.
interface RawPRDetail {
  number: number
  headRefName: string
  baseRefName: string
  mergedAt: string | null
  mergeCommit: { oid: string } | null
  ciStatus?: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: string } | null
        checkSuites: {
          nodes: Array<{ status: string; createdAt: string; checkRuns: { totalCount: number } }>
        }
      }
    }>
  }
  reviewDecision?: string | null
  latestOpinionatedReviews?: {
    nodes: Array<{ author: { login: string }; state: string }>
  }
  reviewThreads?: {
    nodes: Array<{ isResolved: boolean }>
  }
  timelineItems?: {
    nodes: Array<{ __typename: string; createdAt: string }>
  }
  stack?: {
    number: number
    size: number
    entries: { nodes: Array<{ position: number; pullRequest: { number: number; merged: boolean; closed: boolean } }> }
  } | null
  stackEntry?: { position: number } | null
  mergeStateStatus?: string | null
  mergeable?: string | null
  headRepository: { nameWithOwner: string } | null
}

let inFlight = 0
const waiting: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_REQUESTS) {
    inFlight++
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function releaseSlot(): void {
  const next = waiting.shift()
  if (next) next()
  else inFlight--
}

function retryAtFrom(response: Response): number {
  const retryAfterSec = Number(response.headers.get('retry-after'))
  if (retryAfterSec > 0) return Date.now() + retryAfterSec * 1000
  const resetSec = Number(response.headers.get('x-ratelimit-reset'))
  if (response.headers.get('x-ratelimit-remaining') === '0' && resetSec > 0) return resetSec * 1000
  return Date.now() + DEFAULT_BACKOFF_MS
}

async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  if (response.headers.get('x-ratelimit-remaining') === '0') return true
  return /rate limit/i.test(await response.clone().text())
}

async function apiFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  await acquireSlot()
  try {
    const response = await fetch(url, { ...init, headers: headers(token) })
    if (!response.ok && await isRateLimited(response)) throw new RateLimitError(retryAtFrom(response))
    return response
  } catch (err) {
    // Secondary-limit responses carry no CORS headers, so the browser reports them as a network failure.
    if (err instanceof TypeError) throw new RateLimitError(Date.now() + DEFAULT_BACKOFF_MS)
    throw err
  } finally {
    releaseSlot()
  }
}

async function graphqlPartial<D>(token: string, query: string, variables?: Record<string, unknown>): Promise<GraphQLResult<D>> {
  const response = await apiFetch(token, GRAPHQL_API, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
  }
  const json: GraphQLResult<D> = await response.json()
  if (json.errors?.some((e) => e.type === 'RATE_LIMITED')) throw new RateLimitError(Date.now() + DEFAULT_BACKOFF_MS)
  return json
}

async function graphql<T>(token: string, query: string): Promise<T> {
  const json = await graphqlPartial<unknown>(token, query)
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`)
  }
  return json as T
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function searchPRs(token: string, query: string): Promise<SearchPR[]> {
  const q = encodeURIComponent(query)
  const response = await apiFetch(token, `${SEARCH_API}?q=${q}&per_page=100&sort=created&order=desc`)
  if (!response.ok) {
    throw new Error(`GitHub search failed: ${response.status} ${response.statusText}`)
  }
  const data = await response.json()

  return data.items.map((item: Record<string, unknown>) => {
    const repo = (item.repository_url as string).replace('https://api.github.com/repos/', '')
    const user = item.user as Record<string, unknown>
    return {
      number: item.number as number,
      title: item.title as string,
      url: item.html_url as string,
      createdAt: item.created_at as string,
      isDraft: (item.draft as boolean) ?? false,
      author: user.login as string,
      repo,
    }
  })
}

export function searchReviewRequested(token: string): Promise<SearchPR[]> {
  return searchPRs(token, 'is:pr is:open review-requested:@me')
}

export function searchAuthored(token: string): Promise<SearchPR[]> {
  return searchPRs(token, 'is:pr is:open author:@me')
}

// Local date parts, not toISOString: the cutoff is local midnight and must not shift by timezone.
function toLocalIsoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// GitHub reads merged:>=YYYY-MM-DD as UTC, so pad a day back and let the caller cut precisely.
export function searchMergedAuthored(token: string, cutoff: Date): Promise<SearchPR[]> {
  const sinceDate = toLocalIsoDate(new Date(cutoff.getTime() - 86_400_000))
  return searchPRs(token, `is:pr is:merged author:@me merged:>=${sinceDate}`)
}

function buildPRFragment(number: number): string {
  return `
    pr${number}: pullRequest(number: ${number}) {
      number
      headRefName
      baseRefName
      mergedAt
      mergeCommit { oid }
      headRepository { nameWithOwner }
      ... on PullRequest @include(if: $full) {
        reviewDecision
        ciStatus: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
              # Suites with zero runs are apps installed on the repo that never report (they sit
              # QUEUED forever), so only suites holding actual runs say when a build started.
              checkSuites(first: 10) {
                nodes { status createdAt checkRuns(first: 1) { totalCount } }
              }
            }
          }
        }
        latestOpinionatedReviews(first: 20) {
          nodes { author { login } state }
        }
        reviewThreads(first: 100) {
          nodes { isResolved }
        }
        timelineItems(first: 50, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) {
          nodes {
            __typename
            ... on ReadyForReviewEvent { createdAt }
            ... on ConvertToDraftEvent { createdAt }
          }
        }
        mergeStateStatus
        mergeable
        stack {
          number
          size
          # Entries keep merged rungs at their original positions, so size/position arithmetic
          # alone can't say what is still below you. Read the entries instead.
          entries(first: 50) {
            nodes { position pullRequest { number merged closed } }
          }
        }
        stackEntry { position }
      }
    }`
}

export async function fetchViewerLogin(token: string): Promise<string> {
  const json = await graphql<{ data: { viewer: { login: string } } }>(token, '{ viewer { login } }')
  return json.data.viewer.login
}

// GitHub's compare status: "ahead"/"identical" → head contains base; "behind"/"diverged" → it does not.
export async function isAncestor(token: string, repo: string, base: string, head: string): Promise<boolean> {
  if (base === head) return true
  const [owner, name] = repo.split('/')
  const response = await apiFetch(token, `https://api.github.com/repos/${owner}/${name}/compare/${base}...${head}`)
  if (!response.ok) throw new Error(`Compare failed: ${response.status} ${response.statusText}`)
  const data = await response.json()
  return data.status === 'ahead' || data.status === 'identical'
}

export async function fetchRepoDeployments(token: string, repo: string, sinceMs: number): Promise<RepoDeployment[]> {
  const [owner, name] = repo.split('/')
  const out: RepoDeployment[] = []
  let before: string | null = null
  for (let i = 0; i < 10; i++) {
    const beforeArg: string = before ? `, before: "${before}"` : ''
    const query = `query {
      repository(owner: "${owner}", name: "${name}") {
        deployments(last: 100${beforeArg}) {
          pageInfo { startCursor hasPreviousPage }
          nodes { environment createdAt commitOid description ref { name } latestStatus { state } }
        }
      }
    }`
    const json = await graphql<DeploymentsResponse>(token, query)
    const deployments = json.data?.repository?.deployments
    const nodes: RawDeployment[] = deployments?.nodes ?? []
    for (const n of nodes) {
      if (!n.environment || !n.latestStatus) continue
      out.push({
        environment: n.environment,
        state: n.latestStatus.state,
        createdAt: n.createdAt,
        commitOid: n.commitOid,
        refName: n.ref?.name ?? null,
        description: n.description ?? null,
      })
    }
    const oldest = nodes.length > 0 ? new Date(nodes[0].createdAt).getTime() : Number.POSITIVE_INFINITY
    if (oldest < sinceMs || !deployments?.pageInfo?.hasPreviousPage) break
    before = deployments.pageInfo.startCursor
  }
  return out
}

// Oldest suite that is still going and has runs in it. Empty suites are ignored: several apps
// register a suite per push and leave it QUEUED forever, which would read as a hung build.
function earliestRunningSuite(
  suites: Array<{ status: string; createdAt: string; checkRuns: { totalCount: number } }>,
): string | null {
  const running = suites
    .filter((s) => s.status !== 'COMPLETED' && s.checkRuns.totalCount > 0)
    .map((s) => s.createdAt)
    .sort()
  return running[0] ?? null
}

type RepoPRData = Partial<Record<`pr${number}`, RawPRDetail>>

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
}

async function fetchRepoPRs(token: string, repo: string, prNumbers: number[], full: boolean): Promise<RepoPRData> {
  const parts = await Promise.all(chunk(prNumbers, PRS_PER_QUERY).map((c) => fetchPRChunk(token, repo, c, full)))
  return Object.assign({}, ...parts)
}

// Resource limits are per query, so a batch that trips them is halved until each PR stands alone.
async function fetchPRChunk(token: string, repo: string, prNumbers: number[], full: boolean): Promise<RepoPRData> {
  const [owner, name] = repo.split('/')
  const query = `query($full: Boolean!) {
    repository(owner: "${owner}", name: "${name}") {
      ${prNumbers.map(buildPRFragment).join('\n')}
    }
  }`
  const json = await graphqlPartial<{ repository: RepoPRData | null }>(token, query, { full })
  const data = json.data?.repository ?? {}
  const missing = prNumbers.filter((n) => !data[`pr${n}`])
  if (missing.length === 0) return data

  const resourceLimited = json.errors?.some((e) => /resource limits/i.test(e.message)) ?? false
  if (!resourceLimited || prNumbers.length === 1) {
    console.warn(`Skipping ${repo} PRs ${missing.join(', ')}:`, json.errors)
    return data
  }
  const half = Math.ceil(missing.length / 2)
  const retried = await Promise.all(
    [missing.slice(0, half), missing.slice(half)]
      .filter((c) => c.length > 0)
      .map((c) => fetchPRChunk(token, repo, c, full)),
  )
  return Object.assign(data, ...retried)
}

// `full: false` is for merged PRs, which only need merge facts, not CI, reviews, or stacks.
export async function fetchPRDetails(
  token: string,
  repo: string,
  prNumbers: number[],
  viewerLogin: string | undefined,
  full: boolean,
): Promise<PRDetail[]> {
  const repoData = await fetchRepoPRs(token, repo, prNumbers, full)

  // GitHub computes mergeability lazily and answers UNKNOWN while it works, so a cold PR's
  // conflicts are invisible on first load. Asking a second time settles it; one retry is enough.
  const unknown = prNumbers.filter((n) => repoData[`pr${n}`]?.mergeable === 'UNKNOWN')
  if (unknown.length > 0) {
    try {
      const retried = await fetchRepoPRs(token, repo, unknown, full)
      for (const n of unknown) {
        if (retried[`pr${n}`]) repoData[`pr${n}`] = retried[`pr${n}`]
      }
    } catch {
      // A failed retry just leaves the UNKNOWN reading in place — never fail the whole refresh.
    }
  }

  return prNumbers.flatMap((num) => {
    const pr = repoData[`pr${num}`]
    return pr ? [toPRDetail(num, pr, viewerLogin)] : []
  })
}

function toPRDetail(num: number, pr: RawPRDetail, viewerLogin: string | undefined): PRDetail {
  const commitNode = pr.ciStatus?.nodes[0]
  const ciState = commitNode?.commit?.statusCheckRollup?.state ?? null
  const buildStartedAt = earliestRunningSuite(commitNode?.commit?.checkSuites?.nodes ?? [])
  const unresolvedThreads = pr.reviewThreads?.nodes.filter((t) => !t.isResolved).length ?? 0

  const timelineEvents: TimelineEvent[] = (pr.timelineItems?.nodes ?? []).map((n) => ({
    type: n.__typename as TimelineEvent['type'],
    createdAt: n.createdAt,
  }))

  const viewerReview = viewerLogin
    ? pr.latestOpinionatedReviews?.nodes.find((r) => r.author.login === viewerLogin)
    : undefined
  const viewerReviewState = viewerReview?.state ?? null

  // Both halves are needed: stack carries size and entries, stackEntry carries this PR's slot.
  const stack: StackRef | null = pr.stack && pr.stackEntry
    ? {
        number: pr.stack.number,
        size: pr.stack.size,
        position: pr.stackEntry.position,
        entries: pr.stack.entries.nodes
          .map((e) => ({
            position: e.position,
            number: e.pullRequest.number,
            settled: e.pullRequest.merged || e.pullRequest.closed,
          }))
          .sort((a, b) => a.position - b.position),
      }
    : null

  return { number: num, headRefName: pr.headRefName, baseRefName: pr.baseRefName, mergedAt: pr.mergedAt, mergeCommitOid: pr.mergeCommit?.oid ?? null, ciState, unresolvedThreads, reviewDecision: pr.reviewDecision ?? null, viewerReviewState, timelineEvents, stack, buildStartedAt, mergeStateStatus: pr.mergeStateStatus ?? null, mergeable: pr.mergeable ?? null, headRepo: pr.headRepository?.nameWithOwner ?? '' }
}
