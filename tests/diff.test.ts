import { expect, test } from 'claude-code/testing'

import { allPatch, countHunks, hunkLines, hunkPatch, hunkSummary, parseDiff, rowsOf } from '../hooks/diff'
import { buildPrompt, forHunk, isAttached, makeComment, reattach, unresolved } from '../hooks/comments'
import { langOf, markRange, tokenize } from '../hooks/highlight'

const MODIFIED = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,4 @@
 one
+two
 three
 four
@@ -20,3 +21,3 @@ function f() {
 x
-y
+z
 w
`

const ADDED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`

const BINARY = `diff --git a/img.png b/img.png
new file mode 100644
index 0000000..4444444
GIT binary patch
literal 4
LcmZQzU|?VZ0RaDX

`

test('parses files and hunks', async () => {
  const files = parseDiff(MODIFIED + ADDED)
  expect(files.length).toBe(2)
  expect(files[0]?.path).toBe('src/a.js')
  expect(files[0]?.kind).toBe('modified')
  expect(files[0]?.hunks.length).toBe(2)
  expect(files[0]?.hunks[0]?.added).toBe(1)
  expect(files[0]?.hunks[1]?.removed).toBe(1)
  expect(files[1]?.kind).toBe('added')
  expect(files[1]?.hunks[0]?.added).toBe(2)
})

test('a hunk patch is the file header plus that hunk alone', async () => {
  const [file] = parseDiff(MODIFIED)
  const patch = hunkPatch(file!, file!.hunks[1])
  expect(patch.startsWith('diff --git a/src/a.js b/src/a.js\n')).toBe(true)
  expect(patch.includes('+z')).toBe(true)
  expect(patch.includes('+two')).toBe(false)
  expect(patch.endsWith('\n')).toBe(true)
})

test('hunk ids survive renumbering of other hunks', async () => {
  const before = parseDiff(MODIFIED)[0]!.hunks[1]!
  const afterText = MODIFIED.replace('@@ -1,3 +1,4 @@\n one\n+two\n three\n four\n', '').replace('@@ -20,3 +21,3 @@', '@@ -20,3 +20,3 @@')
  const after = parseDiff(afterText)[0]!.hunks[0]!
  expect(after.id).toBe(before.id)
})

test('identical hunks in one file get distinct ids', async () => {
  const twin = `diff --git a/t b/t
--- a/t
+++ b/t
@@ -1,1 +1,2 @@
 a
+b
@@ -10,1 +11,2 @@
 a
+b
`
  const hunks = parseDiff(twin)[0]!.hunks
  expect(hunks.length).toBe(2)
  expect(hunks[0]!.id === hunks[1]!.id).toBe(false)
})

test('binary files have no hunks and are one row', async () => {
  const files = parseDiff(BINARY)
  expect(files[0]?.kind).toBe('binary')
  expect(files[0]?.hunks.length).toBe(0)
  expect(rowsOf(files).length).toBe(1)
  expect(countHunks(files)).toBe(1)
  expect(allPatch(files)).toBe(files[0]!.raw)
})

test('rows are one per hunk across files', async () => {
  const files = parseDiff(MODIFIED + ADDED + BINARY)
  expect(rowsOf(files).length).toBe(4)
})

test('hunk lines are numbered and paired lines get a word mark', async () => {
  const [file] = parseDiff(MODIFIED)
  const lines = hunkLines(file!.hunks[1]!)
  expect(lines.map(l => l.kind).join(',')).toBe('ctx,del,add,ctx')
  expect(lines[0]?.oldNo).toBe(20)
  expect(lines[0]?.newNo).toBe(21)
  expect(lines[1]?.oldNo).toBe(21)
  expect(lines[2]?.newNo).toBe(22)
  expect(lines[1]?.mark).toBeUndefined()

  const edit = parseDiff(`diff --git a/t b/t
--- a/t
+++ b/t
@@ -1,1 +1,1 @@
-const total = price * 2
+const total = price * 3
`)
  const pair = hunkLines(edit[0]!.hunks[0]!)
  expect(pair[0]?.mark?.join('-')).toBe('22-23')
  expect(pair[1]?.mark?.join('-')).toBe('22-23')
})

test('the highlighter classifies tokens and marks a range', async () => {
  const toks = tokenize("const x = foo(1, 'a') // hi", 'clike')
  const kinds = Object.fromEntries(toks.map(t => [t.text.trim(), t.kind]))
  expect(kinds['const']).toBe('keyword')
  expect(kinds['foo']).toBe('func')
  expect(kinds["'a'"]).toBe('string')
  expect(kinds['1']).toBe('number')
  expect(kinds['// hi']).toBe('comment')
  expect(langOf('src/a.tsx')).toBe('clike')
  expect(langOf('x.py')).toBe('hash')
  const marked = markRange(tokenize('abc def', 'plain'), [2, 5])
  expect(marked.map(t => `${t.text}:${t.isMarked}`).join('|')).toBe('ab:false|c d:true|ef:false')
})

test('a hunk summary names the first changed line', async () => {
  const [file] = parseDiff(MODIFIED)
  const sum = hunkSummary(file!.hunks[0]!)
  expect(sum.snippet).toBe('two')
  expect(sum.line).toBe(2)
})

test('comments follow an edited hunk and build a prompt', async () => {
  const files = parseDiff(MODIFIED)
  const hunk = files[0]!.hunks[1]!
  const c = makeComment(files[0]!, hunk, 'use const here', 1)
  expect(isAttached(c, files)).toBe(true)
  expect(forHunk([c], 'src/a.js', hunk.id).length).toBe(1)

  // Claude rewrites the same region: the hunk id changes, the line barely moves.
  const edited = parseDiff(MODIFIED.replace('-y\n+z', '-y\n+zz'))
  expect(isAttached(c, edited)).toBe(false)
  const [moved] = reattach([c], edited)
  expect(moved?.hunkId).toBe(edited[0]!.hunks[1]!.id)
  expect(isAttached(moved!, edited)).toBe(true)

  // A hunk far away is not adopted.
  const far = parseDiff(MODIFIED.replace('@@ -20,3 +21,3 @@', '@@ -90,3 +91,3 @@').replace('-y\n+z', '-q\n+r'))
  expect(reattach([c], far)[0]?.hunkId).toBe(c.hunkId)

  const prompt = buildPrompt([c])
  expect(prompt.includes('src/a.js:21')).toBe(true)
  expect(prompt.includes('> use const here')).toBe(true)
  expect(prompt.includes('```diff')).toBe(true)
  expect(unresolved([{ ...c, status: 'resolved' }]).length).toBe(0)
})
