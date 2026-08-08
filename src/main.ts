import { searchReviewRequested, searchAuthored, searchMergedAuthored, fetchPRDetails, fetchRepoDeployments, fetchViewerLogin, isAncestor, isReleaseDeploy, releaseVersion } from './github.ts'
import type { SearchPR, RepoDeployment, PRDetail } from './github.ts'
import { classifyReviewPRs, classifyMyPRs, classifyDependabotPRs, classifyMergedPRs, isDependabot, lastBusinessDayCutoff } from './classify.ts'
import type { ReviewResult, MyPRsResult, DependabotResult, PRMergedMetadata } from './classify.ts'
import { renderSection, renderSummary, renderError } from './render.ts'
import { getToken, saveToken, clearToken } from './token.ts'
import { beginOAuth, handleOAuthCallback, oauthEnabled, patEnabled } from './auth.ts'
import { themes, getTheme, saveTheme, applyTheme } from './themes.ts'
import type { ThemeConfig } from './themes.ts'
import './style.css'

const REFRESH_INTERVAL_MS = 3 * 60 * 1000
const $ = (id: string) => document.getElementById(id)!

let refreshTimer: ReturnType<typeof setInterval> | null = null
let hasLoadedOnce = false
// Bumped on sign-out so in-flight loadQueue calls discard their results.
let sessionEpoch = 0
let activeTheme: ThemeConfig = getTheme()
let activeTab: 'reviews' | 'myPRs' | 'dependabot' = 'reviews'

// Cached results for re-rendering on theme/tab switch
let cachedReviews: ReviewResult | null = null
let cachedMyPRs: MyPRsResult | null = null
let cachedDependabot: DependabotResult | null = null

// Shows the sign-in prompt, revealing the OAuth and/or PAT section per build config.
// Does not clear the error banner, so callers can surface a message alongside it.
function showAuthPrompt(): void {
  $('token-prompt').classList.remove('hidden')
  $('oauth-section').classList.toggle('hidden', !oauthEnabled)
  $('pat-section').classList.toggle('hidden', !patEnabled)
  $('signout-btn').classList.add('hidden')
  $('content').classList.add('hidden')
  $('loading').classList.add('hidden')
}

function hideAuthPrompt(): void {
  $('token-prompt').classList.add('hidden')
  $('signout-btn').classList.remove('hidden')
}

function signOut(): void {
  sessionEpoch++
  clearToken()
  if (refreshTimer) clearInterval(refreshTimer)
  updateBadge(0)
  hasLoadedOnce = false
  cachedReviews = null
  cachedMyPRs = null
  cachedDependabot = null
  $('error').classList.add('hidden')
  showAuthPrompt()
}

// ── Tab switching ──

function switchTab(tab: typeof activeTab): void {
  activeTab = tab
  for (const t of ['reviews', 'myPRs', 'dependabot'] as const) {
    $(`tab-${t}`).classList.toggle('hidden', t !== tab)
  }
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tab)
  })
  renderActiveTab()
}

