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
