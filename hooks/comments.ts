import type { ReviewComment, ReviewFile, ReviewHunk } from '../types'
import { hash, hunkSummary } from './diff'

const HUNK_CAP = 2500
const EXCERPT_LINES = 30

export const isOpen = (c: ReviewComment) => c.status !== 'resolved'

export const unresolved = (list: readonly ReviewComment[]): ReviewComment[] => list.filter(isOpen)

export const makeComment = (file: ReviewFile, hunk: ReviewHunk, text: string, now: number): ReviewComment => {
  const sum = hunkSummary(hunk)
  return {
    id: hash(`${file.path}\0${hunk.id}\0${now}\0${text}`),
    path: file.path,
    hunkId: hunk.id,
    line: sum.line,
    snippet: sum.snippet.slice(0, 120),
    hunk: hunk.text.slice(0, HUNK_CAP),
    text,
    status: 'open',
    createdAt: now,
  }
}

export const forHunk = (list: readonly ReviewComment[], path: string, hunkId: string): ReviewComment[] =>
  list.filter(c => isOpen(c) && c.path === path && c.hunkId === hunkId)

export const isAttached = (c: ReviewComment, files: readonly ReviewFile[]): boolean =>
  files.some(f => f.path === c.path && f.hunks.some(h => h.id === c.hunkId))

/**
 * When Claude edits the region again a hunk's id changes. A comment follows its
 * hunk to the one nearby that still changes the same line, or sits within a few
 * lines of where it was; otherwise it stays, detached, with the hunk it quoted.
 */
export const reattach = (list: readonly ReviewComment[], files: readonly ReviewFile[]): ReviewComment[] => {
  let changed = false
  const next = list.map(c => {
    if (!isOpen(c)) return c
    const file = files.find(f => f.path === c.path)
    if (!file || file.hunks.some(h => h.id === c.hunkId)) return c
    const candidates = file.hunks
      .map(h => ({ h, s: hunkSummary(h) }))
      .map(x => ({ ...x, d: Math.abs(x.s.line - c.line) }))
      .filter(x => (x.d <= 12 && x.s.snippet === c.snippet) || x.d <= 3)
      .sort((a, b) => a.d - b.d)
    const best = candidates[0]
    if (!best) return c
    changed = true
    return {
      ...c,
      hunkId: best.h.id,
      line: best.s.line,
      snippet: best.s.snippet.slice(0, 120),
      hunk: best.h.text.slice(0, HUNK_CAP),
    }
  })
  return changed ? next : (list as ReviewComment[])
}

const quote = (text: string) => text.split('\n').map(l => `> ${l}`).join('\n')

const excerpt = (hunk: string): string => {
  const lines = hunk.trimEnd().split('\n')
  const shown = lines.slice(0, EXCERPT_LINES).join('\n')
  return lines.length > EXCERPT_LINES ? `${shown}\n… (${lines.length - EXCERPT_LINES} more lines)` : shown
}

const entry = (c: ReviewComment, n: number): string =>
  `### ${n}. ${c.path}:${c.line}\n${quote(c.text)}\n\n\`\`\`diff\n${excerpt(c.hunk)}\n\`\`\``

/** The prompt `/hunks send` submits: every unresolved comment, with the hunk it is about. */
export const buildPrompt = (list: readonly ReviewComment[]): string =>
  [
    `I reviewed your changes and left ${list.length} comment${list.length === 1 ? '' : 's'}. ` +
      'Address each one, then I will review again. Each quotes the diff hunk it is about; ' +
      'line numbers are where the hunk was when I wrote the comment.',
    ...list.map((c, i) => entry(c, i + 1)),
  ].join('\n\n')

/** The hidden context `injectComments` attaches to the person's next prompt. */
export const buildContext = (list: readonly ReviewComment[]): string =>
  [
    'The person left review comments on your earlier changes in the hunk review pane. ' +
      'Take them into account in this turn:',
    ...list.map((c, i) => entry(c, i + 1)),
  ].join('\n\n')

export const describe = (c: ReviewComment, files: readonly ReviewFile[]): string =>
  `${c.status === 'sent' ? '[sent] ' : ''}${c.path}:${c.line}${isAttached(c, files) ? '' : ' (detached)'} ${c.text}`
