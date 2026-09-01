import type { ClassifiedPR } from './classify.ts'
import { groupByRepo, isCIFailing, isCIInFlight, isStalledBuild, STALLED_BUILD_MINUTES } from './classify.ts'
import type { StackGroup, StackMember } from './stacks.ts'
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

function threadPillHtml(pr: ClassifiedPR, theme: ThemeConfig): string {
  const inner = theme.threadBadgeFn
    ? theme.threadBadgeFn(pr.unresolvedThreads)
    : `${pr.unresolvedThreads} thread${pr.unresolvedThreads === 1 ? '' : 's'}`
  const cls = theme.threadBadgeFn ? 'thread-link' : 'thread-link state-pill threads'
  return pillHtml(cls, pr.url, 'Open conversation on GitHub', inner)
}

// Suppressed where the Reason column already carries the same pill.
function rowIndicators(pr: ClassifiedPR, suppressed: boolean): string {
  if (suppressed || !pr.hasConflicts) return ''
  return conflictPillHtml(pr, 'inline-pill')
}

function renderBlockReasons(pr: ClassifiedPR, theme: ThemeConfig): string {
  const pills: string[] = []
  if (pr.hasConflicts) pills.push(conflictPillHtml(pr))
  if (pr.unresolvedThreads > 0) pills.push(threadPillHtml(pr, theme))
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

// Compact, for a column that also has to fit a spinner: 8m, 47m, 2h 5m.
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function ciStatusHtml(pr: ClassifiedPR): string {
  const state = pr.ciState
  if (state === 'SUCCESS') return '<span class="ci-pass">pass</span>'
  if (isCIFailing(state)) return '<span class="ci-fail">fail</span>'
  if (isCIInFlight(state)) {
    // A build past the threshold is worth interrupting for; below it, the elapsed time is
    // still the useful thing to show, so it's always rendered when we know it.
    const elapsed = pr.buildMinutes === null ? '' : ` ${formatDuration(pr.buildMinutes)}`
    if (isStalledBuild(pr)) {
      return `<span class="ci-stalled" title="Building for ${formatDuration(pr.buildMinutes!)}, past the ${STALLED_BUILD_MINUTES}m mark — the run may be stuck or waiting on a runner">⚠ stalled${elapsed}</span>`
    }
    return `<span class="ci-pending"><span class="ci-spinner"></span> pending${elapsed}</span>`
  }
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

// ── Stacks ──

function handleCopyCommand(e: Event): void {
  const btn = (e.target as HTMLElement).closest('.stack-cmd-btn') as HTMLButtonElement | null
  if (!btn) return
  const cmd = btn.dataset.cmd
  if (!cmd) return
  // Remember the resting label once. Reading it at click time means a second click inside the
  // flash window captures "copied ✓" and restores to that forever.
  btn.dataset.restLabel ??= btn.textContent ?? ''
  const flash = (label: string, cls: string): void => {
    window.clearTimeout(Number(btn.dataset.flashTimer))
    btn.textContent = label
    btn.classList.add(cls)
    const timer = window.setTimeout(() => {
      btn.textContent = btn.dataset.restLabel ?? ''
      btn.classList.remove('copied', 'copy-failed')
    }, 1800)
    btn.dataset.flashTimer = String(timer)
  }
  // Clipboard writes reject when the document isn't focused — say so rather than no-op.
  navigator.clipboard.writeText(cmd).then(
    () => flash('copied ✓', 'copied'),
    () => flash('copy failed', 'copy-failed'),
  )
}

function chipLink(cls: string, href: string, title: string, label: string): string {
  return `<a class="chip ${cls}" href="${href}" target="_blank" rel="noopener" title="${title}">${escapeHtml(label)}</a>`
}

// One chip per row: the single thing standing between this rung and a merge. Anything this rung
// needs done to itself — conflicts, a red or running build, open threads, a review — comes first,
// whatever its position: a thread on rung three is just as much someone's turn as one on rung
// one. "waiting on #N" is reserved for a rung with nothing left to do that is stuck behind one
// that has. "mergeable" is the last resort and must stay that way — it claims nothing is left.
function stateChip(member: StackMember, stack: StackGroup): string {
  const pr = member.pr
  if (pr.bucket === 'draft') return '<span class="chip chip-draft">draft</span>'
  if (pr.hasConflicts) return chipLink('chip-fail', `${pr.url}/conflicts`, 'Open conflict resolver on GitHub', 'conflicts')
  if (isCIInFlight(pr.ciState)) {
    if (isStalledBuild(pr)) return `<span class="chip chip-fail">stalled ${formatDuration(pr.buildMinutes!)}</span>`
    return '<span class="chip chip-building">building</span>'
  }
  // Null means GitHub reported no rollup at all — the CI column already says "no checks".
  if (isCIFailing(pr.ciState)) return '<span class="chip chip-fail">CI failed</span>'
  if (pr.unresolvedThreads > 0) {
    const label = `${pr.unresolvedThreads} thread${pr.unresolvedThreads === 1 ? '' : 's'}`
    return chipLink('chip-blocked', pr.url, 'Open conversation on GitHub', label)
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return '<span class="chip chip-changes">changes requested</span>'
  if (pr.reviewDecision !== 'APPROVED') return '<span class="chip chip-needs-review">needs review</span>'
  // Approved and green but still gated — required checks, CODEOWNERS, or a protection rule.
  if (pr.mergeStateStatus === 'BLOCKED') return '<span class="chip chip-blocked">blocked</span>'
  // A native stack merges every rung in the batch together, so being above the bottom is no
  // longer a reason to wait as long as everything below is in the batch too.
  if (stack.mergeBatch.includes(pr.number)) return '<span class="chip chip-ready">mergeable</span>'
  if (member.parentNumber !== null) {
    return `<span class="chip chip-waiting">waiting on #${member.parentNumber}</span>`
  }
  return '<span class="chip chip-ready">mergeable</span>'
}

export function renderStacks(container: HTMLElement, stacks: StackGroup[], theme: ThemeConfig): void {
  container.innerHTML = ''

  if (stacks.length === 0) {
    container.innerHTML = '<p class="empty">None</p>'
    return
  }

  if (!container.dataset.cmdCopy) {
    container.addEventListener('click', handleCopyCommand)
    container.addEventListener('click', handleBranchCopy)
    container.dataset.cmdCopy = '1'
  }

  for (const stack of stacks) {
    container.appendChild(buildStackCard(stack, theme))
  }
}

// Flush, not indented by depth: the position cell is a fixed 56px, so a per-level indent ran
// deep rungs straight into the PR column.
function railFor(index: number): string {
  return index === 0 ? '●' : '└'
}

// Who you'd be reviewing. Most stacks are one person; a handoff or a co-authored chain is worth
// seeing before you open it, so name up to three and count the rest.
function authorsFor(stack: StackGroup): string {
  const logins = [...new Set(stack.members.map((m) => m.pr.author))]
  const shown = logins.slice(0, 3).map((login) => `@${escapeHtml(login)}`).join(', ')
  const overflow = logins.length - 3
  return overflow > 0 ? `${shown} +${overflow}` : shown
}

// Only worth a word when it changes what you'd do: one mergeable rung is the ordinary case and
// the row chip already says so. Two or more means a single "merge up to here" lands them all.
function mergeBatchNote(stack: StackGroup): string {
  const n = stack.mergeBatch.length
  if (n < 2) return ''
  const top = stack.mergeBatch[n - 1]
  return `<span class="stack-batch" title="GitHub can merge these together — merge #${top} and every rung below it lands with it">${n} mergeable together</span>`
}

function buildStackCard(stack: StackGroup, theme: ThemeConfig): HTMLElement {
  const card = document.createElement('div')
  card.className = 'stack-card'

  const total = stack.members.length + stack.hiddenCount

  // BEHIND is a clean restack; DIRTY needs one too but you'll be resolving conflicts by hand.
  const conflicted = stack.members.some((m) => m.pr.hasConflicts || m.pr.mergeStateStatus === 'DIRTY')
  const behind = stack.members.some((m) => m.pr.mergeStateStatus === 'BEHIND')
  const restackWarning = conflicted
    ? '<span class="stack-behind">conflicts</span>'
    : behind ? '<span class="stack-behind">needs restack</span>' : ''

  const meta = [
    `${total} PRs`,
    stack.native ? '' : '<span class="stack-inferred" title="Inferred from branch bases — GitHub does not track this as a stack">inferred</span>',
    restackWarning,
    mergeBatchNote(stack),
  ].filter(Boolean).join(' · ')

  const header = document.createElement('div')
  header.className = 'stack-header'
  header.innerHTML = `
    <div class="stack-id">
      <span class="stack-repo">${escapeHtml(stack.repo)}</span>
      <span class="stack-label">${escapeHtml(stack.label)}</span>
      <span class="stack-authors">${authorsFor(stack)}</span>
      <span class="stack-meta">${meta}</span>
    </div>
    <button type="button" class="stack-cmd-btn" data-cmd="${escapeHtml(stack.rebaseCommand)}" title="${escapeHtml(stack.rebaseCommand)}">${stack.native ? 'copy rebase' : 'copy stack init'}</button>`
  card.appendChild(header)

  const table = document.createElement('table')
  table.className = 'stack-table'
  table.innerHTML = `<thead><tr>
    <th class="stack-pos-cell">${escapeHtml(theme.colPos)}</th>
    <th class="pr-cell">${escapeHtml(theme.colPR)}</th>
    <th class="type-cell"></th>
    <th class="title-cell">${escapeHtml(theme.colTitle)}</th>
    <th class="ci-cell">${escapeHtml(theme.colCI)}</th>
    <th class="state-cell">${escapeHtml(theme.colReason)}</th>
    <th class="days-cell">${escapeHtml(theme.colOpen)}</th>
  </tr></thead>`

  const tbody = document.createElement('tbody')
  stack.members.forEach((member, index) => {
    const pr = member.pr
    const { type, rest } = extractType(pr.title)
    // Native stacks number from GitHub so the labels stay right when we can only see part of the stack.
    const position = pr.stack ? pr.stack.position : index + 1
    const row = document.createElement('tr')
    row.className = index === 0 ? 'stack-row stack-bottom' : 'stack-row'
    if (stack.mergeBatch.includes(pr.number)) row.classList.add('stack-mergeable')
    if (isCIInFlight(pr.ciState)) row.classList.add(isStalledBuild(pr) ? 'stalled' : 'building')
    row.innerHTML = [
      `<td class="stack-pos-cell"><span class="stack-pos"><span class="stack-rail">${railFor(index)}</span><span class="stack-num">${position}</span></span></td>`,
      `<td class="pr-cell"><a href="${pr.url}" target="_blank" rel="noopener">#${pr.number}</a>` +
        (pr.headRefName ? ` <button type="button" class="branch-btn" data-branch="${escapeHtml(pr.headRefName)}" aria-label="Copy branch ${escapeHtml(pr.headRefName)}">⎇</button>` : '') + '</td>',
      renderTypeTd(type, theme),
      `<td class="title-cell">${escapeHtml(rest)}</td>`,
      `<td class="ci-cell">${ciStatusHtml(pr)}</td>`,
      `<td class="state-cell">${stateChip(member, stack)}</td>`,
      `<td class="days-cell">${pr.daysOpen}</td>`,
    ].join('')
    tbody.appendChild(row)
  })
  table.appendChild(tbody)
  // The card clips to keep its rounded corners, so the table needs its own scroller on narrow screens.
  const scroller = document.createElement('div')
  scroller.className = 'stack-table-wrap'
  scroller.appendChild(table)
  card.appendChild(scroller)

  if (stack.hiddenCount > 0) {
    const note = document.createElement('p')
    note.className = 'stack-hidden-note'
    note.textContent = `${stack.hiddenCount} more PR${stack.hiddenCount === 1 ? '' : 's'} in this stack not in your queue`
    card.appendChild(note)
  }

  return card
}

export interface RenderColumnOpts {
  showBlockReasons?: boolean
  showCI?: boolean
  showAuthor?: boolean // default true
  showBaseBranch?: boolean
  showDeployedEnvs?: boolean
  showVersion?: boolean
  mergedColumn?: boolean // relabel trailing column "Merged" and skip head-branch copy button
}

export function renderSection(
  container: HTMLElement,
  prs: ClassifiedPR[],
  theme: ThemeConfig,
  opts: RenderColumnOpts = {},
): void {
  const { showBlockReasons = false, showCI = false, showAuthor = true, showBaseBranch = false, showDeployedEnvs = false, showVersion = false, mergedColumn = false } = opts
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
      if (showCI) cells.push(`<td class="ci-cell">${ciStatusHtml(pr)}</td>`)
      if (showAuthor) cells.push(`<td class="author-cell">${escapeHtml(pr.author)}</td>`)
      if (showBaseBranch) cells.push(`<td class="base-cell">${escapeHtml(pr.baseRefName || '\u2014')}</td>`)
      if (showDeployedEnvs) cells.push(`<td class="deployed-cell">${renderEnvChips(pr.deployedEnvs, pr.repo)}</td>`)
      if (showVersion) cells.push(`<td class="version-cell">${pr.version ? escapeHtml(pr.version) : '<span class="env-empty">—</span>'}</td>`)
      cells.push(`<td class="days-cell">${pr.daysOpen}</td>`)

      const row = document.createElement('tr')
      if (isCIInFlight(pr.ciState)) row.classList.add(isStalledBuild(pr) ? 'stalled' : 'building')
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

// innerHTML escapes & < > but leaves quotes alone, and these strings land in attribute position.
// Branch names may legally contain a double quote, which would otherwise truncate the attribute.
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
