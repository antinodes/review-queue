import type { ClassifiedPR } from './classify.ts'
import type { StackEntry } from './github.ts'

export interface StackMember {
  pr: ClassifiedPR
  /**
   * The PR that has to merge before this one can. Null at the bottom of the stack, or when the
   * parent is a rung we can't name. May point at a PR that isn't rendered — a rung filtered out
   * of your queue is still the thing you're waiting on.
   */
  parentNumber: number | null
  /** 0 for the trunk-most rung. Siblings share a depth; children indent under their parent. */
  depth: number
}

export interface StackGroup {
  key: string
  repo: string
  label: string
  /** True when GitHub itself tracks the stack; false when we inferred it from branch bases. */
  native: boolean
  /** Bottom-to-top, depth-first. Index 0 is closest to the trunk. */
  members: StackMember[]
  /** Rungs that are still open but absent from what we render (not yours, already approved, …). */
  hiddenCount: number
  rebaseCommand: string
}

export function prKey(repo: string, number: number): string {
  return `${repo}#${number}`
}

// Head branches only identify a PR within the repo that holds them. Fork PRs are routinely
// opened from `main` or `patch-1`, so an unqualified key would make every PR targeting `main`
// a child of some stranger's fork PR.
function headKey(pr: ClassifiedPR): string {
  return `${pr.headRepo || pr.repo}:${pr.headRefName}`
}

function baseKey(pr: ClassifiedPR): string {
  return `${pr.repo}:${pr.baseRefName}`
}

// A lone PR off the trunk isn't a stack — two members is the minimum that needs ordering.
const MIN_STACK_SIZE = 2

/**
 * `linkOnly` PRs join the graph but are never rendered. They exist because the review queue
 * filters PRs (already approved, CI red) before stacks are built, and dropping a middle rung
 * would otherwise split one chain into two sub-minimum fragments and scatter it back into
 * flat rows — the exact thing this section exists to prevent.
 */
export function buildStacks(prs: ClassifiedPR[], linkOnly: ClassifiedPR[] = []): StackGroup[] {
  const visible = new Set(prs.map((p) => prKey(p.repo, p.number)))
  const byRepo = new Map<string, ClassifiedPR[]>()
  for (const pr of [...prs, ...linkOnly]) {
    const list = byRepo.get(pr.repo) ?? []
    list.push(pr)
    byRepo.set(pr.repo, list)
  }

  const groups: StackGroup[] = []
  for (const [repo, repoPRs] of byRepo) {
    const native = repoPRs.filter((p) => p.stack)
    const rest = repoPRs.filter((p) => !p.stack)
    groups.push(...buildNativeStacks(repo, native, visible), ...inferStacks(repo, rest, visible))
  }

  groups.sort((a, b) => a.repo.localeCompare(b.repo) || a.label.localeCompare(b.label))
  return groups
}

function isVisible(pr: ClassifiedPR, visible: Set<string>): boolean {
  return visible.has(prKey(pr.repo, pr.number))
}

// ── Native stacks (GitHub tracks membership and order for us) ──

function buildNativeStacks(repo: string, prs: ClassifiedPR[], visible: Set<string>): StackGroup[] {
  const byStack = new Map<number, ClassifiedPR[]>()
  for (const pr of prs) {
    const list = byStack.get(pr.stack!.number) ?? []
    list.push(pr)
    byStack.set(pr.stack!.number, list)
  }

  const groups: StackGroup[] = []
  for (const [number, all] of byStack) {
    all.sort((a, b) => a.stack!.position - b.stack!.position)
    const shown = all.filter((p) => isVisible(p, visible))
    if (shown.length < MIN_STACK_SIZE) continue

    // Entries are the whole truth about the stack, merged rungs included. Positions are never
    // reused, so a merged rung keeps its slot and only the unsettled ones still block anything.
    const entries = all[0].stack!.entries
    const members = shown.map((pr, index) => ({
      pr,
      parentNumber: nearestBlockingRung(entries, pr.stack!.position),
      depth: index,
    }))

    const rendered = new Set(shown.map((p) => p.number))
    const hiddenCount = entries.filter((e) => !e.settled && !rendered.has(e.number)).length

    groups.push({
      key: `${repo}#stack${number}`,
      repo,
      label: `Stack #${number}`,
      native: true,
      members,
      hiddenCount,
      rebaseCommand: `gh stack checkout ${number} && gh stack rebase && gh stack push`,
    })
  }
  return groups
}

// The rung this one actually waits on: the highest unsettled position below it. Merged rungs are
// skipped because nothing is waiting on a PR that already landed.
function nearestBlockingRung(entries: StackEntry[], position: number): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.position < position && !e.settled) return e.number
  }
  return null
}

// ── Inferred stacks (branch-base chains, for PRs GitHub doesn't track as a stack) ──

// A PR is the child of whichever PR's head branch it targets. PRs targeting the trunk
// (or a branch with no open PR) are roots; anything reachable from a root is one chain.
function inferStacks(repo: string, prs: ClassifiedPR[], visible: Set<string>): StackGroup[] {
  const byHead = new Map<string, ClassifiedPR>()
  for (const pr of prs) {
    if (pr.headRefName) byHead.set(headKey(pr), pr)
  }

  const childrenOf = new Map<string, ClassifiedPR[]>()
  const roots: ClassifiedPR[] = []
  for (const pr of prs) {
    const parent = byHead.get(baseKey(pr))
    if (!parent || parent === pr) {
      roots.push(pr)
      continue
    }
    const siblings = childrenOf.get(headKey(parent)) ?? []
    siblings.push(pr)
    childrenOf.set(headKey(parent), siblings)
  }

  // Shared across roots: two PRs may legitimately carry the same head branch (different bases),
  // and without this the child reachable from both would render in two groups at once.
  const claimed = new Set<string>()

  const groups: StackGroup[] = []
  for (const root of roots) {
    const chain = walkChain(root, childrenOf, claimed)
    const members = chain.filter((m) => isVisible(m.pr, visible))
    if (members.length < MIN_STACK_SIZE) continue
    groups.push({
      key: `${repo}#branch:${root.headRefName}`,
      repo,
      label: root.headRefName,
      native: false,
      members,
      hiddenCount: chain.length - members.length,
      rebaseCommand: `gh stack init ${chain.map((m) => m.pr.headRefName).join(' ')}`,
    })
  }
  return groups
}

// Depth-first so a branching stack still reads bottom-to-top down the column. Each member
// records its real parent rather than whatever precedes it in the flattened list — siblings
// hang off the same rung, and the row above is not necessarily the one below you in the tree.
// `claimed` guards against a base-ref cycle, which GitHub allows you to create by retargeting.
function walkChain(
  root: ClassifiedPR,
  childrenOf: Map<string, ClassifiedPR[]>,
  claimed: Set<string>,
): StackMember[] {
  const out: StackMember[] = []

  const visit = (pr: ClassifiedPR, parent: ClassifiedPR | null, depth: number): void => {
    const key = headKey(pr)
    if (claimed.has(key)) return
    claimed.add(key)
    out.push({ pr, parentNumber: parent?.number ?? null, depth })
    for (const child of childrenOf.get(key) ?? []) visit(child, pr, depth + 1)
  }

  visit(root, null, 0)
  return out
}

// ── Consumers ──

export function stackMemberKeys(groups: StackGroup[]): Set<string> {
  const keys = new Set<string>()
  for (const group of groups) {
    for (const member of group.members) keys.add(prKey(member.pr.repo, member.pr.number))
  }
  return keys
}
