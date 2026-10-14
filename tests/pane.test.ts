import { expect, test } from 'claude-code/testing'

test('the empty pane draws on the terminal and offers its actions', async $ => {
  const ui = await $.ui.mount({
    plugin: 'hunk-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'review',
    props: { bodyColumns: 100 },
  })
  expect(await ui.find({ type: 'Text', text: /Nothing to review/ })).toBeDefined()
  expect(await ui.find({ key: 'accept' })).toBeDefined()
  expect(await ui.find({ key: 'undo all' })).toBeDefined()
  await ui.unmount()
})

test('a pane with pending hunks draws its list, diff and footer', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'hunks', args: 'demo' })
  for (const placement of ['dock', 'inline'] as const) {
    const ui = await $.ui.mount({
      plugin: 'hunk-review',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'review',
      props: { bodyColumns: 100, placement, scroll: { offset: 0, bodyRows: 30 } },
    })
    expect(await ui.find({ key: 'row-0' })).toBeDefined()
    expect(await ui.find({ key: 'row-2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /server\.js/ })).toBeDefined()
    expect(await ui.find({ key: 'accept' })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.press({ key: 'row-0' })
    await ui.unmount()
  }
})

test('writing a comment shows it under the hunk and marks the list row', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'hunks', args: 'demo' })
  const ui = await $.ui.mount({
    plugin: 'hunk-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'review',
    props: { bodyColumns: 100, placement: 'dock', isFocused: true, scroll: { offset: 0, bodyRows: 40 } },
  })
  await ui.press({ key: 'next line' })
  await ui.press({ key: 'comment line 8' })
  expect(await ui.find({ key: 'comment' })).toBeDefined()
  await ui.input({ key: 'comment', text: 'log the request id too' })
  expect(await ui.find({ type: 'Text', text: /log the request id too/ })).toBeDefined()
  expect(await ui.find({ key: 'edit comment' })).toBeDefined()
  expect(await ui.find({ key: 'send to Claude (1)' })).toBeDefined()
  await ui.unmount()
})

test('a narrow pane still draws its list, diff and keys', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'hunks', args: 'demo' })
  const ui = await $.ui.mount({
    plugin: 'hunk-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'review',
    props: { bodyColumns: 48, placement: 'inline', scroll: { offset: 0, bodyRows: 18 } },
  })
  expect(await ui.find({ key: 'row-0' })).toBeDefined()
  expect(await ui.find({ key: 'accept' })).toBeDefined()
  expect(await ui.find({ key: 'send to Claude' })).toBeDefined()
  await ui.unmount()
})

test('a very narrow pane keeps the code of each row', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'hunks', args: 'demo' })
  const ui = await $.ui.mount({
    plugin: 'hunk-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'review',
    props: { bodyColumns: 24, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } },
  })
  expect(await ui.find({ type: 'Text', text: /app\.use/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^L\d/ })).toBeUndefined()
  await ui.unmount()
})

test('a big review opens one file at a time, folds on demand and moves by file', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'hunks', args: 'demo big' })
  const ui = await $.ui.mount({
    plugin: 'hunk-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'review',
    props: { bodyColumns: 100, placement: 'dock', isFocused: true, scroll: { offset: 0, bodyRows: 40 } },
  })
  // Automatic folding: only the selected file shows its hunks.
  expect(await ui.find({ key: 'row-0' })).toBeDefined()
  expect(await ui.find({ key: 'row-3' })).toBeUndefined()
  expect(await ui.find({ key: 'file-1' })).toBeDefined()
  await ui.press({ key: 'next file' })
  expect(await ui.find({ key: 'row-3' })).toBeDefined()
  expect(await ui.find({ key: 'row-0' })).toBeUndefined()
  await ui.press({ key: 'fold all' })
  await ui.press({ key: 'fold' })
  await ui.press({ key: 'file-2' })
  await ui.unmount()
})
