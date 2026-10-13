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
  expect(await ui.find({ key: 'undo-all' })).toBeDefined()
  await ui.unmount()
})
