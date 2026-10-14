import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReviewComment, ReviewFile, ReviewHunk, ReviewSnapshot } from '../types'
import type { LineTarget } from './comments'
import { buildContext, buildPrompt, describe, forHunk, lineAt, lineTarget, makeComment, normalize, onLine, reattach, unresolved } from './comments'
import { HELP, hunkView, listText } from './text'
import { DEMO_DIFF } from './demo'
import { allPatch, countHunks, filePatch, hunkLines, hunkPatch, hunkSummary, parseDiff, rowsOf } from './diff'
import { langOf, markRange, tokenize } from './highlight'
import { paletteFor } from './theme'
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
const COMMENTS_TOOL = 'review_comments'
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
const commentsAtom = atom({ plugin: 'hunk-review', key: 'comments' } as const, [] as ReviewComment[])
const composingAtom = atom({ plugin: 'hunk-review', key: 'composing' } as const, '')
const cursorAtom = atom({ plugin: 'hunk-review', key: 'cursor' } as const, -1)

const STORE_COMMENTS = 'comments'
const KEEP_RESOLVED_MS = 14 * 24 * 3600 * 1000
const keyOf = (path: string, hunkId: string, line: number, isOld: boolean) => `${path}\n${hunkId}\n${line}${isOld ? 'o' : 'n'}`

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

// Comments live in the store per repository root; the atom is what the pane draws.
let commentsRoot = ''

const loadComments = async ($: Api, root: string) => {
  const all = ((await $.store.get(STORE_COMMENTS)) as Record<string, ReviewComment[]> | undefined) ?? {}
  await update($, commentsAtom, () => (all[root] ?? []).map(normalize))
  commentsRoot = root
}

const persistComments = async ($: Api, list: ReviewComment[]) => {
  if (commentsRoot === '') return
  const all = ((await $.store.get(STORE_COMMENTS)) as Record<string, ReviewComment[]> | undefined) ?? {}
  const cutoff = Date.now() - KEEP_RESOLVED_MS
  all[commentsRoot] = list.filter(c => c.status !== 'resolved' || c.createdAt > cutoff).slice(-300)
  await $.store.set(STORE_COMMENTS, all)
}

const setComments = async ($: Api, fn: (list: ReviewComment[]) => ReviewComment[]) => {
  const next = fn(await read($, commentsAtom))
  await update($, commentsAtom, () => next)
  await persistComments($, next)
  return next
}

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
    if (commentsRoot !== repo.root) await loadComments($, repo.root)
    const current = await read($, commentsAtom)
    const moved = reattach(current, files)
    if (moved !== current) await setComments($, () => moved)
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
    await update($, composingAtom, () => '')
    await update($, cursorAtom, () => -1)
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

    let resolved = 0
    if (verb === 'accept') {
      if (scope === 'all') await writeBase(exec($), repo, snapshot.currentTree as string)
      else {
        const r = await acceptPatch(exec($), repo, base, patch)
        if (!r.ok) return void (await say($, fail('Accept', r.stderr)))
      }
      // Accepting is the answer to a comment on what was accepted.
      const accepted = (c: ReviewComment) =>
        scope === 'all' ||
        (c.path === found.file?.path && (scope === 'file' || (scope === 'row' && c.hunkId === found.hunk?.id)))
      await setComments($, list =>
        list.map(c => (c.status !== 'resolved' && accepted(c) ? (resolved++, { ...c, status: 'resolved' as const }) : c)),
      )
    } else {
      const r = await undoPatch(exec($), repo, patch)
      if (!r.ok) {
        return void (await say($, fail('Undo', r.stderr) + ' (the file may have changed; refresh and retry)'))
      }
      await logUndo($, label, patch)
    }
    await refresh($)
    await say($, `${verb === 'accept' ? 'Accepted' : 'Undone'}: ${label}${resolved > 0 ? ` (${resolved} comment${resolved === 1 ? '' : 's'} resolved)` : ''}`)
  })

