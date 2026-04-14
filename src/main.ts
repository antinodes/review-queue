import { searchReviewRequested, fetchPRDetails } from './github.ts'
import { classifyPRs } from './classify.ts'
import { renderSection, renderSectionHeading, renderSummary, renderError } from './render.ts'
import { getToken, saveToken, clearToken } from './token.ts'
import { themes, getTheme, saveTheme, applyTheme } from './themes.ts'
import type { ThemeConfig } from './themes.ts'
import './style.css'

const REFRESH_INTERVAL_MS = 3 * 60 * 1000

const $ = (id: string) => document.getElementById(id)!

let refreshTimer: ReturnType<typeof setInterval> | null = null
let hasLoadedOnce = false
let activeTheme: ThemeConfig = getTheme()

// Cache last load results for re-rendering on theme switch
let lastReady: import('./classify.ts').ClassifiedPR[] = []
let lastBlocked: import('./classify.ts').ClassifiedPR[] = []
let lastSkipped = 0

function showTokenPrompt(): void {
  $('token-prompt').classList.remove('hidden')
  $('content').classList.add('hidden')
  $('loading').classList.add('hidden')
  $('error').classList.add('hidden')
}

function hideTokenPrompt(): void {
  $('token-prompt').classList.add('hidden')
}

function applyThemeToUI(): void {
  renderSectionHeading($('ready-section'), activeTheme.sectionReady)
  renderSectionHeading($('blocked-section'), activeTheme.sectionBlocked)

  if (hasLoadedOnce) {
    renderSection($('ready-list'), lastReady, false, activeTheme)
    renderSection($('blocked-list'), lastBlocked, true, activeTheme)
    renderSummary($('summary'), activeTheme.summaryFn(lastReady.length, lastBlocked.length, lastSkipped))
  }

  // Update active state on picker buttons
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.theme === activeTheme.id)
  })
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
    const prs = await searchReviewRequested(token)

    const byRepo = new Map<string, number[]>()
    for (const pr of prs) {
      if (pr.isDraft) continue
      const list = byRepo.get(pr.repo) ?? []
      list.push(pr.number)
      byRepo.set(pr.repo, list)
    }

    const detailEntries = await Promise.all(
      [...byRepo.entries()].map(async ([repo, numbers]) => {
        const details = await fetchPRDetails(token, repo, numbers)
        return [repo, details] as const
      }),
    )
    const detailsByRepo = new Map(detailEntries)

    const { ready, blocked, skippedCount } = classifyPRs(prs, detailsByRepo)

    lastReady = ready
    lastBlocked = blocked
    lastSkipped = skippedCount

    renderSection($('ready-list'), ready, false, activeTheme)
    renderSection($('blocked-list'), blocked, true, activeTheme)
    renderSummary($('summary'), activeTheme.summaryFn(ready.length, blocked.length, skippedCount))

    $('loading').classList.add('hidden')
    $('progress-bar').classList.remove('active')
    $('content').classList.remove('hidden')
    hasLoadedOnce = true

    updateTimestamp()
    updateBadge(ready.length)
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

    renderError($('error'), `Failed to load PRs: ${message}`)
  }
}

function updateTimestamp(): void {
  const now = new Date()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  $('last-updated').textContent = `Updated ${time}`
}

function updateBadge(count: number): void {
  if ('setAppBadge' in navigator) {
    if (count > 0) {
      navigator.setAppBadge(count)
    } else {
      navigator.clearAppBadge()
    }
  }
}

function startAutoRefresh(token: string): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => loadQueue(token), REFRESH_INTERVAL_MS)
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
      applyThemeToUI()
    })
    picker.appendChild(btn)
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(activeTheme.id)
  initThemePicker()
  applyThemeToUI()

  const tokenForm = $('token-form') as HTMLFormElement
  const tokenInput = $('token-input') as HTMLInputElement
  const refreshBtn = $('refresh-btn')
  const createTokenLink = $('create-token-link') as HTMLAnchorElement

  createTokenLink.href = 'https://github.com/settings/tokens/new?scopes=repo&description=Review+Queue'

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
