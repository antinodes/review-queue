import { searchReviewRequested, fetchPRDetails } from './github.ts'
import { classifyPRs } from './classify.ts'
import { renderSection, renderSummary, renderError } from './render.ts'
import { getToken, saveToken, clearToken } from './token.ts'
import './style.css'

const REFRESH_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes

const $ = (id: string) => document.getElementById(id)!

let refreshTimer: ReturnType<typeof setInterval> | null = null
let hasLoadedOnce = false

function showTokenPrompt(): void {
  $('token-prompt').classList.remove('hidden')
  $('content').classList.add('hidden')
  $('loading').classList.add('hidden')
  $('error').classList.add('hidden')
}

function hideTokenPrompt(): void {
  $('token-prompt').classList.add('hidden')
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

    // Group non-draft PRs by repo for batched GraphQL
    const byRepo = new Map<string, number[]>()
    for (const pr of prs) {
      if (pr.isDraft) continue
      const list = byRepo.get(pr.repo) ?? []
      list.push(pr.number)
      byRepo.set(pr.repo, list)
    }

    // Fetch details for all repos in parallel
    const detailEntries = await Promise.all(
      [...byRepo.entries()].map(async ([repo, numbers]) => {
        const details = await fetchPRDetails(token, repo, numbers)
        return [repo, details] as const
      }),
    )
    const detailsByRepo = new Map(detailEntries)

    const { ready, blocked, skippedCount } = classifyPRs(prs, detailsByRepo)

    renderSection($('ready-list'), ready, false)
    renderSection($('blocked-list'), blocked, true)
    renderSummary($('summary'), ready.length, blocked.length, skippedCount)

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

// Init
document.addEventListener('DOMContentLoaded', () => {
  const tokenForm = $('token-form') as HTMLFormElement
  const tokenInput = $('token-input') as HTMLInputElement
  const refreshBtn = $('refresh-btn')

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

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Service worker registration failed — app still works without it
  })
}
