import { searchReviewRequested, searchAuthored, fetchPRDetails, fetchViewerLogin } from './github.ts'
import type { SearchPR } from './github.ts'
import { classifyReviewPRs, classifyMyPRs, classifyDependabotPRs, isDependabot } from './classify.ts'
import type { ReviewResult, MyPRsResult, DependabotResult } from './classify.ts'
import { renderSection, renderSummary, renderError } from './render.ts'
import { getToken, saveToken, clearToken } from './token.ts'
import { themes, getTheme, saveTheme, applyTheme } from './themes.ts'
import type { ThemeConfig } from './themes.ts'
import './style.css'

const REFRESH_INTERVAL_MS = 3 * 60 * 1000
const $ = (id: string) => document.getElementById(id)!

let refreshTimer: ReturnType<typeof setInterval> | null = null
let hasLoadedOnce = false
let activeTheme: ThemeConfig = getTheme()
let activeTab: 'reviews' | 'myPRs' | 'dependabot' = 'reviews'

// Cached results for re-rendering on theme/tab switch
let cachedReviews: ReviewResult | null = null
let cachedMyPRs: MyPRsResult | null = null
let cachedDependabot: DependabotResult | null = null

function showTokenPrompt(): void {
  $('token-prompt').classList.remove('hidden')
  $('content').classList.add('hidden')
  $('loading').classList.add('hidden')
  $('error').classList.add('hidden')
}

function hideTokenPrompt(): void {
  $('token-prompt').classList.add('hidden')
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
    renderSection($('reviews-blocked'), r.blocked, t, { showThreads: true })
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
    renderSection($('my-ready'), m.readyToMerge, t, { showAuthor: false })
    renderSection($('my-needsReview'), m.needsReview, t, { showAuthor: false })
    renderSection($('my-blocked'), m.blocked, t, { showThreads: true, showAuthor: false })
    renderSection($('my-building'), m.building, t, { showCI: true, showAuthor: false })
    renderSection($('my-failing'), m.failing, t, { showCI: true, showAuthor: false })
    renderSection($('my-draft'), m.drafts, t, { showAuthor: false })
    const total = m.readyToMerge.length + m.needsReview.length + m.blocked.length + m.building.length + m.failing.length + m.drafts.length
    renderSummary($('my-summary'),
      `${total} open — ${m.readyToMerge.length} ready to merge, ${m.needsReview.length} needs review, ${m.blocked.length} blocked, ${m.building.length} building, ${m.failing.length} failing, ${m.drafts.length} draft`)
  }

  if (activeTab === 'dependabot' && cachedDependabot) {
    const d = cachedDependabot
    setText('dep-ready-h', t.sections.depReady)
    setText('dep-blocked-h', t.sections.depBlocked)
    setText('dep-building-h', t.sections.depBuilding)
    setText('dep-failing-h', t.sections.depFailing)
    renderSection($('dep-ready'), d.ready, t, { showAuthor: false })
    renderSection($('dep-blocked'), d.blocked, t, { showThreads: true, showAuthor: false })
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

async function loadQueue(token: string): Promise<void> {
  $('error').classList.add('hidden')

  if (hasLoadedOnce) {
    $('progress-bar').classList.add('active')
  } else {
    $('loading').classList.remove('hidden')
    $('content').classList.add('hidden')
  }

  try {
    // Fetch review-requested, authored PRs, and viewer login in parallel
    const [reviewPRs, authoredPRs, viewerLogin] = await Promise.all([
      searchReviewRequested(token),
      searchAuthored(token),
      fetchViewerLogin(token),
    ])

    // Split review PRs into human and dependabot
    const humanReviewPRs = reviewPRs.filter((pr) => !isDependabot(pr))
    const dependabotPRs = reviewPRs.filter(isDependabot)

    // Collect all unique PRs for GraphQL batching
    const allPRs = [...reviewPRs, ...authoredPRs]
    const detailsByRepo = await fetchDetails(token, allPRs, viewerLogin)

    cachedReviews = classifyReviewPRs(humanReviewPRs, detailsByRepo)
    cachedMyPRs = classifyMyPRs(authoredPRs, detailsByRepo)
    cachedDependabot = classifyDependabotPRs(dependabotPRs, detailsByRepo)

    $('loading').classList.add('hidden')
    $('progress-bar').classList.remove('active')
    $('content').classList.remove('hidden')
    hasLoadedOnce = true

    renderActiveTab()
    updateTimestamp()
    updateBadge(cachedReviews.ready.length)
  } catch (err) {
    $('loading').classList.add('hidden')
    $('progress-bar').classList.remove('active')
    const message = err instanceof Error ? err.message : 'Unknown error'

    if (message.includes('401')) {
      clearToken()
      renderError($('error'), 'Token expired or invalid. Please re-enter.')
      showTokenPrompt()
      return
    }

    renderError($('error'), `Failed to load PRs: ${message}`, [
      { label: 'Re-enter token', onClick: () => { clearToken(); showTokenPrompt() } },
    ])
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

// Init
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(activeTheme.id)
  initTabs()
  initThemePicker()

  const tokenForm = $('token-form') as HTMLFormElement
  const tokenInput = $('token-input') as HTMLInputElement
  const refreshBtn = $('refresh-btn')
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
    hideTokenPrompt()
    loadQueue(token)
    startAutoRefresh(token)
  })

  refreshBtn.addEventListener('click', () => {
    const token = getToken()
    if (token) loadQueue(token)
  })

  const token = getToken()
  if (token) {
    hideTokenPrompt()
    loadQueue(token)
    startAutoRefresh(token)
  } else {
    showTokenPrompt()
  }
})

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', import.meta.url).href).catch(() => {})
}
