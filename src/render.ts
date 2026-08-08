import type { ClassifiedPR, StackedBase } from './classify.ts'
import { groupByRepo, isCIFailing, isCIInFlight } from './classify.ts'
import type { ThemeConfig } from './themes.ts'

const TYPE_PATTERN = /^(feat|fix|build|chore|refactor|test|docs|ci|perf|style|revert)[\s(:]/i

function extractType(title: string): { type: string; rest: string } {
  const match = title.match(TYPE_PATTERN)
  if (!match) return { type: '', rest: title }
  const type = match[1].toLowerCase()
  const rest = title.replace(/^[a-z]+(?:\([^)]*\))?[:\s]+/i, '').trim()
  return { type, rest }
}

function typeClass(type: string): string {
  if (type === 'feat') return 'type-feat'
  if (type === 'fix') return 'type-fix'
  if (type === 'build' || type === 'chore' || type === 'ci') return 'type-build'
  return 'type-other'
}

const RPG_ICON_MAP: Record<string, string> = {
  feat: 'ra-sword', fix: 'ra-wrench', build: 'ra-anvil', chore: 'ra-anvil',
  refactor: 'ra-cog', test: 'ra-scroll-unfurled', docs: 'ra-scroll-unfurled',
  ci: 'ra-anvil', perf: 'ra-lightning-sword', style: 'ra-gem-pendant', revert: 'ra-spinning-sword',
}

function renderTypeTd(type: string, theme: ThemeConfig): string {
  if (!type) return '<td class="type-cell"></td>'
  if (theme.typeIconMode === 'rpg-awesome') {
    const icon = RPG_ICON_MAP[type] ?? 'ra-scroll-unfurled'
    const label = theme.typeLabels[type] ?? type
    return `<td class="type-cell"><i class="ra ${icon} quest-type ${typeClass(type)}" title="${escapeHtml(label)}"></i></td>`
  }
  const label = theme.typeLabels[type] ?? type
  return `<td class="type-cell"><span class="type-badge ${typeClass(type)}">${escapeHtml(label)}</span></td>`
}

// `label` is trusted HTML: callers pass either literal text or a theme badge.
function pillHtml(className: string, href: string, title: string, label: string): string {
  return `<a class="${className}" href="${href}" target="_blank" rel="noopener" title="${title}">${label}</a>`
}

function conflictPillHtml(pr: ClassifiedPR, extraClass = ''): string {
  const cls = `state-pill conflicts${extraClass ? ' ' + extraClass : ''}`
  return pillHtml(cls, `${pr.url}/conflicts`, 'Open conflict resolver on GitHub', 'merge conflicts')
}

// Suppressed where a dedicated column already shows the same state.
function rowIndicators(pr: ClassifiedPR, suppressed: boolean): string {
  if (suppressed) return ''
  const pills: string[] = []
  if (pr.hasConflicts) pills.push(conflictPillHtml(pr, 'inline-pill'))
  return pills.join('')
}

function waitingPillHtml(base: StackedBase): string {
  const branch = escapeHtml(base.branch)
  if (!base.pr) return `<span class="state-pill waiting" title="${branch}">Waiting on ${branch}</span>`
  const title = `Blocked until #${base.pr.number} merges — ${branch}`
  return pillHtml('state-pill waiting', base.pr.url, title, `Waiting on #${base.pr.number}`)
}

function renderBlockReasons(pr: ClassifiedPR, theme: ThemeConfig): string {
  const pills: string[] = []
  if (pr.stackedOn) pills.push(waitingPillHtml(pr.stackedOn))
  if (pr.hasConflicts) pills.push(conflictPillHtml(pr))
  if (pr.unresolvedThreads > 0) {
    const inner = theme.threadBadgeFn
      ? theme.threadBadgeFn(pr.unresolvedThreads)
      : `${pr.unresolvedThreads} thread${pr.unresolvedThreads === 1 ? '' : 's'}`
    const pillClass = theme.threadBadgeFn ? 'thread-link' : 'thread-link state-pill threads'
    pills.push(pillHtml(pillClass, pr.url, 'Open conversation on GitHub', inner))
  }
  if (pills.length === 0) return '<span class="env-empty">—</span>'
  return `<div class="state-pills">${pills.join('')}</div>`
}

function renderEnvChips(envs: string[], repo: string): string {
  if (envs.length === 0) return '<span class="env-empty">—</span>'
  const chips = envs.map((e) =>
    `<a class="env-chip" href="https://github.com/${encodeURI(repo)}/deployments/${encodeURIComponent(e)}" target="_blank" rel="noopener">${escapeHtml(e)}</a>`,
  ).join('')
  return `<div class="env-chips">${chips}</div>`
}

function ciStatusHtml(state: string | null): string {
  if (state === 'SUCCESS') return '<span class="ci-pass">pass</span>'
  if (isCIFailing(state)) return '<span class="ci-fail">fail</span>'
  if (isCIInFlight(state)) return '<span class="ci-pending"><span class="ci-spinner"></span> pending</span>'
  if (state === null) return '<span class="ci-none">no checks</span>'
  return '<span class="ci-unknown">—</span>'
}

