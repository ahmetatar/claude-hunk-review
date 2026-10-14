import type { ReviewComment, ReviewFile, ReviewHunk } from '../types'
import { forHunk, onLine, unresolved } from './comments'
import { countHunks, hunkLines, hunkSummary, rowsOf } from './diff'

const SHOW_CAP = 120

export const HELP =
  '/hunks show <n> · accept|undo <n | file <n> | all> · comment <n>[:line] <text> · send · open'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const GROUP_ABOVE = 40

/**
 * The pending hunks as a numbered list: the review without a pane. A review of
 * many hunks is summarised per file instead; a filter (part of a path) lists the
 * hunks of the files it matches, numbered as in the whole review.
 */
export const listText = (
  files: readonly ReviewFile[],
  comments: readonly ReviewComment[],
  filter = '',
): string => {
  if (files.length === 0) return 'No pending changes.'
  const open = unresolved(comments).length
  const head =
    `Review: ${files.length} file${files.length === 1 ? '' : 's'}, ${countHunks(files)} hunks pending` +
    (open > 0 ? ` · ${open} open comment${open === 1 ? '' : 's'}` : '')
  const rows = rowsOf(files)
  const width = String(rows.length).length
  const wanted = filter === '' ? rows.map((r, i) => i) : rows.map((r, i) => i).filter(i => files[rows[i]!.fileIndex]?.path.includes(filter))
  if (wanted.length === 0) return `${head}\nNo pending hunks in files matching "${filter}".`

  if (filter === '' && rows.length > GROUP_ABOVE) {
    const lines = files.map((file, fileIndex) => {
      const idx = rows.map((r, i) => (r.fileIndex === fileIndex ? i + 1 : 0)).filter(Boolean)
      const noted = file.hunks.reduce((n, h) => n + forHunk(comments, file.path, h.id).length, 0)
      const range = idx.length > 1 ? `${idx[0]}-${idx[idx.length - 1]}` : `${idx[0]}`
      const added = file.hunks.reduce((n, h) => n + h.added, 0)
      const removed = file.hunks.reduce((n, h) => n + h.removed, 0)
      const counts = [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean).join(' ')
      return `${file.path}  hunks ${range}${file.hunks.length > 1 ? ` (${file.hunks.length})` : ''}  ${file.hunks.length === 0 ? file.kind : counts}${noted > 0 ? `  ✎${noted}` : ''}`
    })
    return [head, ...lines, '', 'Many hunks: /hunks list <part of a path> lists the hunks of matching files.', HELP].join('\n')
  }

  const lines = wanted.map(i => {
    const row = rows[i]!
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
