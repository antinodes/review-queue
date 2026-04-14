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
  feat: 'ra-sword',
  fix: 'ra-wrench',
  build: 'ra-anvil',
  chore: 'ra-anvil',
  refactor: 'ra-cog',
  test: 'ra-scroll-unfurled',
  docs: 'ra-scroll-unfurled',
  ci: 'ra-anvil',
  perf: 'ra-lightning-sword',
  style: 'ra-gem-pendant',
  revert: 'ra-spinning-sword',
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
  if (theme.threadBadgeFn) {
    return `<td class="threads-cell">${theme.threadBadgeFn(count)}</td>`
  }
  return `<td class="threads-cell">${count}</td>`
}

export function renderSection(
  container: HTMLElement,
  prs: ClassifiedPR[],
  showThreads: boolean,
  theme: ThemeConfig,
): void {
  container.innerHTML = ''

  if (prs.length === 0) {
    container.innerHTML = '<p class="empty">None</p>'
    return
  }

  const groups = groupByRepo(prs)

  for (const [repo, repoPRs] of groups) {
    const repoHeader = document.createElement('h3')
    repoHeader.textContent = repo
    container.appendChild(repoHeader)

    const table = document.createElement('table')
    table.innerHTML = showThreads
      ? `<thead><tr>
           <th>${escapeHtml(theme.colPR)}</th><th></th><th>${escapeHtml(theme.colTitle)}</th><th>${escapeHtml(theme.colThreads)}</th><th>${escapeHtml(theme.colAuthor)}</th><th>${escapeHtml(theme.colOpen)}</th>
         </tr></thead>`
      : `<thead><tr>
           <th>${escapeHtml(theme.colPR)}</th><th></th><th>${escapeHtml(theme.colTitle)}</th><th>${escapeHtml(theme.colAuthor)}</th><th>${escapeHtml(theme.colOpen)}</th>
         </tr></thead>`

    const tbody = document.createElement('tbody')
    for (const pr of repoPRs) {
      const { type, rest } = extractType(pr.title)
      const typeTd = renderTypeTd(type, theme)
      const row = document.createElement('tr')
      row.innerHTML = showThreads
        ? `<td><a href="${pr.url}" target="_blank" rel="noopener">#${pr.number}</a></td>
           ${typeTd}
           <td class="title-cell">${escapeHtml(rest)}</td>
           ${renderThreadsTd(pr.unresolvedThreads, theme)}
           <td>${escapeHtml(pr.author)}</td>
           <td class="days-cell">${pr.daysOpen}</td>`
        : `<td><a href="${pr.url}" target="_blank" rel="noopener">#${pr.number}</a></td>
           ${typeTd}
           <td class="title-cell">${escapeHtml(rest)}</td>
           <td>${escapeHtml(pr.author)}</td>
           <td class="days-cell">${pr.daysOpen}</td>`
      tbody.appendChild(row)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  }
}

export function renderSectionHeading(el: HTMLElement, text: string): void {
  const h2 = el.querySelector('h2')
  if (h2) h2.textContent = text
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