function renderActiveTab(): void {
  if (!hasLoadedOnce) return
  const t = activeTheme

  if (activeTab === 'reviews' && cachedReviews) {
    const r = cachedReviews
    setText('reviews-ready-h', t.sections.ready)
    setText('reviews-blocked-h', t.sections.blocked)
    renderSection($('reviews-ready'), r.ready, t)
    renderSection($('reviews-blocked'), r.blocked, t, { showBlockReasons: true })
    renderSummary($('reviews-summary'),
      `${r.ready.length} ready, ${r.blocked.length} blocked, ${r.skippedCount} skipped`)
  }

  if (activeTab === 'myPRs' && cachedMyPRs) {
    const m = cachedMyPRs
    setText('my-ready-h', t.sections.readyToMerge)
    setText('my-needsReview-h', t.sections.needsReview)
    setText('my-blocked-h', t.sections.myBlocked)
    setText('my-building-h', t.sections.building)
    setText('my-failing-h', t.sections.failingCI)
    setText('my-draft-h', t.sections.draft)
    setText('my-merged-h', t.sections.recentlyMerged)
    renderSection($('my-ready'), m.readyToMerge, t, { showAuthor: false })
    renderSection($('my-needsReview'), m.needsReview, t, { showAuthor: false })
    renderSection($('my-blocked'), m.blocked, t, { showBlockReasons: true, showAuthor: false })
    renderSection($('my-building'), m.building, t, { showCI: true, showAuthor: false })
    renderSection($('my-failing'), m.failing, t, { showCI: true, showAuthor: false })
    renderSection($('my-draft'), m.drafts, t, { showAuthor: false })
    renderSection($('my-merged'), m.recentlyMerged, t, { showAuthor: false, showBaseBranch: true, showDeployedEnvs: true, showVersion: true, mergedColumn: true })
    const total = m.readyToMerge.length + m.needsReview.length + m.blocked.length + m.building.length + m.failing.length + m.drafts.length
    const mergedSuffix = m.recentlyMerged.length > 0 ? ` · ${m.recentlyMerged.length} recently merged` : ''
    renderSummary($('my-summary'),
      `${total} open — ${m.readyToMerge.length} ready to merge, ${m.needsReview.length} needs review, ${m.blocked.length} blocked, ${m.building.length} building, ${m.failing.length} failing, ${m.drafts.length} draft${mergedSuffix}`)
  }

  if (activeTab === 'dependabot' && cachedDependabot) {
    const d = cachedDependabot
    setText('dep-ready-h', t.sections.depReady)
    setText('dep-blocked-h', t.sections.depBlocked)
    setText('dep-building-h', t.sections.depBuilding)
    setText('dep-failing-h', t.sections.depFailing)
    renderSection($('dep-ready'), d.ready, t, { showAuthor: false })
    renderSection($('dep-blocked'), d.blocked, t, { showBlockReasons: true, showAuthor: false })
    renderSection($('dep-building'), d.building, t, { showCI: true, showAuthor: false })
    renderSection($('dep-failing'), d.failing, t, { showCI: true, showAuthor: false })
    const total = d.ready.length + d.blocked.length + d.building.length + d.failing.length
    renderSummary($('dep-summary'),
      `${total} open — ${d.ready.length} ready, ${d.blocked.length} blocked, ${d.building.length} building, ${d.failing.length} failing`)
  }
}

function setText(id: string, text: string): void {
  $(id).textContent = text
}

// ── Data fetching ──

async function fetchDetails(token: string, prs: SearchPR[], viewerLogin: string): Promise<Map<string, import('./github.ts').PRDetail[]>> {
  const byRepo = new Map<string, number[]>()
  for (const pr of prs) {
    const list = byRepo.get(pr.repo) ?? []
    list.push(pr.number)
    byRepo.set(pr.repo, list)
  }

  const entries = await Promise.all(
    [...byRepo.entries()].map(async ([repo, numbers]) => {
      const details = await fetchPRDetails(token, repo, numbers, viewerLogin)
      return [repo, details] as const
    }),
  )
  return new Map(entries)
}

interface EnvTip { env: string; sha: string; createdAt: string }
interface VersionedDeploy { version: string; sha: string; createdAt: string }

interface RepoReleaseIndex {
  envTips: EnvTip[]
  versionedAsc: VersionedDeploy[]
}

// Ascending order makes the last write per env the newest.
function indexReleases(deploys: RepoDeployment[]): RepoReleaseIndex {
  const releases = deploys
    .filter(isReleaseDeploy)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const latestByEnv = new Map<string, { sha: string; createdAt: string }>()
  for (const d of releases) latestByEnv.set(d.environment, { sha: d.commitOid, createdAt: d.createdAt })

  return {
    envTips: [...latestByEnv.entries()].map(([env, v]) => ({ env, ...v })),
    versionedAsc: releases.flatMap((d) => {
      const version = releaseVersion(d)
      return version ? [{ version, sha: d.commitOid, createdAt: d.createdAt }] : []
    }),
  }
}

type AncestryCheck = (repo: string, base: string, head: string) => Promise<boolean>

async function attributeEnvs(
  repo: string,
  mergeCommitOid: string,
  envTips: EnvTip[],
  check: AncestryCheck,
): Promise<string[]> {
  const hits = await Promise.all(
    envTips.map(async (tip) => (await check(repo, mergeCommitOid, tip.sha)) ? tip : null),
  )
  return hits
    .filter((t): t is EnvTip => t !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => t.env)
}