function handleBranchCopy(e: Event): void {
  const btn = (e.target as HTMLElement).closest('.branch-btn') as HTMLButtonElement | null
  if (!btn) return
  const branch = btn.dataset.branch
  if (!branch) return
  navigator.clipboard.writeText(branch).then(() => {
    btn.textContent = '\u2713'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = '\u2387'
      btn.classList.remove('copied')
    }, 1500)
  })
}

export interface RenderColumnOpts {
  showCI?: boolean
  showAuthor?: boolean // default true
  showBaseBranch?: boolean
  showDeployedEnvs?: boolean
  showVersion?: boolean
  showBlockReasons?: boolean
  mergedColumn?: boolean // relabel trailing column "Merged" and skip head-branch copy button
}

export function renderSection(
  container: HTMLElement,
  prs: ClassifiedPR[],
  theme: ThemeConfig,
  opts: RenderColumnOpts = {},
): void {
  const { showCI = false, showAuthor = true, showBaseBranch = false, showDeployedEnvs = false, showVersion = false, showBlockReasons = false, mergedColumn = false } = opts
  container.innerHTML = ''

  if (prs.length === 0) {
    container.innerHTML = '<p class="empty">None</p>'
    return
  }

  const groups = groupByRepo(prs, mergedColumn ? 'asc' : 'desc')

  if (!container.dataset.branchCopy) {
    container.addEventListener('click', handleBranchCopy)
    container.dataset.branchCopy = '1'
  }

  for (const [repo, repoPRs] of groups) {
    const repoHeader = document.createElement('h3')
    repoHeader.textContent = repo
    container.appendChild(repoHeader)

    const thCells = [`<th class="pr-cell">${escapeHtml(theme.colPR)}</th>`, '<th class="type-cell"></th>', `<th class="title-cell">${escapeHtml(theme.colTitle)}</th>`]
    if (showBlockReasons) thCells.push(`<th class="reason-cell">${escapeHtml(theme.colReason)}</th>`)
    if (showCI) thCells.push(`<th class="ci-cell">${escapeHtml(theme.colCI)}</th>`)
    if (showAuthor) thCells.push(`<th class="author-cell">${escapeHtml(theme.colAuthor)}</th>`)
    if (showBaseBranch) thCells.push(`<th class="base-cell">${escapeHtml(theme.colBase)}</th>`)
    if (showDeployedEnvs) thCells.push(`<th class="deployed-cell">${escapeHtml(theme.colDeployed)}</th>`)
    if (showVersion) thCells.push(`<th class="version-cell">${escapeHtml(theme.colVersion)}</th>`)
    thCells.push(`<th class="days-cell">${escapeHtml(mergedColumn ? theme.colMerged : theme.colOpen)}</th>`)

    const table = document.createElement('table')
    table.innerHTML = `<thead><tr>${thCells.join('')}</tr></thead>`

    const tbody = document.createElement('tbody')
    for (const pr of repoPRs) {
      const { type, rest } = extractType(pr.title)
      const indicators = rowIndicators(pr, showBlockReasons)
      const branchBtn = !mergedColumn && pr.headRefName
        ? ` <button type="button" class="branch-btn" data-branch="${escapeHtml(pr.headRefName)}" aria-label="Copy branch ${escapeHtml(pr.headRefName)}">\u2387</button>`
        : ''
      const cells = [
        `<td class="pr-cell"><a href="${pr.url}" target="_blank" rel="noopener">#${pr.number}</a>${branchBtn}</td>`,
        renderTypeTd(type, theme),
        `<td class="title-cell"><div class="title-wrap"><span class="title-text">${escapeHtml(rest)}</span>${indicators}</div></td>`,
      ]
      if (showBlockReasons) cells.push(`<td class="reason-cell">${renderBlockReasons(pr, theme)}</td>`)
      if (showCI) cells.push(`<td class="ci-cell">${ciStatusHtml(pr.ciState)}</td>`)
      if (showAuthor) cells.push(`<td class="author-cell">${escapeHtml(pr.author)}</td>`)
      if (showBaseBranch) cells.push(`<td class="base-cell">${escapeHtml(pr.baseRefName || '\u2014')}</td>`)
      if (showDeployedEnvs) cells.push(`<td class="deployed-cell">${renderEnvChips(pr.deployedEnvs, pr.repo)}</td>`)
      if (showVersion) cells.push(`<td class="version-cell">${pr.version ? escapeHtml(pr.version) : '<span class="env-empty">—</span>'}</td>`)
      cells.push(`<td class="days-cell">${pr.daysOpen}</td>`)

      const row = document.createElement('tr')
      if (isCIInFlight(pr.ciState)) row.classList.add('building')
      if (pr.bucket === 'merged') row.classList.add('merged')
      row.innerHTML = cells.join('')
      tbody.appendChild(row)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  }
}

export function renderSummary(container: HTMLElement, text: string): void {
  container.textContent = text
}

export interface ErrorAction {
  label: string
  onClick: () => void
}

export function renderError(container: HTMLElement, message: string, actions: ErrorAction[] = []): void {
  container.innerHTML = ''
  const msg = document.createElement('span')
  msg.textContent = message
  container.appendChild(msg)
  for (const action of actions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'error-action'
    btn.textContent = action.label
    btn.addEventListener('click', action.onClick)
    container.appendChild(btn)
  }
  container.classList.remove('hidden')
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
