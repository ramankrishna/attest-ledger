import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { claimsOf, EMPTY, isTestLike, maskOf, parseConfig } from '../hooks/ledger'

const ROOT = '/repo'
const CONFIG = JSON.stringify({
  gates: [{ name: 'unit', command: 'pytest -q' }],
  frozen: ['gates.json'],
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'attest',
  props: {
    title: 'Attest',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type World = {
  /** Commands the shell fails, by a word they hold. */
  failing: string[]
  /** What the person answers when asked about a frozen file. */
  answer: string
  asked: string[]
  toasts: string[]
}

/** The engine beneath the mod: a project with a config, a shell and a person. */
function world(on: On, config: string | null = CONFIG): World {
  const state: World = { failing: [], answer: 'Refuse', asked: [], toasts: [] }

  mock.store(on)
  mock.clock(on)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: config !== null && e.path === `${ROOT}/.attest.json` }))
  on('fs.read', () => ({ value: config ?? '' }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // What the engine draws at a site when no mod draws there.
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const [first] = e.questions
      const question = first?.question ?? ''

      state.asked.push(question)

      return { result: { questions: e.questions, answers: { [question]: state.answer } } }
    }
    if (e.tool === 'Bash' && state.failing.some(word => e.command.includes(word))) {
      return { isError: true, result: 'Exit code 1', text: 'Exit code 1\n1 failed' }
    }

    return { result: {} }
  })

  return state
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const

const answerOf = (text: string, turnId: string) =>
  ({ answer: text, durationMs: 10, isAborted: false, turnId, reason: 'answer' }) as const

describe('the rules', () => {
  test('a hedged or failing sentence is no claim', () => {
    expect(claimsOf(EMPTY, 'The tests should pass once the fixture is updated.')).toEqual([])
    expect(claimsOf(EMPTY, 'Two tests fail and I have not fixed them.')).toEqual([])
    expect(claimsOf(EMPTY, 'I renamed the helper and moved it.')).toEqual([])
  })

  test('a claim with nothing run is unbacked', () => {
    const [claim] = claimsOf(EMPTY, 'Fixed the parser. All tests pass.')

    expect(claim?.verdict).toBe('unbacked')
    expect(claim?.text).toBe('All tests pass.')
  })

  test('what hides an exit code is named', () => {
    expect(maskOf('pytest -q || true')).toBe('|| true')
    expect(maskOf('pytest -q | tail -5')).toBe('a pipe without pipefail')
    expect(maskOf('set -o pipefail; pytest -q | tail -5')).toBe(null)
    expect(maskOf('pytest -q && ruff check .')).toBe(null)
  })

  test('installing a test runner is not running tests', () => {
    expect(isTestLike('pip install pytest')).toBe(false)
    expect(isTestLike('cd api && npm test')).toBe(true)
    expect(isTestLike('ls tests')).toBe(false)
  })

  test('a config that is wrong says how', () => {
    expect(parseConfig('{')).toBe('not valid JSON')
    expect(parseConfig('{"gates":[{"name":"unit"}]}')).toBe('gate unit needs a "command"')
    expect(parseConfig(CONFIG)).toMatchObject({ frozen: ['gates.json'] })
  })
})