// Sequential, not parallel: the first hit wins, so later checks would be wasted.
async function firstShippedVersion(
  repo: string,
  mergeCommitOid: string,
  mergedAt: string,
  versionedAsc: VersionedDeploy[],
  check: AncestryCheck,
): Promise<string | null> {
  const seenShas = new Set<string>()
  for (const d of versionedAsc) {
    if (d.createdAt < mergedAt || seenShas.has(d.sha)) continue
    seenShas.add(d.sha)
    if (await check(repo, mergeCommitOid, d.sha)) return d.version
  }
  return null
}

function memoizedAncestryCheck(token: string): AncestryCheck {
  const cache = new Map<string, Promise<boolean>>()
  return (repo, base, head) => {
    const key = `${repo}|${base}|${head}`
    let p = cache.get(key)
    if (!p) {
      p = isAncestor(token, repo, base, head).catch(() => false)
      cache.set(key, p)
    }
    return p
  }
}

// Ancestry-based attribution (not timestamp): rollback/cherry-pick deploys would otherwise false-positive.
async function computePRMetadata(
  token: string,
  mergedPRs: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
  deploymentsByRepo: Map<string, RepoDeployment[]>,
): Promise<Map<string, PRMergedMetadata>> {
  const check = memoizedAncestryCheck(token)
  const indexByRepo = new Map(
    [...deploymentsByRepo].map(([repo, deploys]) => [repo, indexReleases(deploys)] as const),
  )

  const result = new Map<string, PRMergedMetadata>()
  await Promise.all(mergedPRs.map(async (pr) => {
    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail?.mergeCommitOid || !detail.mergedAt) return

    const index = indexByRepo.get(pr.repo) ?? { envTips: [], versionedAsc: [] }
    const [envs, version] = await Promise.all([
      attributeEnvs(pr.repo, detail.mergeCommitOid, index.envTips, check),
      firstShippedVersion(pr.repo, detail.mergeCommitOid, detail.mergedAt, index.versionedAsc, check),
    ])
    result.set(`${pr.repo}#${pr.number}`, { envs, version })
  }))
  return result
}

async function loadQueue(token: string): Promise<void> {
  const epoch = sessionEpoch
  $('error').classList.add('hidden')

  if (hasLoadedOnce) {
    $('progress-bar').classList.add('active')
  } else {
    $('loading').classList.remove('hidden')
    $('content').classList.add('hidden')
  }

  try {
    const cutoff = lastBusinessDayCutoff()
    const [reviewPRs, authoredPRs, mergedPRs, viewerLogin] = await Promise.all([
      searchReviewRequested(token),
      searchAuthored(token),
      searchMergedAuthored(token, cutoff),
      fetchViewerLogin(token),
    ])

    // Split review PRs into human and dependabot
    const humanReviewPRs = reviewPRs.filter((pr) => !isDependabot(pr))
    const dependabotPRs = reviewPRs.filter(isDependabot)

    // Collect all unique PRs for GraphQL batching
    const allPRs = [...reviewPRs, ...authoredPRs, ...mergedPRs]
    const detailsByRepo = await fetchDetails(token, allPRs, viewerLogin)

    const mergedRepos = [...new Set(mergedPRs.map((p) => p.repo))]
    const deploymentsByRepo = new Map<string, RepoDeployment[]>(
      await Promise.all(
        mergedRepos.map(async (repo) => {
          try { return [repo, await fetchRepoDeployments(token, repo, cutoff.getTime())] as const }
          catch (err) {
            console.warn(`Failed to fetch deployments for ${repo}:`, err)
            return [repo, [] as RepoDeployment[]] as const
          }
        }),
      ),
    )
    const metadataByPR = await computePRMetadata(token, mergedPRs, detailsByRepo, deploymentsByRepo)

    $('loading').classList.add('hidden')
    $('progress-bar').classList.remove('active')
    if (epoch !== sessionEpoch) return // signed out mid-fetch — discard

    cachedReviews = classifyReviewPRs(humanReviewPRs, detailsByRepo)
    cachedMyPRs = classifyMyPRs(authoredPRs, detailsByRepo)
    cachedMyPRs.recentlyMerged = classifyMergedPRs(mergedPRs, detailsByRepo, cutoff.getTime(), metadataByPR)
    cachedDependabot = classifyDependabotPRs(dependabotPRs, detailsByRepo)

    $('content').classList.remove('hidden')
    hasLoadedOnce = true

    renderActiveTab()
    updateTimestamp()
    updateBadge(cachedReviews.ready.length)
  } catch (err) {
    $('loading').classList.add('hidden')
    $('progress-bar').classList.remove('active')
    if (epoch !== sessionEpoch) return // signed out mid-fetch — discard
    const message = err instanceof Error ? err.message : 'Unknown error'

    if (message.includes('401')) {
      signOut()
      renderError($('error'), 'Session expired — sign in again.')
      return
    }

    renderError($('error'), `Failed to load PRs: ${message}`, [
      { label: oauthEnabled ? 'Sign in again' : 'Re-enter token', onClick: signOut },
    ])
    // With no content on screen the toolbar (refresh/sign-out) is hidden too;
    // re-show the prompt so the user has a way to retry.
    if (!hasLoadedOnce) showAuthPrompt()
  }
}

