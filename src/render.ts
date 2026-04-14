import type { ClassifiedPR } from './classify.ts'
import { groupByRepo } from './classify.ts'

export function renderSection(
  container: HTMLElement,
  prs: ClassifiedPR[],
  showThreads: boolean,
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
           <th>PR</th><th>Title</th><th>Author</th><th>Open</th><th>Threads</th>
         </tr></thead>`
      : `<thead><tr>
           <th>PR</th><th>Title</th><th>Author</th><th>Open</th>
         </tr></thead>`

    const tbody = document.createElement('tbody')
    for (const pr of repoPRs) {
      const row = document.createElement('tr')
      row.innerHTML = showThreads
        ? `<td><a href="${pr.url}" target="_blank" rel="noopener">#${pr.number}</a></td>
           <td class="title-cell">${escapeHtml(pr.title)}</td>
           <td>${escapeHtml(pr.author)}</td>
           <td class="days-cell">${pr.daysOpen}</td>
           <td class="threads-cell">${pr.unresolvedThreads}</td>`
        : `<td><a href="${pr.url}" target="_blank" rel="noopener">#${pr.number}</a></td>
           <td class="title-cell">${escapeHtml(pr.title)}</td>
           <td>${escapeHtml(pr.author)}</td>
           <td class="days-cell">${pr.daysOpen}</td>`
      tbody.appendChild(row)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  }
}

export function renderSummary(
  container: HTMLElement,
  readyCount: number,
  blockedCount: number,
  skippedCount: number,
): void {
  container.textContent =
    `${readyCount} ready for review, ${blockedCount} blocked by comments, ${skippedCount} skipped (CI pending/failing/draft)`
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
