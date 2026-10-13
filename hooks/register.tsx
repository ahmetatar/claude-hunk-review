import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReviewFile, ReviewHunk, ReviewSnapshot } from '../types'
import { DEMO_DIFF } from './demo'
import { allPatch, countHunks, filePatch, hunkLines, hunkPatch, parseDiff, rowsOf } from './diff'
import {
  type Exec,
  acceptPatch,
  diffTrees,
  findRepo,
  readBase,
  redoPatch,
  snapshotTree,
  undoPatch,
  writeBase,
  type Repo,
} from './git'

type Api = EngineInterface

// The engine interface may not cross an import, so git.ts gets this one call instead.
const exec = ($: Api): Exec => (argv, init) => $.process.run(argv, init)

const PANE = 'review'
const STORE_UNDO = 'undo-log'
const UNDO_KEEP = 20
const UNDO_BYTES = 1_500_000
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

const EMPTY: ReviewSnapshot = { files: [], baseTree: null, currentTree: null, takenAt: 0 }
const snapshotAtom = atom({ plugin: 'hunk-review', key: 'snapshot' } as const, EMPTY)
const selectedAtom = atom({ plugin: 'hunk-review', key: 'selected' } as const, 0)
const noticeAtom = atom({ plugin: 'hunk-review', key: 'notice' } as const, '')
const confirmAtom = atom({ plugin: 'hunk-review', key: 'confirm' } as const, '')
const diffOffsetAtom = atom({ plugin: 'hunk-review', key: 'diffOffset' } as const, 0)

type UndoEntry = { at: number; label: string; patch: string }
type Verb = 'accept' | 'undo'
type Scope = 'row' | 'file' | 'all'

// Everything that touches git or the baseline runs one at a time. A hot
// reload resets this, which is fine: the work in flight finishes on its own.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T,>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job)
  queue = next.catch(() => undefined)
  return next
}

const say = ($: Api, text: string) => update($, noticeAtom, () => text)

const fail = (what: string, stderr: string) =>
  `${what} failed: ${stderr.trim().split('\n')[0] ?? 'unknown error'}`

type Fresh = { repo: Repo; snapshot: ReviewSnapshot }

/** Recomputes the review from git: baseline tree against the working copy. */
const refresh = async ($: Api): Promise<Fresh | null> => {
  const repo = await findRepo(exec($))
  if (!repo) {
    await update($, snapshotAtom, () => ({ ...EMPTY, takenAt: Date.now(), error: 'Not a git repository.' }))
    $.ui.status(undefined)
    return null
  }
  try {
    const currentTree = await snapshotTree(exec($), repo)
    let baseTree = await readBase(exec($), repo)
    if (!baseTree) {
      await writeBase(exec($), repo, currentTree)
      baseTree = currentTree
    }
    const files = await diffTrees(exec($), repo, baseTree, currentTree)
    const snapshot: ReviewSnapshot = { files, baseTree, currentTree, takenAt: Date.now() }
    await update($, snapshotAtom, () => snapshot)
    const rows = rowsOf(files).length
    await update($, selectedAtom, s => Math.min(s, Math.max(0, rows - 1)))
    $.ui.status(rows > 0 ? `review: ${countHunks(files)} hunk${rows === 1 ? '' : 's'}` : undefined)
    return { repo, snapshot }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, snapshotAtom, () => ({ ...EMPTY, takenAt: Date.now(), error }))
    return null
  }
}

const logUndo = async ($: Api, label: string, patch: string) => {
  const log = ((await $.store.get(STORE_UNDO)) as UndoEntry[] | undefined) ?? []
  const next = [...log, { at: Date.now(), label, patch }].slice(-UNDO_KEEP)
  while (next.length > 1 && JSON.stringify(next).length > UNDO_BYTES) next.shift()
  await $.store.set(STORE_UNDO, next)
}

const restoreLast = ($: Api): Promise<string> =>
  serial(async () => {
    const log = ((await $.store.get(STORE_UNDO)) as UndoEntry[] | undefined) ?? []
    const last = log[log.length - 1]
    if (!last) return 'Nothing to restore.'
    const repo = await findRepo(exec($))
    if (!repo) return 'Not a git repository.'
    const r = await redoPatch(exec($), repo, last.patch)
    if (!r.ok) return fail(`Restoring "${last.label}"`, r.stderr)
    await $.store.set(STORE_UNDO, log.slice(0, -1))
    await refresh($)
    return `Restored: ${last.label}`
  })