describe('the ledger', () => {
  test('a pass backs a claim until a file changes', async ($, on) => {
    world(on)
    await $.session.start(START)

    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q' })

    const backed = await $.turn.complete(answerOf('Fixed it. All tests pass.', 't1'))

    expect(backed.text).toBe('attest: 1 claim · all backed')

    await $.turn.start({ text: 'one more change', turnId: 't2' })
    await $.tool.call({
      tool: 'Edit',
      tool_use_id: 'e1',
      file_path: `${ROOT}/src/parser.py`,
      old_string: 'a',
      new_string: 'b',
    })

    const stale = await $.turn.complete(answerOf('Done, the unit gate is still green.', 't2'))

    expect(stale.text).toBe('attest: 1 claim · 0 backed · 1 stale')
  })

  test('a failed run contradicts the claim and marks the gate seen red', async ($, on) => {
    const state = world(on)

    state.failing = ['pytest']
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q' })

    const done = await $.turn.complete(answerOf('All tests pass now.', 't1'))

    expect(done.text).toBe('attest: 1 claim · 0 backed · 1 unbacked')

    // The same gate passing later has been seen failing: no nudge about it.
    state.failing = []
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'pytest -q' })
    expect(state.toasts).toEqual([])
  })

  test('a gate that passes without ever failing is called unproven, once', async ($, on) => {
    const state = world(on)

    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'pytest -q' })

    expect(state.toasts).toEqual(['unit has never failed. Break it once before you trust it.'])
  })

  test('a masked exit code does not count as a pass', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'check', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q || true' })

    const done = await $.turn.complete(answerOf('The tests pass.', 't1'))

    expect(done.text).toBe('attest: 1 claim · 0 backed · 1 unbacked')
  })

  test('with no config a test command is still watched', async ($, on) => {
    world(on, null)
    await $.session.start(START)
    await $.turn.start({ text: 'check', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })

    const done = await $.turn.complete(answerOf('Tests pass.', 't1'))

    expect(done.text).toBe('attest: 1 claim · all backed')
  })

  test('an answer with no claim is left alone', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'rename', turnId: 't1' })

    const done = await $.turn.complete(answerOf('Renamed the helper.', 't1'))

    expect(done.text).toBe('Renamed the helper.')
  })
})

describe('the guard', () => {
  const EDIT = {
    tool: 'Edit',
    tool_use_id: 'e1',
    file_path: `${ROOT}/gates.json`,
    old_string: '>= 195',
    new_string: '>= 150',
  } as const

  test('a frozen file is not edited unless the person allows it', async ($, on) => {
    const state = world(on)

    await $.session.start(START)

    const refused = await $.tool.call(EDIT)

    expect(refused.deny).toMatch(/gates\.json is frozen/)
    expect(state.asked[0]).toMatch(/">= 195" to ">= 150"/)

    state.answer = 'Allow once'

    const allowed = await $.tool.call({ ...EDIT, tool_use_id: 'e2' })

    expect(allowed.deny).toBe(undefined)
  })

  test('the config itself is frozen, and a shell write to it is asked about', async ($, on) => {
    const state = world(on)

    await $.session.start(START)

    const refused = await $.tool.call({
      tool: 'Bash',
      tool_use_id: 'b1',
      command: 'echo "{}" > .attest.json',
    })

    expect(refused.deny).toMatch(/\.attest\.json is frozen/)
    expect(state.asked).toHaveLength(1)

    // Reading it is nobody's business to ask about.
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'cat .attest.json' })
    expect(state.asked).toHaveLength(1)
  })

  test('an ordinary file is edited without a question', async ($, on) => {
    const state = world(on)

    await $.session.start(START)
    await $.tool.call({ ...EDIT, file_path: `${ROOT}/src/app.py` })

    expect(state.asked).toEqual([])
  })
})

describe('the drawing', () => {
  test('the band stays empty until there is something to say', async ($, on) => {
    world(on, null)
    await $.session.start(START)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'attest-ledger', surface, ...BAND })

      expect(await ui.find({ text: /attest/ })).toBe(undefined)
      await ui.unmount()
    }
  })

  test('the band leads with the worst thing', async ($, on) => {
    const state = world(on)

    state.failing = ['pytest']
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'attest-ledger', surface, ...BAND })

      expect(await ui.find({ type: 'Text', text: /unit FAIL/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'gates 0/1 green' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the pane switches tabs and shows what was watched', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q' })
    await $.turn.complete(answerOf('All tests pass.', 't1'))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'attest-ledger', surface, ...PANE })

      await ui.press({ key: 'tab-gates' })
      expect(await ui.find({ type: 'Text', text: 'PASS' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /never seen red/ })).toBeDefined()

      await ui.press({ key: 'tab-claims' })
      expect(await ui.find({ type: 'Text', text: 'BACKED' })).toBeDefined()

      await ui.press({ key: 'tab-runs' })
      expect(await ui.find({ type: 'Text', text: /pytest -q/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a watched run gets its line under the tool result', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q' })

    const ui = await $.ui.mount({
      plugin: 'attest-ledger',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'b1',
      props: { tool_use_id: 'b1', tool: 'Bash', output: {}, isErrored: false },
    })

    expect(await ui.find({ type: 'Text', text: /gate unit PASS · run #1/ })).toBeDefined()
    await ui.unmount()
  })
})
