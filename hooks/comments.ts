import type { ReviewComment, ReviewFile, ReviewHunk } from '../types'
import { type DiffLine, hash, hunkLines, hunkSummary } from './diff'

const HUNK_CAP = 2500
const EXCERPT_LINES = 30

/** Fills what comments saved by earlier versions lack, so an old store never breaks a send. */
export const normalize = (c: Partial<ReviewComment> & Pick<ReviewComment, 'id' | 'path' | 'text'>): ReviewComment => {
  const line = typeof c.line === 'number' ? c.line : 0
  return {
    id: c.id,
    path: c.path,
    hunkId: c.hunkId ?? '',
    line,
    isOld: c.isOld ?? false,
    lineText: c.lineText ?? c.snippet ?? '',
    from: c.from ?? line,
    to: c.to ?? line,
    snippet: c.snippet ?? '',
    hunk: c.hunk ?? '',
    text: c.text,
    status: c.status ?? 'open',
    createdAt: c.createdAt ?? 0,
  }
}

export const isOpen = (c: ReviewComment) => c.status !== 'resolved'

export const unresolved = (list: readonly ReviewComment[]): ReviewComment[] => list.filter(isOpen)

export type LineTarget = { line: number; isOld: boolean; text: string }

const targetOfLine = (l: DiffLine): LineTarget => ({
  line: l.newNo ?? l.oldNo ?? 0,
  isOld: l.kind === 'del',
  text: l.text,
})

/** The line a comment is about: the cursor's line, else the hunk's first changed line. */
export const lineTarget = (hunk: Pick<ReviewHunk, 'text'>, cursor: number): LineTarget => {
  const lines = hunkLines(hunk)
  const at = cursor >= 0 ? lines[cursor] : undefined
  const first = lines.find(l => (l.kind === 'add' || l.kind === 'del') && l.text.trim() !== '') ?? lines[0]
  return targetOfLine(at && at.kind !== 'meta' ? at : first ?? { kind: 'ctx', text: '' })
}

const span = (hunk: string): [number, number] => {
  const nos = hunkLines({ text: hunk }).map(l => l.newNo ?? l.oldNo ?? 0).filter(n => n > 0)
  return [Math.min(...nos, Infinity) === Infinity ? 0 : Math.min(...nos), Math.max(0, ...nos)]
}

export const makeComment = (
  file: ReviewFile,
  hunk: ReviewHunk,
  text: string,
  now: number,
  target: LineTarget = lineTarget(hunk, -1),
): ReviewComment => {
  const sum = hunkSummary(hunk)
  const [from, to] = span(hunk.text)
  return {
    id: hash(`${file.path}\0${hunk.id}\0${target.line}\0${now}\0${text}`),
    path: file.path,
    hunkId: hunk.id,
    line: target.line,
    isOld: target.isOld,
    lineText: target.text.slice(0, 200),
    from,
    to,
    snippet: sum.snippet.slice(0, 120),
    hunk: hunk.text.slice(0, HUNK_CAP),
    text,
    status: 'open',
    createdAt: now,
  }
}

export const forHunk = (list: readonly ReviewComment[], path: string, hunkId: string): ReviewComment[] =>
  list.filter(c => isOpen(c) && c.path === path && c.hunkId === hunkId)

export const onLine = (c: ReviewComment, t: Pick<LineTarget, 'line' | 'isOld'>): boolean =>
  c.line === t.line && c.isOld === t.isOld

export const isAttached = (c: ReviewComment, files: readonly ReviewFile[]): boolean =>
  files.some(f => f.path === c.path && f.hunks.some(h => h.id === c.hunkId))

/**
 * When Claude edits the region again a hunk's id changes. A comment follows its
 * hunk to the one nearby that still changes the same line, or sits within a few
 * lines of where it was, and then to the line it was about (found by its text);
 * otherwise it stays, detached, with the hunk it quoted.
 */