function updateTimestamp(): void {
  const now = new Date()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  $('last-updated').textContent = `Updated ${time}`
}

function updateBadge(count: number): void {
  if ('setAppBadge' in navigator) {
    if (count > 0) navigator.setAppBadge(count)
    else navigator.clearAppBadge()
  }
}

function startAutoRefresh(token: string): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => loadQueue(token), REFRESH_INTERVAL_MS)
}

// ── UI init ──

function initTabs(): void {
  const bar = $('tab-bar')
  for (const [key, label] of [
    ['reviews', activeTheme.tabs.reviews],
    ['myPRs', activeTheme.tabs.myPRs],
    ['dependabot', activeTheme.tabs.dependabot],
  ] as const) {
    const btn = document.createElement('button')
    btn.className = `tab-btn ${key === activeTab ? 'active' : ''}`
    btn.dataset.tab = key
    btn.textContent = label
    btn.addEventListener('click', () => switchTab(key as typeof activeTab))
    bar.appendChild(btn)
  }
}

function updateTabLabels(): void {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const tab = (btn as HTMLElement).dataset.tab as keyof typeof activeTheme.tabs
    if (tab && activeTheme.tabs[tab]) btn.textContent = activeTheme.tabs[tab]
  })
}

function initThemePicker(): void {
  const picker = $('theme-picker')
  for (const theme of Object.values(themes)) {
    const btn = document.createElement('button')
    btn.className = `theme-btn ${theme.id === activeTheme.id ? 'active' : ''}`
    btn.dataset.theme = theme.id
    btn.textContent = theme.label
    btn.addEventListener('click', () => {
      activeTheme = themes[theme.id]
      saveTheme(theme.id)
      document.querySelectorAll('.theme-btn').forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.theme === theme.id)
      })
      updateTabLabels()
      renderActiveTab()
    })
    picker.appendChild(btn)
  }
}

// The one path into a signed-in session, whatever produced the token.
function enterApp(token: string): void {
  hideAuthPrompt()
  loadQueue(token)
  startAutoRefresh(token)
}

// Runs the OAuth callback (if this load is one), then loads the queue or shows
// the prompt. Callback handling must precede the token check so a fresh sign-in
// is picked up on the same page load.
async function startup(): Promise<void> {
  try {
    const oauthToken = await handleOAuthCallback()
    if (oauthToken) saveToken(oauthToken)
  } catch (err) {
    renderError($('error'), err instanceof Error ? err.message : 'Sign-in failed')
  }

  const token = getToken()
  if (token) enterApp(token)
  else showAuthPrompt()
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(activeTheme.id)
  initTabs()
  initThemePicker()

  const refreshBtn = $('refresh-btn')
  const signinBtn = $('signin-btn')
  const signoutBtn = $('signout-btn')

  signinBtn.addEventListener('click', beginOAuth)
  signoutBtn.addEventListener('click', signOut)

  if (patEnabled) {
    const tokenForm = $('token-form') as HTMLFormElement
    const tokenInput = $('token-input') as HTMLInputElement
    const createTokenLink = $('create-token-link') as HTMLAnchorElement
    const tokenInfoBtn = $('token-info-btn')
    const tokenInfo = $('token-info')

    createTokenLink.href = 'https://github.com/settings/tokens/new?scopes=repo&description=Review+Queue'
    tokenInfoBtn.addEventListener('click', () => tokenInfo.classList.toggle('hidden'))

    tokenForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const token = tokenInput.value.trim()
      if (!token) return
      saveToken(token)
      tokenInput.value = ''
      enterApp(token)
    })
  }

  refreshBtn.addEventListener('click', () => {
    const token = getToken()
    if (token) loadQueue(token)
  })

  startup()
})

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', import.meta.url).href).catch(() => {})
}
