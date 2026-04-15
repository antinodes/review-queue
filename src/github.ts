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
  ciState: string | null
  unresolvedThreads: number
  reviewDecision: string | null
  viewerReviewState: string | null
  timelineEvents: TimelineEvent[]
}

interface TimelineEvent {
  type: 'ReadyForReviewEvent' | 'ConvertToDraftEvent'
  createdAt: string
}

interface GraphQLResponse {
  data?: Record<string, Record<string, RawPRDetail>>
  errors?: Array<{ message: string }>
}

interface RawPRDetail {
  number: number
  headRefName: string
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

function buildPRFragment(number: number): string {
  return `
    pr${number}: pullRequest(number: ${number}) {
      number
      headRefName
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
  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ query: '{ viewer { login } }' }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
  }
  const json = await response.json()
  return json.data.viewer.login
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
      ${fragments}
    }
  }`

  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ query }),
  })

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
  }

  const json: GraphQLResponse = await response.json()
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`)
  }

  const repoData = json.data!.repository
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

    return { number: num, headRefName: pr.headRefName, ciState, unresolvedThreads, reviewDecision: pr.reviewDecision, viewerReviewState, timelineEvents }
  })
}
