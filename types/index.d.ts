export type ReviewHunk = {
  /** Stable identity: hash of the file path and the hunk body. */
  id: string
  /** The `@@ -a,b +c,d @@ ...` line. */
  header: string
  /** The whole hunk, header line included, newline-terminated. */
  text: string
  added: number
  removed: number
}

export type ReviewFile = {
  path: string
  kind: 'modified' | 'added' | 'deleted' | 'binary' | 'mode'
  /** The file's whole diff chunk as git printed it (header, hunks, binary payload). */
  raw: string
  /** The chunk's lines before the first hunk, newline-terminated. */
  header: string
  hunks: ReviewHunk[]
}

export type ReviewSnapshot = {
  files: ReviewFile[]
  /** Tree the review is measured from; null before the first snapshot. */
  baseTree: string | null
  /** Tree of the working copy when this snapshot was taken. */
  currentTree: string | null
  /** Epoch ms. */
  takenAt: number
  /** Set when git could not be used (not a repository, git failed). */
  error?: string
}

/** One row of the review list: a hunk, or a file that has no hunks (binary, mode change). */
export type ReviewRow = { fileIndex: number; hunkIndex: number }

declare module 'claude-code' {
  interface PluginState {
    'hunk-review': {
      snapshot: ReviewSnapshot
      /** Index into the flattened rows. */
      selected: number
      /** One-line result of the last action, shown in the pane. */
      notice: string
      /** Set while a destructive bulk action waits for a second press. */
      confirm: string
      /** First visible line of the selected hunk's diff. */
      diffOffset: number
    }
  }
}
