export interface TabLabels {
  reviews: string
  myPRs: string
  dependabot: string
}

export interface SectionLabels {
  // Reviews tab
  ready: string
  blocked: string
  // My PRs tab
  readyToMerge: string
  needsReview: string
  myBlocked: string
  building: string
  failingCI: string
  draft: string
  // Dependabot tab
  depReady: string
  depBlocked: string
  depBuilding: string
  depFailing: string
}

export interface ThemeConfig {
  id: string
  label: string
  tabs: TabLabels
  sections: SectionLabels
  colPR: string
  colTitle: string
  colAuthor: string
  colOpen: string
  colThreads: string
  colCI: string
  typeLabels: Record<string, string>
  typeIconMode: 'badge' | 'rpg-awesome'
  threadBadgeFn?: (count: number) => string
}

const defaultTabs: TabLabels = { reviews: 'Reviews', myPRs: 'My PRs', dependabot: 'Dependabot' }

const defaultSections: SectionLabels = {
  ready: 'Ready for Review',
  blocked: 'Blocked by Comments',
  readyToMerge: 'Ready to Merge',
  needsReview: 'Needs Review',
  myBlocked: 'Blocked by Comments',
  building: 'Building',
  failingCI: 'Failing CI',
  draft: 'Draft',
  depReady: 'Ready for Review',
  depBlocked: 'Blocked by Comments',
  depBuilding: 'Building',
  depFailing: 'Failing CI',
}

const defaultTypeLabels: Record<string, string> = {
  feat: 'feat', fix: 'fix', build: 'build', chore: 'chore',
  refactor: 'refactor', test: 'test', docs: 'docs', ci: 'ci',
  perf: 'perf', style: 'style', revert: 'revert',
}

const defaultCols = {
  colPR: 'PR', colTitle: 'Title', colAuthor: 'Author',
  colOpen: 'Open', colThreads: 'Threads', colCI: 'CI',
}

export const themes: Record<string, ThemeConfig> = {
  brutalist: {
    id: 'brutalist',
    label: 'Brutalist',
    tabs: { reviews: 'REVIEWS', myPRs: 'MY PRS', dependabot: 'DEPENDABOT' },
    sections: {
      ...defaultSections,
      ready: 'READY FOR REVIEW',
      blocked: 'BLOCKED BY COMMENTS',
      readyToMerge: 'READY TO MERGE',
      needsReview: 'NEEDS REVIEW',
      myBlocked: 'BLOCKED BY COMMENTS',
      building: 'BUILDING',
      failingCI: 'FAILING CI',
      draft: 'DRAFT',
      depReady: 'READY FOR REVIEW',
      depBlocked: 'BLOCKED BY COMMENTS',
      depBuilding: 'BUILDING',
      depFailing: 'FAILING CI',
    },
    ...defaultCols,
    typeLabels: defaultTypeLabels,
    typeIconMode: 'badge',
  },
  dense: {
    id: 'dense',
    label: 'Dense',
    tabs: defaultTabs,
    sections: defaultSections,
    ...defaultCols,
    typeLabels: defaultTypeLabels,
    typeIconMode: 'badge',
  },
  newspaper: {
    id: 'newspaper',
    label: 'Newspaper',
    tabs: defaultTabs,
    sections: defaultSections,
    ...defaultCols,
    typeLabels: defaultTypeLabels,
    typeIconMode: 'badge',
  },
  rpg: {
    id: 'rpg',
    label: 'RPG',
    tabs: { reviews: 'Quest Board', myPRs: 'My Campaigns', dependabot: 'Golem Work' },
    sections: {
      ready: 'Quests Awaiting Champions',
      blocked: 'Contested Quests — Disputes Unresolved',
      readyToMerge: 'Victories Awaiting Claim',
      needsReview: 'Campaigns Seeking Allies',
      myBlocked: 'Campaigns Under Dispute',
      building: 'Trials In Progress',
      failingCI: 'Failed Trials',
      draft: 'Scrolls in Progress',
      depReady: 'Golem Tasks Ready',
      depBlocked: 'Golem Tasks Disputed',
      depBuilding: 'Golems Being Forged',
      depFailing: 'Golem Tasks Failed',
    },
    colPR: 'Missive',
    colTitle: 'Quest Scroll',
    colAuthor: 'Petitioner',
    colOpen: 'Aged',
    colThreads: 'Hazard',
    colCI: 'Trial',
    typeLabels: {
      feat: 'Venture', fix: 'Mend', build: 'Forge', chore: 'Forge',
      refactor: 'Reshape', test: 'Trial', docs: 'Lore', ci: 'Forge',
      perf: 'Haste', style: 'Polish', revert: 'Undo',
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
