import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { ReviewFile } from '../types'
import { parseDiff } from './diff'

/** `$.process.run`, handed in: the engine interface itself may not cross an import. */
export type Exec = (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>

export type Repo = { root: string; gitDir: string }
export type GitResult = { ok: boolean; stdout: string; stderr: string }

/** The baseline is a tree object kept alive by this ref (a ref may point at a tree). */
export const BASE_REF = 'refs/claude-hunk-review/base'

const run = async (
  exec: Exec,
  repo: Repo,
  args: readonly string[],
  init: { env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): Promise<GitResult> => {
  const r = await exec(['git', '-c', 'core.quotepath=false', ...args], {
    cwd: repo.root,
    timeoutMs: 120_000,
    ...init,
  })
  return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr }
}

export const findRepo = async (exec: Exec): Promise<Repo | null> => {
  try {
    const r = await exec(['git', 'rev-parse', '--show-toplevel', '--absolute-git-dir'])
    if (r.exitCode !== 0) return null
    const [root, gitDir] = r.stdout.trim().split('\n')
    return root && gitDir ? { root, gitDir } : null
  } catch {
    return null
  }
}

// A private index keeps the user's staging area untouched, and, kept between
// calls, makes the next `git add -A` a stat-cache hit.
const scratchIndex = (repo: Repo, name: string) => ({
  GIT_INDEX_FILE: `${repo.gitDir}/claude-hunk-review.${name}.index`,
})

/** Tree object of the working copy: tracked and untracked files, ignore rules applied. */
export const snapshotTree = async (exec: Exec, repo: Repo): Promise<string> => {
  const env = scratchIndex(repo, 'work')
  const added = await run(exec, repo, ['add', '-A', '--ignore-errors'], { env })
  if (!added.ok && added.stdout === '' && added.stderr.includes('fatal')) {
    throw new Error(added.stderr.trim())
  }
  const tree = await run(exec, repo, ['write-tree'], { env })
  if (!tree.ok) throw new Error(tree.stderr.trim() || 'git write-tree failed')
  return tree.stdout.trim()
}

export const readBase = async (exec: Exec, repo: Repo): Promise<string | null> => {
  const r = await run(exec, repo, ['rev-parse', '--verify', '-q', `${BASE_REF}^{tree}`])
  return r.ok ? r.stdout.trim() : null
}

export const writeBase = async (exec: Exec, repo: Repo, tree: string): Promise<void> => {
  const r = await run(exec, repo, ['update-ref', BASE_REF, tree])
  if (!r.ok) throw new Error(r.stderr.trim() || 'git update-ref failed')
}

export const diffTrees = async (
  exec: Exec,
  repo: Repo,
  base: string,
  current: string,
): Promise<ReviewFile[]> => {
  if (base === current) return []
  const r = await run(exec, repo, [
    'diff', '--binary', '--no-color', '--no-ext-diff', '--no-renames', '-U3',
    '--src-prefix=a/', '--dst-prefix=b/', base, current,
  ])
  if (!r.ok) throw new Error(r.stderr.trim() || 'git diff failed')
  return parseDiff(r.stdout)
}

/** Reverse-applies a patch to the working copy: the undo. All or nothing. */
export const undoPatch = (exec: Exec, repo: Repo, patch: string): Promise<GitResult> =>
  run(exec, repo, ['apply', '-R', '--whitespace=nowarn', '-'], { stdin: patch })

/** Applies a patch to the working copy: restores an undone change. */
export const redoPatch = (exec: Exec, repo: Repo, patch: string): Promise<GitResult> =>
  run(exec, repo, ['apply', '--whitespace=nowarn', '-'], { stdin: patch })

/**
 * Folds a patch into the baseline: the accept. The baseline tree is read into
 * a scratch index, the patch applied to that index alone, and the result
 * written back as the new baseline tree.
 */
export const acceptPatch = async (
  exec: Exec,
  repo: Repo,
  base: string,
  patch: string,
): Promise<GitResult> => {
  const env = scratchIndex(repo, 'base')
  const read = await run(exec, repo, ['read-tree', base], { env })
  if (!read.ok) return read
  const applied = await run(exec, repo, ['apply', '--cached', '--whitespace=nowarn', '-'], {
    env,
    stdin: patch,
  })
  if (!applied.ok) return applied
  const tree = await run(exec, repo, ['write-tree'], { env })
  if (!tree.ok) return tree
  await writeBase(exec, repo, tree.stdout.trim())
  return { ok: true, stdout: '', stderr: '' }
}
