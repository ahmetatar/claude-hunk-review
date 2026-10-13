import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReviewFile, ReviewHunk, ReviewSnapshot } from '../types'
import { allPatch, countHunks, filePatch, hunkPatch, rowsOf } from './diff'
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

const move = ($: Api, delta: number) =>
  Promise.all([read($, snapshotAtom), update($, confirmAtom, () => '')]).then(([snap]) => {
    const count = rowsOf(snap.files).length
    return update($, selectedAtom, s => Math.max(0, Math.min(count - 1, s + delta)))
  })

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
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const snap = await read($, snapshotAtom)
    const selected = await read($, selectedAtom)
    const notice = await read($, noticeAtom)
    const confirm = await read($, confirmAtom)
    const rows = rowsOf(snap.files)
    const current = rows[selected]
    const file = current ? snap.files[current.fileIndex] : undefined
    const hunk = current && file && current.hunkIndex >= 0 ? file.hunks[current.hunkIndex] : undefined
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 80

    const first = Math.max(0, Math.min(selected - 3, rows.length - 8))
    const window = rows.slice(first, first + 8)

    const bar = (
      <Box flexWrap="wrap" columnGap={1}>
        <Button key="next" hotkey="j" onPress={() => move($, 1)}>next</Button>
        <Button key="prev" hotkey="k" onPress={() => move($, -1)}>prev</Button>
        <Button key="accept" hotkey="a" variant="primary" onPress={() => act($, 'accept', 'row')}>accept</Button>
        <Button key="undo" hotkey="u" onPress={() => act($, 'undo', 'row')}>undo</Button>
        <Button key="accept-file" hotkey="f" onPress={() => act($, 'accept', 'file')}>accept file</Button>
        <Button key="undo-file" hotkey="d" onPress={() => act($, 'undo', 'file')}>undo file</Button>
        <Button key="accept-all" hotkey="y" onPress={() => act($, 'accept', 'all')}>accept all</Button>
        <Button
          key="undo-all"
          hotkey="r"
          onPress={async () => {
            if ((await read($, confirmAtom)) === 'undo-all') return act($, 'undo', 'all')
            await update($, confirmAtom, () => 'undo-all')
            await say($, 'Press undo all again to revert every pending change (restore with z).')
          }}
        >
          undo all
        </Button>
        <Button key="restore" hotkey="z" onPress={async () => say($, await restoreLast($))}>restore</Button>
        <Button key="refresh" hotkey="g" onPress={() => serial(() => refresh($))}>refresh</Button>
      </Box>
    )

    return (
      <Box flexDirection="column" width={columns}>
        <Text bold>Review  <Text dimColor>{summary(snap)}</Text></Text>
        {bar}
        {notice !== '' && <Text color={confirm ? 'yellow' : undefined}>{notice}</Text>}
        {rows.length === 0 && <Text dimColor>Nothing to review. Changes Claude makes show up here.</Text>}
        {first > 0 && <Text dimColor>  … {first} above</Text>}
        {window.map((row, i) => {
          const f = snap.files[row.fileIndex]
          const h = row.hunkIndex >= 0 ? f?.hunks[row.hunkIndex] : undefined
          const index = first + i
          const label = h
            ? `${f?.path}  ${h.header.split('@@')[1]?.trim() ?? ''}  +${h.added} -${h.removed}`
            : `${f?.path}  (${f?.kind})`
          return (
            <Button key={`row-${index}`} plain onPress={() => update($, selectedAtom, () => index)}>
              <Text bold={index === selected} color={index === selected ? 'cyan' : undefined}>
                {index === selected ? '▸ ' : '  '}
                {label}
              </Text>
            </Button>
          )
        })}
        {first + window.length < rows.length && <Text dimColor>  … {rows.length - first - window.length} below</Text>}
        {hunk && <Box marginTop={1}><Code format="diff" path={file?.path} source={hunk.text} /></Box>}
        {!hunk && file && <Box marginTop={1}><Text dimColor>{file.kind} file: accept or undo it as a whole.</Text></Box>}
      </Box>
    )
  })
}
