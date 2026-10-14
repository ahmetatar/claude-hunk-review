import type { ReviewFile, ReviewFold } from '../types'
import { rowsOf } from './diff'

/** Folding of files in the list. `isAuto` keeps only the selected file open once a review is big. */
export type Fold = ReviewFold

export const AUTO_FOLD_ABOVE = 12

export const isFolded = (
  path: string,
  files: readonly ReviewFile[],
  selectedPath: string | undefined,
  fold: Fold,
): boolean => (fold.isAuto ? files.length > AUTO_FOLD_ABOVE && path !== selectedPath : fold.paths.includes(path))

/** Indexes (into `rowsOf`) the list shows: every hunk of an open file, the first row only of a folded one. */
export const visibleRows = (files: readonly ReviewFile[], selectedPath: string | undefined, fold: Fold): number[] => {
  const out: number[] = []
  const seen = new Set<number>()
  rowsOf(files).forEach((row, i) => {
    const file = files[row.fileIndex]
    if (!file) return
    const first = !seen.has(row.fileIndex)
    seen.add(row.fileIndex)
    if (first || !isFolded(file.path, files, selectedPath, fold)) out.push(i)
  })
  return out
}

/** Index of the first row of each file, in file order. */
export const firstRows = (files: readonly ReviewFile[]): number[] => {
  const out: number[] = []
  const seen = new Set<number>()
  rowsOf(files).forEach((row, i) => {
    if (!seen.has(row.fileIndex)) {
      seen.add(row.fileIndex)
      out.push(i)
    }
  })
  return out
}

/** The next row to land on moving `delta` visible rows from `from` (which may itself be hidden). */
export const stepVisible = (visible: readonly number[], from: number, delta: number): number => {
  if (visible.length === 0) return 0
  const at = visible.findIndex(v => v >= from)
  const pos = at === -1 ? visible.length - 1 : at
  const exact = visible[pos] === from
  const target = exact ? pos + delta : delta > 0 ? pos + delta - 1 : pos + delta
  return visible[Math.max(0, Math.min(visible.length - 1, target))] ?? 0
}

/** Switches to explicit folding, keeping what the automatic rule showed. */
export const materialize = (
  files: readonly ReviewFile[],
  selectedPath: string | undefined,
  fold: Fold,
): Fold =>
  fold.isAuto
    ? { isAuto: false, paths: files.filter(f => isFolded(f.path, files, selectedPath, fold)).map(f => f.path) }
    : fold
