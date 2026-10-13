import type { ReviewFile, ReviewHunk, ReviewRow } from '../types'

// FNV-1a, 32 bit: a short stable id, no async crypto needed.
export const hash = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const splitLines = (text: string): string[] => {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const pathOf = (chunk: string[]): string => {
  const plus = chunk.find(l => l.startsWith('+++ '))
  if (plus && plus !== '+++ /dev/null') return plus.slice(4).replace(/^b\//, '')
  const minus = chunk.find(l => l.startsWith('--- '))
  if (minus && minus !== '--- /dev/null') return minus.slice(4).replace(/^a\//, '')
  const head = /^diff --git a\/(.+) b\/(.+)$/.exec(chunk[0] ?? '')
  return head?.[2] ?? head?.[1] ?? '(unknown)'
}

const kindOf = (chunk: string[], hasHunks: boolean): ReviewFile['kind'] => {
  if (chunk.some(l => l.startsWith('GIT binary patch') || l.startsWith('Binary files'))) return 'binary'
  if (chunk.some(l => l.startsWith('new file mode'))) return 'added'
  if (chunk.some(l => l.startsWith('deleted file mode'))) return 'deleted'
  return hasHunks ? 'modified' : 'mode'
}

/**
 * Parses `git diff --binary --no-renames` output into files and hunks.
 * A hunk's id is the hash of its path and body, so it survives the
 * renumbering other hunks' accept or undo causes.
 */
export const parseDiff = (output: string): ReviewFile[] => {
  const lines = splitLines(output)
  const chunks: string[][] = []
  for (const line of lines) {
    if (line.startsWith('diff --git ')) chunks.push([line])
    else chunks[chunks.length - 1]?.push(line)
  }

  return chunks.map(chunk => {
    const firstHunk = chunk.findIndex(l => l.startsWith('@@ '))
    const isBinaryPayload = chunk.some(l => l.startsWith('GIT binary patch'))
    const headerLines = firstHunk === -1 ? chunk : chunk.slice(0, firstHunk)
    const path = pathOf(chunk)
    const seen = new Map<string, number>()
    const hunks: ReviewHunk[] = []

    if (firstHunk !== -1 && !isBinaryPayload) {
      let current: string[] | undefined
      const flush = () => {
        if (!current) return
        const text = current.join('\n') + '\n'
        const body = current.slice(1).join('\n')
        const base = hash(path + '\0' + body)
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        hunks.push({
          id: n === 0 ? base : `${base}.${n}`,
          header: current[0] ?? '',
          text,
          added: current.filter((l, i) => i > 0 && l.startsWith('+')).length,
          removed: current.filter((l, i) => i > 0 && l.startsWith('-')).length,
        })
      }
      for (const line of chunk.slice(firstHunk)) {
        if (line.startsWith('@@ ')) {
          flush()
          current = [line]
        } else current?.push(line)
      }
      flush()
    }

    return {
      path,
      kind: kindOf(chunk, hunks.length > 0),
      raw: chunk.join('\n') + '\n',
      header: headerLines.join('\n') + '\n',
      hunks,
    }
  })
}

/** The rows the review list shows: one per hunk, one per file without hunks. */
export const rowsOf = (files: readonly ReviewFile[]): ReviewRow[] =>
  files.flatMap((file, fileIndex) =>
    file.hunks.length === 0
      ? [{ fileIndex, hunkIndex: -1 }]
      : file.hunks.map((_, hunkIndex) => ({ fileIndex, hunkIndex })),
  )

/** A patch that applies one hunk (or, for a hunkless file, the whole chunk). */
export const hunkPatch = (file: ReviewFile, hunk: ReviewHunk | undefined): string =>
  hunk ? file.header + hunk.text : file.raw

export const filePatch = (file: ReviewFile): string => file.raw

export const allPatch = (files: readonly ReviewFile[]): string => files.map(f => f.raw).join('')

export const countHunks = (files: readonly ReviewFile[]): number =>
  files.reduce((n, f) => n + Math.max(1, f.hunks.length), 0)

export type DiffLine = {
  kind: 'add' | 'del' | 'ctx' | 'meta'
  text: string
  oldNo?: number
  newNo?: number
  /** Range of `text` that differs from its paired line (word-level highlight). */
  mark?: readonly [number, number]
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// Below this share of shared characters two lines are rewrites, not edits: no word highlight.
const SIMILARITY = 0.3

const pairMarks = (del: DiffLine, add: DiffLine) => {
  const a = del.text
  const b = add.text
  const max = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < max && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  if (prefix + suffix < SIMILARITY * Math.max(a.length, b.length)) return
  if (prefix === 0 && suffix === 0) return
  if (a.length - suffix > prefix) del.mark = [prefix, a.length - suffix]
  if (b.length - suffix > prefix) add.mark = [prefix, b.length - suffix]
}

/** A hunk as numbered display lines, with word-level marks on paired -/+ lines. */
export const hunkLines = (hunk: ReviewHunk): DiffLine[] => {
  const raw = splitLines(hunk.text)
  const m = HEADER.exec(raw[0] ?? '')
  let oldNo = m ? Number(m[1]) : 1
  let newNo = m ? Number(m[2]) : 1
  const lines: DiffLine[] = []
  for (const line of raw.slice(1)) {
    const text = line.slice(1).replace(/\t/g, '  ').replace(/\r$/, '')
    if (line.startsWith('+')) lines.push({ kind: 'add', text, newNo: newNo++ })
    else if (line.startsWith('-')) lines.push({ kind: 'del', text, oldNo: oldNo++ })
    else if (line.startsWith('\\')) lines.push({ kind: 'meta', text: line.slice(1).trim() })
    else lines.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ })
  }
  // Pair a run of removed lines with the added run that follows, one to one.
  for (let i = 0; i < lines.length; ) {
    if (lines[i]?.kind !== 'del') {
      i++
      continue
    }
    let d = i
    while (lines[d]?.kind === 'del') d++
    let a = d
    while (lines[a]?.kind === 'add') a++
    if (d - i === a - d) {
      for (let k = 0; k < d - i; k++) pairMarks(lines[i + k]!, lines[d + k]!)
    }
    i = Math.max(a, i + 1)
  }
  return lines
}

/** What a hunk list row shows: where the hunk starts and the first line it changes. */
export const hunkSummary = (hunk: ReviewHunk): { line: number; snippet: string } => {
  const lines = hunkLines(hunk)
  const first =
    lines.find(l => (l.kind === 'add' || l.kind === 'del') && l.text.trim() !== '') ??
    lines.find(l => l.kind !== 'meta' && l.text.trim() !== '')
  const m = HEADER.exec(hunk.header)
  const line = Number(m?.[2] ?? m?.[1] ?? 1)
  const at = first?.newNo ?? first?.oldNo ?? line
  return { line: at, snippet: first?.text.trim() ?? '' }
}