type Target = { file?: ReviewFile; hunk?: ReviewHunk }

/** Finds in a fresh snapshot the change the person had selected in an older one. */
const locate = (fresh: ReviewSnapshot, was: Target): Target | null => {
  if (!was.file) return {}
  const file = fresh.files.find(f => f.path === was.file?.path)
  if (!file) return null
  if (!was.hunk) return { file }
  const hunk = file.hunks.find(h => h.id === was.hunk?.id)
  return hunk ? { file, hunk } : null
}

const act = ($: Api, verb: Verb, scope: Scope): Promise<void> =>
  serial(async () => {
    await update($, confirmAtom, () => '')
    const was = await read($, snapshotAtom)
    const selected = await read($, selectedAtom)
    const row = rowsOf(was.files)[selected]
    const file = row ? was.files[row.fileIndex] : undefined
    const hunk = row && file && row.hunkIndex >= 0 ? file.hunks[row.hunkIndex] : undefined
    if (scope !== 'all' && !file) return void (await say($, 'Nothing selected.'))

    const fresh = await refresh($)
    if (!fresh) return void (await say($, fresh === null ? 'Could not read the repository.' : ''))
    const { repo, snapshot } = fresh
    if (snapshot.files.length === 0) return void (await say($, 'No changes to review.'))

    const found = scope === 'all' ? ({} as Target) : locate(snapshot, { file, hunk: scope === 'row' ? hunk : undefined })
    if (!found) return void (await say($, 'That change moved or is gone; the list was refreshed.'))

    const base = snapshot.baseTree as string
    const patch =
      scope === 'all' ? allPatch(snapshot.files)
      : scope === 'file' ? filePatch(found.file as ReviewFile)
      : hunkPatch(found.file as ReviewFile, found.hunk)
    const label =
      scope === 'all' ? `all changes (${snapshot.files.length} files)`
      : scope === 'file' ? (found.file as ReviewFile).path
      : `${(found.file as ReviewFile).path} ${found.hunk?.header.split('@@')[1]?.trim() ?? ''}`.trim()

    if (verb === 'accept') {
      if (scope === 'all') await writeBase(exec($), repo, snapshot.currentTree as string)
      else {
        const r = await acceptPatch(exec($), repo, base, patch)
        if (!r.ok) return void (await say($, fail('Accept', r.stderr)))
      }
    } else {
      const r = await undoPatch(exec($), repo, patch)
      if (!r.ok) {
        return void (await say($, fail('Undo', r.stderr) + ' (the file may have changed; refresh and retry)'))
      }
      await logUndo($, label, patch)
    }
    await refresh($)
    await say($, `${verb === 'accept' ? 'Accepted' : 'Undone'}: ${label}`)
  })

const select = ($: Api, index: number) =>
  Promise.all([
    update($, selectedAtom, () => index),
    update($, diffOffsetAtom, () => 0),
    update($, confirmAtom, () => ''),
  ])

const move = async ($: Api, delta: number) => {
  const snap = await read($, snapshotAtom)
  const count = rowsOf(snap.files).length
  const now = await read($, selectedAtom)
  await select($, Math.max(0, Math.min(count - 1, now + delta)))
}

const SCROLL_STEP = 8

const scrollDiff = async ($: Api, direction: 1 | -1) => {
  const snap = await read($, snapshotAtom)
  const row = rowsOf(snap.files)[await read($, selectedAtom)]
  const hunk = row ? snap.files[row.fileIndex]?.hunks[row.hunkIndex] : undefined
  const total = hunk ? hunkLines(hunk).length : 0
  await update($, diffOffsetAtom, o => Math.max(0, Math.min(total - 1, o + direction * SCROLL_STEP)))
}

const summary = (snap: ReviewSnapshot): string =>
  snap.error ?? (snap.files.length === 0
    ? 'No pending changes.'
    : `${snap.files.length} file${snap.files.length === 1 ? '' : 's'}, ${countHunks(snap.files)} hunks pending.`)