const select = ($: Api, index: number) =>
  Promise.all([
    update($, selectedAtom, () => index),
    update($, diffOffsetAtom, () => 0),
    update($, confirmAtom, () => ''),
    update($, composingAtom, () => ''),
    update($, cursorAtom, () => -1),
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

type Chosen = { file: ReviewFile; hunk: ReviewHunk } | null

const selectedHunk = async ($: Api): Promise<Chosen> => {
  const snap = await read($, snapshotAtom)
  const row = rowsOf(snap.files)[await read($, selectedAtom)]
  const file = row ? snap.files[row.fileIndex] : undefined
  const hunk = row && file && row.hunkIndex >= 0 ? file.hunks[row.hunkIndex] : undefined
  return file && hunk ? { file, hunk } : null
}

const startComment = async ($: Api) => {
  const picked = await selectedHunk($)
  if (!picked) return say($, 'Select a hunk to comment on.')
  const target = lineTarget(picked.hunk, await read($, cursorAtom))
  const key = keyOf(picked.file.path, picked.hunk.id, target.line, target.isOld)
  await update($, composingAtom, now => (now === key ? '' : key))
  await say($, '')
}

/** Writes, rewrites or (empty text) removes the comment on one line of a hunk; says what happened. */
const applyComment = async ($: Api, file: ReviewFile, hunk: ReviewHunk, target: LineTarget, text: string): Promise<string> => {
  const body = text.trim()
  const existing = forHunk(await read($, commentsAtom), file.path, hunk.id).find(c => onLine(c, target))
  if (body === '') {
    if (!existing) return 'No comment written.'
    await setComments($, list => list.filter(c => c.id !== existing.id))
    return 'Comment removed.'
  }
  if (existing) {
    await setComments($, list => list.map(c => (c.id === existing.id ? { ...c, text: body, status: 'open' as const } : c)))
    return 'Comment updated.'
  }
  await setComments($, list => [...list, makeComment(file, hunk, body, Date.now(), target)])
  return 'Comment saved. m sends it to Claude, e puts it in the prompt box.'
}

/** Saves what was typed in the pane's comment field, on the cursor's line. */
const saveComment = ($: Api, text: string) =>
  serial(async () => {
    const picked = await selectedHunk($)
    await update($, composingAtom, () => '')
    if (!picked) return
    const target = lineTarget(picked.hunk, await read($, cursorAtom))
    await say($, await applyComment($, picked.file, picked.hunk, target, text))
  })

const resolveSelected = ($: Api) =>
  serial(async () => {
    const picked = await selectedHunk($)
    if (!picked) return say($, 'Select a hunk first.')
    const here = forHunk(await read($, commentsAtom), picked.file.path, picked.hunk.id)
    if (here.length === 0) return say($, 'No open comment on this hunk.')
    await setComments($, list => list.map(c => (here.some(h => h.id === c.id) ? { ...c, status: 'resolved' as const } : c)))
    await say($, `Resolved ${here.length} comment${here.length === 1 ? '' : 's'}.`)
  })

/** Sends every unresolved comment to Claude as one prompt, or leaves it in the prompt box to edit. */
const sendComments = ($: Api, mode: 'submit' | 'fill'): Promise<string> =>
  serial(async () => {
    const list = unresolved(await read($, commentsAtom))
    if (list.length === 0) return 'No open comments. Press c on a hunk to write one.'
    const text = buildPrompt(list)
    const count = `${list.length} comment${list.length === 1 ? '' : 's'}`
    if (mode === 'fill') {
      const r = await $.prompt.fill({ text, mode: 'replace' })
      return r.isFilled ? `Put ${count} in the prompt box. Edit it, then press Enter.` : 'The prompt box could not take the text.'
    }
    await setComments($, all => all.map(c => (c.status === 'open' ? { ...c, status: 'sent' as const } : c)))
    $.prompt.submit({ text, asUser: true }).catch(() => undefined)
    return `Sent ${count} to Claude.`
  })

/** Moves the line cursor within the selected hunk; the first press lands on its first changed line. */
const moveCursor = async ($: Api, direction: 1 | -1) => {
  const snap = await read($, snapshotAtom)
  const row = rowsOf(snap.files)[await read($, selectedAtom)]
  const hunk = row ? snap.files[row.fileIndex]?.hunks[row.hunkIndex] : undefined
  if (!hunk) return
  const lines = hunkLines(hunk)
  const isReal = (i: number) => lines[i] !== undefined && lines[i]?.kind !== 'meta'
  const firstChanged = Math.max(0, lines.findIndex(l => l.kind === 'add' || l.kind === 'del'))
  await update($, composingAtom, () => '')
  await update($, cursorAtom, now => {
    if (now < 0) return firstChanged
    let next = now + direction
    while (next >= 0 && next < lines.length && !isReal(next)) next += direction
    return next >= 0 && next < lines.length ? next : now
  })
}

/** Opens the pane; where the terminal has no room for it, answers with the review as text instead. */
const openPane = async ($: Api): Promise<string> => {
  const opened = await $.ui.open({ id: PANE, title: 'Review', focus: true })
  if (opened.isPlaced) return 'Review pane opened.'
  await serial(() => refresh($))
  return `${listText((await read($, snapshotAtom)).files, await read($, commentsAtom))}\n(No room for the pane: ${opened.reason})`
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
      description: "Review Claude's changes hunk by hunk: a pane, or text commands (/hunks list|show|accept|undo|comment|send)",
      argumentHint: '[list|show <n>|accept <n>|undo <n>|comment <n> <text>|send|open]',
    })
    await $.tool.register({
      name: COMMENTS_TOOL,
      description:
        "The person's open review comments on your changes, written in their hunk review pane. Each names " +
        'the exact line it is about (path:line), quotes that line and its diff hunk, and says what they want. ' +
        'Call it when they ask you to address, apply or check their review comments, or mention comments on your changes. ' +
        'Make only the change each comment asks for, at that line.',
      inputSchema: { type: 'object', properties: {} },
    })
    void serial(() => refresh($))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__hunk-review__review_comments' }, async $ => {
    await serial(() => refresh($))
    const open = unresolved(await read($, commentsAtom))
    return { result: open.length === 0 ? 'No open review comments.' : buildPrompt(open) }
  }).catch(() => ({ deny: 'hunk-review: could not read the review comments.' }))

  on('command.run', { command: 'hunks' }, async ($, e) => {
    const arg = e.args.trim()
    const [verb = '', ...rest] = arg.split(/\s+/)

    // The review without a pane: every step below works in any terminal width.
    if (verb === 'list' || verb === 'show' || verb === 'accept' || verb === 'undo' || verb === 'comment') {
      await serial(() => refresh($))
      const snap = await read($, snapshotAtom)
      const comments = await read($, commentsAtom)
      const rows = rowsOf(snap.files)
      const rowAt = (n: number) => {
        const row = rows[n - 1]
        const file = row ? snap.files[row.fileIndex] : undefined
        return { file, hunk: row && file && row.hunkIndex >= 0 ? file.hunks[row.hunkIndex] : undefined }
      }
      const bad = (what: string) => ({ text: `${what}\n${HELP}` })
      if (verb === 'list') return { text: listText(snap.files, comments) }
      if (rows.length === 0) return { text: 'No pending changes.' }

      if (verb === 'show') {
        const n = Number(rest[0])
        const { file, hunk } = rowAt(n)
        if (!file) return bad(`There is no hunk ${rest[0] ?? ''}. Use a number from /hunks list.`)
        await select($, n - 1)
        return { text: hunk ? hunkView(file, hunk, comments, n, rows.length) : `${file.path}  (${file.kind} file)` }
      }

      if (verb === 'comment') {
        const m = /^comment\s+(\d+)(?::(-?\d+))?\s+([\s\S]+)$/.exec(arg)
        if (!m) return bad('Usage: /hunks comment <n>[:line] <text>   (a minus line number means a removed line)')
        const { file, hunk } = rowAt(Number(m[1]))
        if (!file || !hunk) return bad(`There is no hunk ${m[1]} to comment on.`)
        const spec = m[2]
        const target = spec === undefined ? lineTarget(hunk, -1) : lineAt(hunk, Math.abs(Number(spec)), Number(spec) < 0)
        if (!target) return bad(`Hunk ${m[1]} has no line ${spec}. /hunks show ${m[1]} lists its lines.`)
        await select($, Number(m[1]) - 1)
        return { text: await serial(() => applyComment($, file, hunk, target, m[3] ?? '')) }
      }

      // accept | undo: <n> | file <n> | all
      const isAll = rest[0] === 'all'
      const isFile = rest[0] === 'file'
      if (isAll && verb === 'undo' && rest[1] !== 'yes') {
        return { text: 'That reverts every pending change. Run `/hunks undo all yes` to confirm; `/hunks restore` brings it back.' }
      }
      if (!isAll) {
        const n = Number(isFile ? rest[1] : rest[0])
        if (!Number.isInteger(n) || n < 1 || n > rows.length) return bad(`Usage: /hunks ${verb} <n> | file <n> | all   (n is 1-${rows.length})`)
        await select($, n - 1)
      }
      await act($, verb, isAll ? 'all' : isFile ? 'file' : 'row')
      return { text: await read($, noticeAtom) }
    }

    if (arg === 'open') return { text: await openPane($) }
    if (arg === 'restore') return { text: await restoreLast($) }
    if (arg === 'demo') {
      const files = parseDiff(DEMO_DIFF)
      await update($, snapshotAtom, () => ({ files, baseTree: 'demo', currentTree: 'demo', takenAt: Date.now() }))
      await update($, selectedAtom, () => 0)
      await $.ui.open({ id: PANE, title: 'Review', focus: true })
      return { text: 'Review pane opened with demo data (g refreshes from git).' }
    }
    if (arg === 'send' || arg === 'fill') return { text: await sendComments($, arg === 'send' ? 'submit' : 'fill') }
    if (arg === 'comments') {
      const list = unresolved(await read($, commentsAtom))
      const files = (await read($, snapshotAtom)).files
      return { text: list.length === 0 ? 'No open comments.' : list.map((c, i) => `${i + 1}. ${describe(c, files)}`).join('\n') }
    }
    if (arg === 'clear') {
      const before = (await read($, commentsAtom)).length
      const after = (await setComments($, list => unresolved(list))).length
      return { text: `Removed ${before - after} resolved comment${before - after === 1 ? '' : 's'}.` }
    }
    if (arg === 'refresh' || arg === 'status') {
      await serial(() => refresh($))
      return { text: summary(await read($, snapshotAtom)) }
    }
    return { text: await openPane($) }
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

  // With `injectComments` on, the person's next typed prompt carries the comments
  // they have not sent yet, as hidden context. Each is injected once.
  on('prompt.submit', async ($, e, next) => {
    if (options.injectComments !== true || e.origin.kind !== 'composer') return next(e)
    const fresh = (await read($, commentsAtom)).filter(c => c.status === 'open')
    if (fresh.length === 0) return next(e)
    const result = await next({ ...e, context: [...(e.context ?? []), buildContext(fresh)] })
    await setComments($, list => list.map(c => (fresh.some(f => f.id === c.id) ? { ...c, status: 'sent' as const } : c)))
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const pal = paletteFor(options.theme)
    const snap = await read($, snapshotAtom)
    const selected = await read($, selectedAtom)
    const notice = await read($, noticeAtom)
    const confirm = await read($, confirmAtom)
    const diffOffset = await read($, diffOffsetAtom)
    const allComments = await read($, commentsAtom)
    const composing = await read($, composingAtom)
    const cursor = await read($, cursorAtom)
    const rows = rowsOf(snap.files)
    const current = rows[selected]
    const file = current ? snap.files[current.fileIndex] : undefined
    const hunk = current && file && current.hunkIndex >= 0 ? file.hunks[current.hunkIndex] : undefined
    const W = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const R = e.props.scroll?.bodyRows ?? 30
    const isDocked = e.props.placement === 'dock'
    const IW = W - 2
    const isCompact = W < 72
    // Under ~40 columns only what identifies a row fits: the code and a comment mark.
    const isTiny = W < 40
    const here = file && hunk ? forHunk(allComments, file.path, hunk.id) : []
    const target = hunk ? lineTarget(hunk, cursor) : undefined
    const onTarget = target ? here.find(c => onLine(c, target)) : undefined
    const isComposing =
      file !== undefined && hunk !== undefined && target !== undefined &&
      composing === keyOf(file.path, hunk.id, target.line, target.isOld)
    const openComments = unresolved(allComments)
    const commentRows = here.reduce((n, c) => n + Math.ceil((c.text.length + 10) / Math.max(10, IW)), 0)

    const split = (path: string) => {
      const at = path.lastIndexOf('/')
      return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
    }
    const badge = (added: number, removed: number) => [
      added > 0 ? `+${added}` : '',
      removed > 0 ? `−${removed}` : '',
    ].filter(Boolean).join(' ')
    const counts = (added: number, removed: number) => (
      <Text>
        {added > 0 && <Text color={pal.addFg}>+{added}</Text>}
        {added > 0 && removed > 0 && ' '}
        {removed > 0 && <Text color={pal.delFg}>{'−'}{removed}</Text>}
      </Text>
    )

    // The list: a header per file, a row per hunk, windowed around the selection.
    type Item = { rowIndex: number; fileIndex: number; hunkIndex: number }
    const items: Item[] = []
    let rowIndex = 0
    snap.files.forEach((f, fileIndex) => {
      if (f.hunks.length === 0) return void items.push({ rowIndex: rowIndex++, fileIndex, hunkIndex: -1 })
      items.push({ rowIndex: -1, fileIndex, hunkIndex: -1 })
      f.hunks.forEach((_, hunkIndex) => items.push({ rowIndex: rowIndex++, fileIndex, hunkIndex }))
    })
    const listSize = Math.max(1, Math.min(items.length, Math.floor(R * 0.32)))
    const at = items.findIndex(it => it.rowIndex === selected)
    const first = Math.max(0, Math.min(at - Math.floor(listSize / 2), items.length - listSize))
    const visible = items.slice(first, first + listSize)

    const budget = Math.max(4, R - (1 + listSize + 1 + 2 + 1 + 3 + (isComposing ? 1 : 0) + commentRows))
    const lines = hunk ? hunkLines(hunk) : []
    const needsScroll = lines.length > budget
    const size = needsScroll ? budget - 1 : budget
    let offset = Math.max(0, Math.min(diffOffset, Math.max(0, lines.length - size)))
    // The line cursor stays in view.
    if (cursor >= 0 && cursor < offset) offset = cursor
    if (cursor >= offset + size) offset = Math.min(Math.max(0, lines.length - size), cursor - size + 1)
    const shown = lines.slice(offset, offset + size)
    const digits = String(Math.max(...lines.map(l => Math.max(l.oldNo ?? 0, l.newNo ?? 0)), 1)).length
    const num = (n: number | undefined) => (n === undefined ? ' '.repeat(digits) : String(n).padStart(digits))
    const lang = file ? langOf(file.path) : 'plain'

    // Esc hands the keyboard back, which hides the field; the comment it held is
    // over too, so a later click into the pane does not bring the field back.
    // A render never writes, so the reset is left to a timer.
    if (composing !== '' && e.props.isFocused === false) {
      $.clock.after(0, () => void update($, composingAtom, () => ''))
    }

    const hotkey = (key: string, label: string, onPress: () => unknown, color?: string) => (
      <Button key={label} plain hotkey={key} onPress={onPress}>
        <Text color={color ?? pal.text}>{label}</Text>
      </Button>
    )

    const { dir, name } = split(file?.path ?? '')
    const fileAdded = file ? file.hunks.reduce((n, x) => n + x.added, 0) : 0
    const fileRemoved = file ? file.hunks.reduce((n, x) => n + x.removed, 0) : 0

    return (
      <Box flexDirection="column" width={W} height={isDocked ? R : undefined} backgroundColor={pal.bg}>
        <Text>
          <Text bold color={pal.accent}>Review</Text>
          <Text color={pal.muted}>  {summary(snap)}{rows.length > 0 ? `  ·  ${selected + 1}/${rows.length}` : ''}{openComments.length > 0 ? `  ·  ✎ ${openComments.length}` : ''}</Text>
        </Text>

        {visible.map(it => {
          const f = snap.files[it.fileIndex]
          if (!f) return null
          if (it.rowIndex === -1) {
            const { dir: d, name: n } = split(f.path)
            return (
              <Text wrap="truncate-end">
                <Text color={pal.accent}>{'▾ '}</Text>
                <Text bold color={pal.text}>{n}</Text>
                {!isTiny && <Text color={pal.muted}> {d}  </Text>}
                {!isTiny && counts(f.hunks.reduce((a, x) => a + x.added, 0), f.hunks.reduce((a, x) => a + x.removed, 0))}
              </Text>
            )
          }
          const isSelected = it.rowIndex === selected
          const index = it.rowIndex
          const x = it.hunkIndex >= 0 ? f.hunks[it.hunkIndex] : undefined
          const sum = x ? hunkSummary(x) : undefined
          const noted = x ? forHunk(allComments, f.path, x.id).length : 0
          const tail = (x ? badge(x.added, x.removed) : f.kind) + (noted > 0 ? ' ✎' : '')
          const room = isTiny ? Math.max(4, W - 6) : Math.max(6, W - 4 - (isCompact ? 0 : 7) - tail.length - 2)
          const snippet = (sum?.snippet || (x ? '(whitespace)' : f.path)).slice(0, room)
          return (
            <Box width={W} backgroundColor={isSelected ? pal.selected : undefined}>
              <Button key={`row-${index}`} plain onPress={() => select($, index)}>
                <Text wrap="truncate-end">
                  <Text color={pal.accent}>{isSelected ? '▎' : ' '}</Text>
                  <Text color={pal.accent}>{isSelected ? '● ' : '○ '}</Text>
                  <Text color={pal.muted}>{isCompact ? '' : (sum ? `L${sum.line}` : '').padEnd(6)}</Text>
                  <Text bold={isSelected} color={pal.text}>{isTiny ? snippet : snippet.padEnd(room)}</Text>
                  {!isTiny && (x ? counts(x.added, x.removed) : <Text color={pal.muted}>{f.kind}</Text>)}
                  {noted > 0 && <Text color={pal.accent}> ✎</Text>}
                </Text>
              </Button>
            </Box>
          )
        })}
        {rows.length === 0 && <Text color={pal.muted}>Nothing to review. Changes Claude makes show up here.</Text>}

        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={pal.border} marginTop={0}>
          <Box width={IW} backgroundColor={pal.bar} justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={pal.accent} bold> {'◆'} </Text>
              <Text bold color={pal.text}>{name || 'no file'}</Text>
              {!isCompact && <Text color={pal.muted}> {dir}</Text>}
            </Text>
            <Text wrap="truncate-end">
              {hunk && !isCompact ? <Text color={pal.muted}>{hunk.header.split('@@')[1]?.trim()}  </Text> : null}
              {!isTiny && counts(fileAdded, fileRemoved)}
              <Text> </Text>
            </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} width={IW} backgroundColor={pal.bg}>
            {!hunk && file && <Text color={pal.muted}>  {file.kind} file: accept or undo it as a whole.</Text>}
            {shown.flatMap((l, shownIndex) => {
              const isChanged = l.kind === 'add' || l.kind === 'del'
              const isCursor = offset + shownIndex === cursor
              const bg = l.kind === 'add' ? pal.addBg : l.kind === 'del' ? pal.delBg : isCursor ? pal.selected : undefined
              const wordBg = l.kind === 'add' ? pal.addWord : pal.delWord
              const edge = l.kind === 'add' ? pal.addFg : pal.delFg
              const tokens = l.kind === 'meta' ? [] : markRange(tokenize(l.text, lang), isChanged ? l.mark : undefined)
              const lineComments = here.filter(c => l.kind !== 'meta' && onLine(c, { line: l.newNo ?? l.oldNo ?? 0, isOld: l.kind === 'del' }))
              const row = (
                <Box width={IW} backgroundColor={bg}>
                  <Text wrap="truncate-end">
                    <Text color={isCursor ? pal.accent : edge} bold={isCursor}>{isCursor ? '▶' : isChanged ? '▎' : ' '}</Text>
                    <Text color={pal.gutter}>{isCompact ? `${num(l.newNo ?? l.oldNo)} ` : `${num(l.oldNo)} ${num(l.newNo)} `}</Text>
                    <Text bold color={edge}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '} </Text>
                    {l.kind === 'meta' && <Text italic color={pal.muted}>{l.text}</Text>}
                    {tokens.map(t => (
                      <Text
                        color={pal[t.kind]}
                        italic={t.kind === 'comment'}
                        bold={t.isMarked}
                        backgroundColor={t.isMarked ? wordBg : undefined}
                      >
                        {t.text}
                      </Text>
                    ))}
                  </Text>
                </Box>
              )
              return [
                row,
                ...lineComments.map(c => (
                  <Box width={IW} backgroundColor={pal.bar}>
                    <Text wrap="wrap">
                      <Text color={pal.accent}>{' '.repeat(isCompact ? digits + 2 : digits * 2 + 3)}▎ ✎ </Text>
                      <Text color={pal.text}>{c.text}</Text>
                      {c.status === 'sent' && <Text color={pal.muted}>  sent</Text>}
                    </Text>
                  </Box>
                )),
              ]
            })}
            {here
              .filter(c => !lines.some(l => l.kind !== 'meta' && onLine(c, { line: l.newNo ?? l.oldNo ?? 0, isOld: l.kind === 'del' })))
              .map(c => (
                <Box width={IW} backgroundColor={pal.bar}>
                  <Text wrap="wrap">
                    <Text color={pal.accent}>▎ ✎ </Text>
                    <Text color={pal.muted}>L{c.line} </Text>
                    <Text color={pal.text}>{c.text}</Text>
                  </Text>
                </Box>
              ))}
            {needsScroll && (
              <Text color={pal.muted}>
                {offset > 0 ? ' ↑' : '  '} lines {offset + 1}–{Math.min(lines.length, offset + size)} of {lines.length}
                {offset + size < lines.length ? ' ↓' : ''}   w/s to scroll
              </Text>
            )}
          </Box>
        </Box>

        {isComposing && e.props.isFocused && Input && (
          <Input
            key="comment"
            label="✎ "
            placeholder={`comment on line ${target?.line ?? ''} · Enter saves · Enter on empty cancels`}
            value={onTarget?.text ?? ''}
            submitLabel="save"
            autoFocus
            onSubmit={(text: string) => void saveComment($, text)}
          />
        )}
        <Text color={confirm ? pal.accent : pal.muted} bold={confirm !== ''} wrap="truncate-end">{notice === '' ? ' ' : notice}</Text>
        <Box flexWrap="wrap" columnGap={2}>
          {hotkey('j', 'next', () => move($, 1))}
          {hotkey('k', 'prev', () => move($, -1))}
          {hotkey('n', 'next line', () => moveCursor($, 1))}
          {hotkey('p', 'prev line', () => moveCursor($, -1))}
          {hotkey('s', 'scroll ↓', () => scrollDiff($, 1))}
          {hotkey('w', 'scroll ↑', () => scrollDiff($, -1))}
          {hotkey('g', 'refresh', () => serial(() => refresh($)))}
          {hotkey('z', 'restore', async () => say($, await restoreLast($)))}
          {hotkey('q', 'close', () => $.ui.close({ id: PANE }))}
        </Box>
        <Box flexWrap="wrap" columnGap={2}>
          {hotkey('a', 'accept', () => act($, 'accept', 'row'), pal.addFg)}
          {hotkey('u', 'undo', () => act($, 'undo', 'row'), pal.delFg)}
          {hotkey('f', 'accept file', () => act($, 'accept', 'file'), pal.addFg)}
          {hotkey('d', 'undo file', () => act($, 'undo', 'file'), pal.delFg)}
          {hotkey('y', 'accept all', () => act($, 'accept', 'all'), pal.addFg)}
          {hotkey('r', 'undo all', async () => {
            if ((await read($, confirmAtom)) === 'undo-all') return act($, 'undo', 'all')
            await update($, confirmAtom, () => 'undo-all')
            await say($, 'Press undo all (r) again to revert every pending change. z restores.')
          }, pal.delFg)}
        </Box>
        <Box flexWrap="wrap" columnGap={2}>
          {hotkey('c', onTarget ? 'edit comment' : target ? `comment line ${target.line}` : 'comment', () => startComment($), pal.accent)}
          {hotkey('x', 'resolve', () => resolveSelected($), pal.accent)}
          {hotkey('m', `send to Claude${openComments.length > 0 ? ` (${openComments.length})` : ''}`, async () => say($, await sendComments($, 'submit')), pal.accent)}
          {hotkey('e', 'edit in prompt', async () => say($, await sendComments($, 'fill')), pal.accent)}
        </Box>
      </Box>
    )
  })
}
