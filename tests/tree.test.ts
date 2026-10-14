import { expect, test } from 'claude-code/testing'

import { parseDiff } from '../hooks/diff'
import { listText } from '../hooks/text'
import { firstRows, isFolded, materialize, stepVisible, visibleRows } from '../hooks/tree'

const chunk = (path: string, hunks: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
  Array.from({ length: hunks }, (_, i) => `@@ -${i * 20 + 1},1 +${i * 20 + 1},2 @@\n a${i}\n+b${i}\n`).join('')

const many = (files: number, hunks: number) =>
  parseDiff(Array.from({ length: files }, (_, i) => chunk(`src/f${i}.js`, hunks)).join(''))

test('a small review is fully open, a big one keeps only the selected file open', async () => {
  const small = many(3, 2)
  expect(visibleRows(small, 'src/f0.js', { isAuto: true, paths: [] }).length).toBe(6)

  const big = many(30, 2)
  const visible = visibleRows(big, 'src/f4.js', { isAuto: true, paths: [] })
  // 29 folded files show one row each, the open one shows both hunks.
  expect(visible.length).toBe(31)
  expect(isFolded('src/f4.js', big, 'src/f4.js', { isAuto: true, paths: [] })).toBe(false)
  expect(isFolded('src/f5.js', big, 'src/f4.js', { isAuto: true, paths: [] })).toBe(true)
})

test('explicit folding follows the list; materialize keeps what auto showed', async () => {
  const big = many(20, 2)
  const manual = materialize(big, 'src/f2.js', { isAuto: true, paths: [] })
  expect(manual.isAuto).toBe(false)
  expect(manual.paths.length).toBe(19)
  expect(manual.paths.includes('src/f2.js')).toBe(false)
  expect(visibleRows(big, 'src/f2.js', { isAuto: false, paths: [] }).length).toBe(40)
  expect(firstRows(big).length).toBe(20)
})

test('moving one visible row at a time skips the hidden hunks of folded files', async () => {
  const visible = [0, 1, 2, 4, 6]
  expect(stepVisible(visible, 2, 1)).toBe(4)
  expect(stepVisible(visible, 4, -1)).toBe(2)
  expect(stepVisible(visible, 6, 1)).toBe(6)
  expect(stepVisible(visible, 0, -1)).toBe(0)
  // From a row the fold hid, forward lands on the next visible one, back on the previous.
  expect(stepVisible(visible, 3, 1)).toBe(4)
  expect(stepVisible(visible, 3, -1)).toBe(2)
})

test('a big review is listed per file, and a filter lists the hunks of matching files', async () => {
  const big = many(30, 2)
  const grouped = listText(big, [])
  expect(grouped.includes('src/f0.js  hunks 1-2 (2)')).toBe(true)
  expect(grouped.includes('/hunks list <part of a path>')).toBe(true)
  const filtered = listText(big, [], 'f17')
  expect(filtered.includes('src/f17.js:2')).toBe(true)
  expect(filtered.includes('src/f18.js')).toBe(false)
  expect(listText(big, [], 'nothing-here').includes('No pending hunks')).toBe(true)
  expect(listText(many(3, 2), []).includes('src/f1.js:2')).toBe(true)
})