export const register: Register = (on, options) => {
  let isRefreshQueued = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hunks',
      description: "Review Claude's changes hunk by hunk (/hunks [refresh|restore|status])",
      argumentHint: '[refresh|restore|status]',
    })
    void serial(() => refresh($))
    return next(e)
  })

  on('command.run', { command: 'hunks' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'restore') return { text: await restoreLast($) }
    if (arg === 'demo') {
      const files = parseDiff(DEMO_DIFF)
      await update($, snapshotAtom, () => ({ files, baseTree: 'demo', currentTree: 'demo', takenAt: Date.now() }))
      await update($, selectedAtom, () => 0)
      await $.ui.open({ id: PANE, title: 'Review', focus: true, closeOnEscape: true })
      return { text: 'Review pane opened with demo data (g refreshes from git).' }
    }
    if (arg === 'refresh' || arg === 'status') {
      await serial(() => refresh($))
      return { text: summary(await read($, snapshotAtom)) }
    }
    await $.ui.open({ id: PANE, title: 'Review', focus: true, closeOnEscape: true })
    return { text: 'Review pane opened.' }
  })

  // A review starts from where the turn starts: with nothing pending, take a
  // fresh baseline so the person's own edits between turns are not Claude's.
  on('turn.start', async ($, e, next) => {
    await serial(async () => {
      try {
        const repo = await findRepo(exec($))
        if (!repo) return
        const snap = await read($, snapshotAtom)
        const base = await readBase(exec($), repo)
        if (!base || snap.files.length === 0) await writeBase(exec($), repo, await snapshotTree(exec($), repo))
      } catch {
        // The review is advisory; never block a turn.
      }
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (options.liveRefresh !== false && EDITING_TOOLS.has(String(e.tool)) && !isRefreshQueued) {
      isRefreshQueued = true
      void serial(() => refresh($)).finally(() => {
        isRefreshQueued = false
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const fresh = await serial(() => refresh($))
    if (fresh && fresh.snapshot.files.length > 0) {
      $.ui.toast(`Review: ${countHunks(fresh.snapshot.files)} hunks pending. /hunks`)
      if (options.autoOpen === true) void $.ui.open({ id: PANE, title: 'Review' })
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshotAtom)
    const selected = await read($, selectedAtom)
    const notice = await read($, noticeAtom)
    const confirm = await read($, confirmAtom)
    const diffOffset = await read($, diffOffsetAtom)
    const rows = rowsOf(snap.files)
    const current = rows[selected]
    const file = current ? snap.files[current.fileIndex] : undefined
    const hunk = current && file && current.hunkIndex >= 0 ? file.hunks[current.hunkIndex] : undefined
    const W = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const R = e.props.scroll?.bodyRows ?? 30
    const isDocked = e.props.placement === 'dock'

    // The list: a header per file, a row per hunk, windowed around the selection.
    type Item = { text: string; rowIndex: number; isHeader: boolean }
    const items: Item[] = []
    let rowIndex = 0
    snap.files.forEach(f => {
      if (f.hunks.length === 0) {
        items.push({ text: `${f.path}  (${f.kind})`, rowIndex: rowIndex++, isHeader: false })
        return
      }
      const added = f.hunks.reduce((n, x) => n + x.added, 0)
      const removed = f.hunks.reduce((n, x) => n + x.removed, 0)
      items.push({ text: `${f.path}  +${added} -${removed}`, rowIndex: -1, isHeader: true })
      f.hunks.forEach(x => {
        const at = x.header.split('@@')[1]?.trim() ?? ''
        items.push({ text: `${at}  +${x.added} -${x.removed}`, rowIndex: rowIndex++, isHeader: false })
      })
    })
    const listSize = Math.max(1, Math.min(items.length, Math.floor(R * 0.3)))
    const at = items.findIndex(it => it.rowIndex === selected)
    const first = Math.max(0, Math.min(at - Math.floor(listSize / 2), items.length - listSize))
    const visible = items.slice(first, first + listSize)

    // The diff gets whatever the list, the title and the footer leave.
    const budget = Math.max(4, R - (1 + listSize + 1 + 1 + 2 + 1))
    const lines = hunk ? hunkLines(hunk) : []
    const needsScroll = lines.length > budget
    const size = needsScroll ? budget - 1 : budget
    const offset = Math.max(0, Math.min(diffOffset, Math.max(0, lines.length - size)))
    const shown = lines.slice(offset, offset + size)
    const gutter = String(Math.max(...lines.map(l => Math.max(l.oldNo ?? 0, l.newNo ?? 0)), 1)).length

    const num = (n: number | undefined) => (n === undefined ? ' '.repeat(gutter) : String(n).padStart(gutter))
    const bgOf = { add: 'diffAddedDimmed', del: 'diffRemovedDimmed', ctx: undefined, meta: undefined } as const
    const wordBg = { add: 'diffAddedWord', del: 'diffRemovedWord' } as const

    const tag = (kind: 'add' | 'del' | 'ctx' | 'meta') => (kind === 'add' ? '+' : kind === 'del' ? '-' : ' ')

    const hotkey = (key: string, label: string, onPress: () => unknown, color?: string) => (
      <Button key={label} plain hotkey={key} onPress={onPress}>
        <Text color={color}>{label}</Text>
      </Button>
    )

    return (
      <Box flexDirection="column" width={W} height={isDocked ? R : undefined}>
        <Text bold>
          Review <Text dimColor>· {summary(snap)}{rows.length > 0 ? `  (hunk ${selected + 1}/${rows.length})` : ''}</Text>
        </Text>

        {visible.map(it => {
          const isSelected = it.rowIndex === selected && !it.isHeader
          const index = it.rowIndex
          return it.isHeader ? (
            <Text bold dimColor>{it.text}</Text>
          ) : (
            <Button key={`row-${index}`} plain onPress={() => select($, index)}>
              <Text bold={isSelected} color={isSelected ? 'suggestion' : undefined}>
                {isSelected ? '▸ ' : '  '}{it.text}
              </Text>
            </Button>
          )
        })}

        {rows.length === 0 && <Text dimColor>Nothing to review. Changes Claude makes show up here.</Text>}

        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {hunk && file && (
            <Text bold wrap="truncate-end">{file.path} <Text dimColor>{hunk.header.split('@@')[1]?.trim()}</Text></Text>
          )}
          {!hunk && file && <Text dimColor>{file.kind} file: accept or undo it as a whole.</Text>}
          {shown.map(l => {
            const mark = l.mark
            const body =
              mark && (l.kind === 'add' || l.kind === 'del')
                ? [
                    <Text>{l.text.slice(0, mark[0])}</Text>,
                    <Text bold backgroundColor={wordBg[l.kind]}>{l.text.slice(mark[0], mark[1])}</Text>,
                    <Text>{l.text.slice(mark[1])}</Text>,
                  ]
                : <Text>{l.text}</Text>
            return (
              <Box width={W} backgroundColor={bgOf[l.kind]}>
                <Text wrap="truncate-end">
                  <Text dimColor>{num(l.oldNo)} {num(l.newNo)} </Text>
                  <Text dimColor={l.kind === 'meta'}>{tag(l.kind)} </Text>
                  {l.kind === 'meta' ? <Text dimColor italic>{l.text}</Text> : body}
                </Text>
              </Box>
            )
          })}
          {needsScroll && (
            <Text dimColor>
              {offset > 0 ? '↑ ' : '  '}lines {offset + 1}-{Math.min(lines.length, offset + size)} of {lines.length}
              {offset + size < lines.length ? ' ↓' : ''}  (w/s scroll)
            </Text>
          )}
        </Box>

        <Text color={confirm ? 'warning' : 'subtle'} wrap="truncate-end">{notice === '' ? ' ' : notice}</Text>
        <Box flexWrap="wrap" columnGap={2}>
          {hotkey('j', 'next', () => move($, 1))}
          {hotkey('k', 'prev', () => move($, -1))}
          {hotkey('s', 'scroll ↓', () => scrollDiff($, 1))}
          {hotkey('w', 'scroll ↑', () => scrollDiff($, -1))}
          {hotkey('g', 'refresh', () => serial(() => refresh($)))}
          {hotkey('z', 'restore', async () => say($, await restoreLast($)))}
        </Box>
        <Box flexWrap="wrap" columnGap={2}>
          {hotkey('a', 'accept', () => act($, 'accept', 'row'), 'success')}
          {hotkey('u', 'undo', () => act($, 'undo', 'row'), 'error')}
          {hotkey('f', 'accept file', () => act($, 'accept', 'file'), 'success')}
          {hotkey('d', 'undo file', () => act($, 'undo', 'file'), 'error')}
          {hotkey('y', 'accept all', () => act($, 'accept', 'all'), 'success')}
          {hotkey('r', 'undo all', async () => {
            if ((await read($, confirmAtom)) === 'undo-all') return act($, 'undo', 'all')
            await update($, confirmAtom, () => 'undo-all')
            await say($, 'Press undo all (r) again to revert every pending change. z restores.')
          }, 'error')}
        </Box>
      </Box>
    )
  })
}
