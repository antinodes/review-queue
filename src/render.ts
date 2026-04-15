import type { ClassifiedPR } from './classify.ts'
import { groupByRepo } from './classify.ts'
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

function renderThreadsTd(count: number, theme: ThemeConfig): string {
  if (theme.threadBadgeFn) return `<td class="threads-cell">${theme.threadBadgeFn(count)}</td>`
  return `<td class="threads-cell">${count}</td>`
}

function ciStatusHtml(state: string | null): string {
  if (state === 'SUCCESS') return '<span class="ci-pass">pass</span>'
  if (state === 'FAILURE') return '<span class="ci-fail">fail</span>'
  if (state === 'PENDING') return '<span class="ci-pending"><span class="ci-spinner"></span> pending</span>'
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
  showThreads?: boolean
  showCI?: boolean
  showAuthor?: boolean // default true
}

export function renderSection(
  container: HTMLElement,
  prs: ClassifiedPR[],
  theme: ThemeConfig,
  opts: RenderColumnOpts = {},
): void {
  const { showThreads = false, showCI = false, showAuthor = true } = opts
  container.innerHTML = ''

  if (prs.length === 0) {
    container.innerHTML = '<p class="empty">None</p>'
    return
  }

  const groups = groupByRepo(prs)

  if (!container.dataset.branchCopy) {
    container.addEventListener('click', handleBranchCopy)
    container.dataset.branchCopy = '1'
  }

  for (const [repo, repoPRs] of groups) {
    const repoHeader = document.createElement('h3')
    repoHeader.textContent = repo
    container.appendChild(repoHeader)

    const thCells = [`<th class="pr-cell">${escapeHtml(theme.colPR)}</th>`, '<th class="type-cell"></th>', `<th class="title-cell">${escapeHtml(theme.colTitle)}</th>`]
    if (showThreads) thCells.push(`<th class="threads-cell">${escapeHtml(theme.colThreads)}</th>`)
    if (showCI) thCells.push(`<th class="ci-cell">${escapeHtml(theme.colCI)}</th>`)
    if (showAuthor) thCells.push(`<th class="author-cell">${escapeHtml(theme.colAuthor)}</th>`)
    thCells.push(`<th class="days-cell">${escapeHtml(theme.colOpen)}</th>`)

    const table = document.createElement('table')
    table.innerHTML = `<thead><tr>${thCells.join('')}</tr></thead>`

    const tbody = document.createElement('tbody')
    for (const pr of repoPRs) {
      const { type, rest } = extractType(pr.title)
      const branchBtn = pr.headRefName
        ? ` <button type="button" class="branch-btn" data-branch="${escapeHtml(pr.headRefName)}" aria-label="Copy branch ${escapeHtml(pr.headRefName)}">\u2387</button>`
        : ''
      const cells = [
        `<td class="pr-cell"><a href="${pr.url}" target="_blank" rel="noopener">#${pr.number}</a>${branchBtn}</td>`,
        renderTypeTd(type, theme),
        `<td class="title-cell">${escapeHtml(rest)}</td>`,
      ]
      if (showThreads) cells.push(renderThreadsTd(pr.unresolvedThreads, theme))
      if (showCI) cells.push(`<td class="ci-cell">${ciStatusHtml(pr.ciState)}</td>`)
      if (showAuthor) cells.push(`<td class="author-cell">${escapeHtml(pr.author)}</td>`)
      cells.push(`<td class="days-cell">${pr.daysOpen}</td>`)

      const row = document.createElement('tr')
      if (pr.ciState === 'PENDING') row.classList.add('building')
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

export function renderError(container: HTMLElement, message: string): void {
  container.textContent = message
  container.classList.remove('hidden')
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
