const SEARCH_API = 'https://api.github.com/search/issues'
const GRAPHQL_API = 'https://api.github.com/graphql'

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
  defaultBranchName: string
  mergedAt: string | null
  mergeCommitOid: string | null
  mergeable: string | null
  ciState: string | null
  unresolvedThreads: number
  reviewDecision: string | null
  viewerReviewState: string | null
  timelineEvents: TimelineEvent[]
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

interface GraphQLResponse {
  data?: {
    repository: {
      defaultBranchRef: { name: string } | null
      [alias: `pr${number}`]: RawPRDetail
    }
  }
  errors?: Array<{ message: string }>
}

interface RawPRDetail {
  number: number
  headRefName: string
  baseRefName: string
  mergedAt: string | null
  mergeCommit: { oid: string } | null
  mergeable: string | null
  ciStatus: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: string } | null
      }
    }>
  }
  reviewDecision: string | null
  latestOpinionatedReviews: {
    nodes: Array<{ author: { login: string }; state: string }>
  }
  reviewThreads: {
    nodes: Array<{ isResolved: boolean }>
  }
  timelineItems: {
    nodes: Array<{ __typename: string; createdAt: string }>
  }
}

async function graphql<T>(token: string, query: string): Promise<T> {
  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ query }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
  }
  const json = await response.json()
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e: { message: string }) => e.message).join(', ')}`)
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
  const response = await fetch(
    `${SEARCH_API}?q=${q}&per_page=100&sort=created&order=desc`,
    { headers: headers(token) },
  )
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
      mergeable
      reviewDecision
      ciStatus: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup { state }
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
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${name}/compare/${base}...${head}`,
    { headers: headers(token) },
  )
  if (!response.ok) return false
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

export async function fetchPRDetails(
  token: string,
  repo: string,
  prNumbers: number[],
  viewerLogin?: string,
): Promise<PRDetail[]> {
  const [owner, name] = repo.split('/')
  const fragments = prNumbers.map(buildPRFragment).join('\n')
  const query = `query {
    repository(owner: "${owner}", name: "${name}") {
      defaultBranchRef { name }
      ${fragments}
    }
  }`

  const json = await graphql<GraphQLResponse>(token, query)

  const repoData = json.data!.repository
  const defaultBranchName = repoData.defaultBranchRef?.name ?? ''
  return prNumbers.map((num) => {
    const pr = repoData[`pr${num}`]
    const commitNode = pr.ciStatus.nodes[0]
    const ciState = commitNode?.commit?.statusCheckRollup?.state ?? null
    const unresolvedThreads = pr.reviewThreads.nodes.filter((t) => !t.isResolved).length

    const timelineEvents: TimelineEvent[] = pr.timelineItems.nodes.map((n) => ({
      type: n.__typename as TimelineEvent['type'],
      createdAt: n.createdAt,
    }))

    const viewerReview = viewerLogin
      ? pr.latestOpinionatedReviews.nodes.find((r) => r.author.login === viewerLogin)
      : undefined
    const viewerReviewState = viewerReview?.state ?? null

    return { number: num, headRefName: pr.headRefName, baseRefName: pr.baseRefName, defaultBranchName, mergedAt: pr.mergedAt, mergeCommitOid: pr.mergeCommit?.oid ?? null, mergeable: pr.mergeable, ciState, unresolvedThreads, reviewDecision: pr.reviewDecision, viewerReviewState, timelineEvents }
  })
}