export const reattach = (list: readonly ReviewComment[], files: readonly ReviewFile[]): ReviewComment[] => {
  let changed = false
  const next = list.map(c => {
    if (!isOpen(c)) return c
    const file = files.find(f => f.path === c.path)
    if (!file || file.hunks.some(h => h.id === c.hunkId)) return c
    const candidates = file.hunks
      .map(h => ({ h, s: hunkSummary(h), at: span(h.text)[0] }))
      .map(x => ({ ...x, d: Math.abs(x.at - c.from) }))
      .filter(x => (x.d <= 12 && x.s.snippet === c.snippet) || x.d <= 3)
      .sort((a, b) => a.d - b.d)
    const best = candidates[0]
    if (!best) return c
    changed = true
    const lines = hunkLines(best.h)
    const same = lines.find(l => l.kind !== 'meta' && l.text === c.lineText && (l.kind === 'del') === c.isOld)
    const [from, to] = span(best.h.text)
    return {
      ...c,
      hunkId: best.h.id,
      line: same ? (same.newNo ?? same.oldNo ?? c.line) : c.line,
      from,
      to,
      snippet: best.s.snippet.slice(0, 120),
      hunk: best.h.text.slice(0, HUNK_CAP),
    }
  })
  return changed ? next : (list as ReviewComment[])
}

const quote = (text: string) => text.split('\n').map(l => `> ${l}`).join('\n')

/** The hunk with its own line numbers, a window of it around the commented line, which `►` marks. */
const numbered = (c: ReviewComment): string => {
  const lines = hunkLines({ text: c.hunk }).filter(l => l.kind !== 'meta')
  const at = Math.max(0, lines.findIndex(l => (l.kind === 'del') === c.isOld && (l.newNo ?? l.oldNo) === c.line))
  const start = Math.max(0, Math.min(at - Math.floor(EXCERPT_LINES / 2), lines.length - EXCERPT_LINES))
  const shown = lines.slice(start, start + EXCERPT_LINES)
  const width = String(Math.max(...shown.map(l => l.newNo ?? l.oldNo ?? 0), 1)).length
  const body = shown.map((l, i) => {
    const no = String(l.newNo ?? l.oldNo ?? '').padStart(width)
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
    return `${start + i === at ? '►' : ' '} ${no} ${sign}${l.text}`
  })
  const more = lines.length - shown.length
  return more > 0 ? `${body.join('\n')}\n  … (${more} more lines of the hunk)` : body.join('\n')
}

const where = (c: ReviewComment) =>
  c.isOld ? `${c.path} (removed line ${c.line})` : `${c.path}:${c.line}`

const entry = (c: ReviewComment, n: number): string =>
  `### ${n}. ${where(c)}\n${quote(c.text)}\n\n` +
  `The comment is about this line${c.isOld ? ' (it was removed)' : ''}: \`${c.lineText.trim()}\`\n` +
  `Its hunk covers lines ${c.from}–${c.to}; ► marks the line:\n\n\`\`\`diff\n${numbered(c)}\n\`\`\``

/** The prompt `/hunks send` submits: every unresolved comment, with the line and hunk it is about. */
export const buildPrompt = (list: readonly ReviewComment[]): string =>
  [
    `I reviewed your changes and left ${list.length} comment${list.length === 1 ? '' : 's'}. ` +
      'Each one is about the single line it names (path:line, new-file numbering) and quotes the hunk around it. ' +
      'Make only the change each comment asks for, at that line; do not edit other code. Then I will review again.',
    ...list.map((c, i) => entry(c, i + 1)),
  ].join('\n\n')

/** The hidden context `injectComments` attaches to the person's next prompt. */
export const buildContext = (list: readonly ReviewComment[]): string =>
  [
    'The person left review comments on your earlier changes in the hunk review pane. ' +
      'Each is about the one line it names; make only the change it asks for, nothing else:',
    ...list.map((c, i) => entry(c, i + 1)),
  ].join('\n\n')

export const describe = (c: ReviewComment, files: readonly ReviewFile[]): string =>
  `${c.status === 'sent' ? '[sent] ' : ''}${where(c)}${isAttached(c, files) ? '' : ' (detached)'} ${c.text}`
