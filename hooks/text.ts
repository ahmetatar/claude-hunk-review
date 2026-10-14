import type { ReviewComment, ReviewFile, ReviewHunk } from '../types'
import { forHunk, onLine, unresolved } from './comments'
import { countHunks, hunkLines, hunkSummary, rowsOf } from './diff'

const SHOW_CAP = 120

export const HELP =
  '/hunks show <n> · accept|undo <n | file <n> | all> · comment <n>[:line] <text> · send · open'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The pending hunks as a numbered list: the review without a pane. */
export const listText = (files: readonly ReviewFile[], comments: readonly ReviewComment[]): string => {
  if (files.length === 0) return 'No pending changes.'
  const open = unresolved(comments).length
  const head =
    `Review: ${files.length} file${files.length === 1 ? '' : 's'}, ${countHunks(files)} hunks pending` +
    (open > 0 ? ` · ${open} open comment${open === 1 ? '' : 's'}` : '')
  const rows = rowsOf(files)
  const width = String(rows.length).length
  const lines = rows.map((row, i) => {
    const file = files[row.fileIndex]
    const hunk = row.hunkIndex >= 0 ? file?.hunks[row.hunkIndex] : undefined
    const no = String(i + 1).padStart(width)
    if (!file) return ''
    if (!hunk) return `${no}  ${file.path}  (${file.kind})`
    const sum = hunkSummary(hunk)
    const noted = forHunk(comments, file.path, hunk.id).length
    const counts = [hunk.added > 0 ? `+${hunk.added}` : '', hunk.removed > 0 ? `−${hunk.removed}` : ''].filter(Boolean).join(' ')
    return `${no}  ${file.path}:${sum.line}  ${clip(sum.snippet, 48)}  ${counts}${noted > 0 ? `  ✎${noted}` : ''}`
  })
  return [head, ...lines, '', HELP].join('\n')
}

/** One hunk as text: marker, line number and code, comments under their lines. */
export const hunkView = (
  file: ReviewFile,
  hunk: ReviewHunk,
  comments: readonly ReviewComment[],
  n: number,
  total: number,
): string => {
  const here = forHunk(comments, file.path, hunk.id)
  const lines = hunkLines(hunk)
  const width = String(Math.max(...lines.map(l => l.newNo ?? l.oldNo ?? 0), 1)).length
  const out: string[] = [`${file.path}  hunk ${n}/${total}  ${hunk.header.split('@@')[1]?.trim() ?? ''}`]
  for (const l of lines.slice(0, SHOW_CAP)) {
    if (l.kind === 'meta') {
      out.push(`    ${l.text}`)
      continue
    }
    const no = String(l.newNo ?? l.oldNo ?? '').padStart(width)
    out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '} ${no}${l.kind === 'del' ? '−' : ' '}${l.text}`)
    for (const c of here.filter(c => onLine(c, { line: l.newNo ?? l.oldNo ?? 0, isOld: l.kind === 'del' }))) {
      out.push(`  ✎ ${c.text}`)
    }
  }
  if (lines.length > SHOW_CAP) out.push(`… ${lines.length - SHOW_CAP} more lines`)
  out.push('', `/hunks accept ${n} · /hunks undo ${n} · /hunks comment ${n}:<line> <text>`)
  return out.join('\n')
}
