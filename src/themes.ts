export interface ThemeConfig {
  id: string
  label: string
  sectionReady: string
  sectionBlocked: string
  colPR: string
  colTitle: string
  colAuthor: string
  colOpen: string
  colThreads: string
  summaryFn: (ready: number, blocked: number, skipped: number) => string
  typeLabels: Record<string, string>
  typeIconMode: 'badge' | 'rpg-awesome'
  threadBadgeFn?: (count: number) => string
}

const defaultSummary = (ready: number, blocked: number, skipped: number) =>
  `${ready} ready for review, ${blocked} blocked by comments, ${skipped} skipped (CI pending/failing/draft)`

const defaultTypeLabels: Record<string, string> = {
  feat: 'feat',
  fix: 'fix',
  build: 'build',
  chore: 'chore',
  refactor: 'refactor',
  test: 'test',
  docs: 'docs',
  ci: 'ci',
  perf: 'perf',
  style: 'style',
  revert: 'revert',
}

export const themes: Record<string, ThemeConfig> = {
  brutalist: {
    id: 'brutalist',
    label: 'Brutalist',
    sectionReady: 'READY FOR REVIEW',
    sectionBlocked: 'BLOCKED BY COMMENTS',
    colPR: 'PR',
    colTitle: 'Title',
    colAuthor: 'Author',
    colOpen: 'Open',
    colThreads: 'Threads',
    summaryFn: defaultSummary,
    typeLabels: defaultTypeLabels,
    typeIconMode: 'badge',
  },
  dense: {
    id: 'dense',
    label: 'Dense',
    sectionReady: 'Ready for Review',
    sectionBlocked: 'Blocked by Comments',
    colPR: 'PR',
    colTitle: 'Title',
    colAuthor: 'Author',
    colOpen: 'Open',
    colThreads: 'Threads',
    summaryFn: defaultSummary,
    typeLabels: defaultTypeLabels,
    typeIconMode: 'badge',
  },
  newspaper: {
    id: 'newspaper',
    label: 'Newspaper',
    sectionReady: 'Ready for Review',
    sectionBlocked: 'Blocked by Comments',
    colPR: 'PR',
    colTitle: 'Title',
    colAuthor: 'Author',
    colOpen: 'Open',
    colThreads: 'Threads',
    summaryFn: defaultSummary,
    typeLabels: defaultTypeLabels,
    typeIconMode: 'badge',
  },
  rpg: {
    id: 'rpg',
    label: 'RPG',
    sectionReady: 'Quests Awaiting Champions',
    sectionBlocked: 'Contested Quests — Disputes Unresolved',
    colPR: 'Missive',
    colTitle: 'Quest Scroll',
    colAuthor: 'Petitioner',
    colOpen: 'Aged',
    colThreads: 'Hazard',
    summaryFn: (ready, blocked, skipped) =>
      `${ready} quests ripe for the taking · ${blocked} bound by dispute · ${skipped} passed over`,
    typeLabels: {
      feat: 'Venture',
      fix: 'Mend',
      build: 'Forge',
      chore: 'Forge',
      refactor: 'Reshape',
      test: 'Trial',
      docs: 'Lore',
      ci: 'Forge',
      perf: 'Haste',
      style: 'Polish',
      revert: 'Undo',
    },
    typeIconMode: 'rpg-awesome',
    threadBadgeFn: (count) => {
      if (count >= 8) return `<span class="hazard hazard-4">☠ ${count}</span>`
      if (count >= 4) return `<span class="hazard hazard-3">⚠ ${count}</span>`
      if (count >= 2) return `<span class="hazard hazard-2">⚠ ${count}</span>`
      return `<span class="hazard hazard-1">~ ${count}</span>`
    },
  },
}

const STORAGE_KEY = 'review-queue-theme'

export function getTheme(): ThemeConfig {
  const id = localStorage.getItem(STORAGE_KEY) ?? 'dense'
  return themes[id] ?? themes.dense
}

export function saveTheme(id: string): void {
  localStorage.setItem(STORAGE_KEY, id)
  document.documentElement.setAttribute('data-theme', id)
}

export function applyTheme(id: string): void {
  document.documentElement.setAttribute('data-theme', id)
}
