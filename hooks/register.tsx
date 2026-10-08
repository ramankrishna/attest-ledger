// Attest: what ran, next to what Claude said ran.
//
// The host watches every check Claude runs (a declared gate or a test-like
// command) and every file it changes, then reads each answer for success
// claims and says which the ledger backs. Nothing here asks a model anything.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tab } from '../types'
import {
  addClaims,
  applyConfig,
  bashFrozenHit,
  checkOf,
  claimsOf,
  clip,
  CONFIG,
  EMPTY,
  exitOf,
  gateLabel,
  gateNote,
  isFrozen,
  isJunk,
  maskOf,
  parseConfig,
  recordEdit,
  recordRun,
  relative,
  runLine,
  runTone,
  seconds,
  setRunning,
  summarize,
  turnLine,
  verdictTone,
} from './ledger'

const PANE = 'attest'
const REFUSE = 'Refuse'
const ALLOW = 'Allow once'

const ledger = atom({ plugin: 'attest-ledger', key: 'ledger' } as const, EMPTY)
const tab = atom({ plugin: 'attest-ledger', key: 'tab' } as const, 'gates')

// What the guards read without a call on `$`: a `.catch` handler may not make
// one, and a guard that cannot tell must still refuse a frozen file.
let root = ''
let frozen: readonly string[] = []
const toasted = new Set<string>()

const redKey = (gate: string): string => `red:${root}:${gate}`

const denyText = (path: string): string =>
  `attest: ${path} is frozen in this repository and the user did not allow the change. ` +
  'Leave it as it is, report the result you got, and ask before trying another way.'

/** Reads `.attest.json` at the project root and lays it over the ledger. */
async function load($: EngineInterface): Promise<void> {
  root = await $.session.root()

  const path = `${root}/${CONFIG}`

  if (!(await $.fs.exists(path))) {
    frozen = []
    await update($, ledger, was => applyConfig(was, null, {}))

    return
  }

  let text = ''

  try {
    text = await $.fs.read(path)
  } catch {
    text = ''
  }

  const config = parseConfig(text)

  if (typeof config === 'string') {
    // A config that does not parse stays frozen: the guard outlives the typo.
    frozen = [CONFIG]
    await update($, ledger, was => ({
      ...was,
      hasConfig: true,
      configError: config,
      frozen: [CONFIG],
    }))

    return
  }

  const seenRed: Record<string, boolean> = {}

  for (const gate of config.gates) {
    seenRed[gate.name] = (await $.store.get(redKey(gate.name))) !== undefined
  }

  frozen = [CONFIG, ...config.frozen]
  await update($, ledger, was => applyConfig(was, config, seenRed))
}

/** Writes a starter `.attest.json` fitted to what the project root holds. */
async function init($: EngineInterface): Promise<string> {
  root = await $.session.root()

  const path = `${root}/${CONFIG}`

  if (await $.fs.exists(path)) return `${CONFIG} already exists. Edit it, then run /attest.`

  const guesses: ReadonlyArray<readonly [string, string, string]> = [
    ['package.json', 'unit', 'npm test'],
    ['Cargo.toml', 'unit', 'cargo test'],
    ['go.mod', 'unit', 'go test ./...'],
    ['pyproject.toml', 'unit', 'pytest -q'],
    ['pytest.ini', 'unit', 'pytest -q'],
    ['Makefile', 'check', 'make test'],
  ]
  let gate = { name: 'unit', command: 'pytest -q' }

  for (const [file, name, command] of guesses) {
    if (await $.fs.exists(`${root}/${file}`)) {
      gate = { name, command }
      break
    }
  }

  await $.fs.write(path, `${JSON.stringify({ gates: [gate], frozen: [] }, null, 2)}\n`)
  await load($)

  return `Wrote ${CONFIG} with one gate, ${gate.name}: ${gate.command}. Edit it to add yours; the file is frozen to Claude from now on.`
}

/** Asks the person before a frozen file changes; anything but Allow refuses. */
async function isAllowed($: EngineInterface, what: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(`Claude wants to ${what}, which is frozen here. Allow it?`, {
      header: 'attest',
      options: [REFUSE, ALLOW],
    })

    return answer === ALLOW
  } catch {
    // Dismissed, or nobody to ask (`claude -p`): the safe answer stands.
    return false
  }
}

/** After a run landed: remember a gate seen failing, nudge about one never seen so. */
async function settle($: EngineInterface, id: string): Promise<void> {
  const now = await read($, ledger)
  const run = now.runs.find(one => one.id === id)

  if (run === undefined || run.gate === null || run.masked !== null) return

  if (!run.ok) {
    await $.store.set(redKey(run.gate), true)

    return
  }

  const gate = now.gates.find(one => one.name === run.gate)

  if (gate !== undefined && !gate.seenRed && !toasted.has(gate.name)) {
    toasted.add(gate.name)
    $.ui.toast(`${gate.name} has never failed. Break it once before you trust it.`)
  }
}

/** Runs gates itself, on the person's press: the exit code is the host's own. */
async function runGates($: EngineInterface, which: 'all' | 'stale'): Promise<void> {
  const before = await read($, ledger)
  const todo = before.gates.filter(gate => which === 'all' || gate.status !== 'pass')

  for (const gate of todo) {
    await update($, ledger, was => setRunning(was, gate.name, true))

    const started = await $.clock.now()
    let exit: number | null = null
    let ok = false

    try {
      const ran = await $.process.run(['sh', '-c', gate.command], {
        cwd: root,
        timeoutMs: gate.timeoutSec * 1000,
      })

      exit = ran.exitCode
      ok = ran.exitCode === 0
    } catch {
      // Timed out or could not start: a run that did not pass.
      ok = false
    }

    const ms = (await $.clock.now()) - started
    const id = `direct-${gate.name}-${started}`

    await update($, ledger, was =>
      recordRun(was, {
        id,
        command: gate.command,
        ok,
        exit,
        ms,
        masked: maskOf(gate.command),
        gate: gate.name,
      }),
    )
    await settle($, id)
  }
}

const openPane = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: 'Attest', focus: true, closeOnEscape: true })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'attest',
      description: 'Show what ran next to what Claude said ran',
      argumentHint: '[init]',
    })
    await load($)

    return next(e)
  })

  // /clear, /resume and /branch reset the session's state and raise no
  // session.start: read the config again so the gates and guards come back.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await load($)

    return next(e)
  })

  on('command.run', { command: 'attest' }, async ($, e) => {
    if (e.args.trim() === 'init') return { text: await init($) }

    await load($)
    await openPane($)

    return {}
  })

  // ------------------------------------------------------------ watching

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const hit = bashFrozenHit(frozen, e.command)

    if (hit !== null && !(await isAllowed($, `run a command that writes ${hit}`))) {
      return { deny: denyText(hit) }
    }

    const check = checkOf(await read($, ledger), e.command)
    const started = await $.clock.now()
    const ran = await next(e)

    if (ran.deny !== undefined) return ran

    const ms = (await $.clock.now()) - started
    const record = ran.isError === true ? undefined : ran.result
    const isBackground = record?.backgroundTaskId !== undefined

    if (check !== null) {
      await update($, ledger, was =>
        recordRun(was, {
          id: e.tool_use_id,
          command: e.command,
          ok: ran.isError !== true && record?.interrupted !== true,
          exit: ran.isError === true ? exitOf(ran.text) : null,
          ms,
          masked: isBackground ? 'running in the background' : maskOf(e.command),
          gate: check.gate,
        }),
      )
      await settle($, e.tool_use_id)
    } else {
      // A shell command that changed files stales a pass as an edit does.
      const changed = (record?.bashEditDiff?.files ?? [])
        .map(file => relative(root, file.filePath))
        .filter(path => !isJunk(path))
        .slice(0, 20)

      for (const path of changed) {
        await update($, ledger, was => recordEdit(was, { id: e.tool_use_id, path }))
      }
    }

    return ran
  }).catch(($, e, next) => {
    if (next.called) return next(e)

    const hit = bashFrozenHit(frozen, e.command)

    return hit === null ? next(e) : { deny: denyText(hit) }
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const path = relative(root, e.file_path)

    if (isFrozen(frozen, path)) {
      const change =
        e.tool === 'Edit'
          ? ` ("${clip(e.old_string.trim(), 40)}" to "${clip(e.new_string.trim(), 40)}")`
          : ''

      if (!(await isAllowed($, `edit ${path}${change}`))) return { deny: denyText(path) }
    }

    const ran = await next(e)

    if (ran.deny !== undefined || ran.isError === true) return ran

    await update($, ledger, was => recordEdit(was, { id: e.tool_use_id, path }))

    if (path === CONFIG) await load($)

    return ran
  }).catch(($, e, next) => {
    if (next.called) return next(e)

    const path = relative(root, e.file_path)

    return isFrozen(frozen, path) ? { deny: denyText(path) } : next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, ledger, was => ({ ...was, turn: was.turn + 1 }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined || e.reason !== 'answer') return done

    const found = claimsOf(await read($, ledger), e.answer)

    if (found.length === 0) return done

    await update($, ledger, was => addClaims(was, found))

    const line = turnLine(found)

    return { ...done, text: done.text === e.answer ? line : `${done.text}\n${line}` }
  })

  // ------------------------------------------------------------- drawing

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const now = await read($, ledger)
    const mine = now.runs.filter(run => run.turn === now.turn)

    if (mine.length === 0) return next(e)

    const failing = mine.filter(run => !run.ok).length
    const counts = `${mine.length} ${mine.length === 1 ? 'check' : 'checks'}`
    const suffix = ` · ${counts}${failing > 0 ? ` · ${failing} failing` : ''}…`

    return next({ ...e, props: { ...e.props, suffix } })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const now = await read($, ledger)
    const id = e.props.tool_use_id
    const run = now.runs.find(one => one.id === id)
    const staled = now.edits.filter(one => one.id === id).flatMap(one => one.staled)

    if (run === undefined && staled.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const names = [...new Set(staled)].join(', ')

    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" columnGap={1} paddingLeft={5}>
          <Text inverse> attest </Text>
          {run !== undefined ? (
            <Text color={runTone(run)}>{runLine(run)}</Text>
          ) : (
            <Text color="warning">{names} now STALE: changed after its last pass</Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const summary = summarize(await read($, ledger))

    if (e.props.hasSurvey || summary === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const theirs = await next(e)

    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" columnGap={2}>
          <Text inverse> attest </Text>
          {summary.tone === null ? (
            <Text dimColor>{summary.head}</Text>
          ) : (
            <Text color={summary.tone}>{summary.head}</Text>
          )}
          <Text dimColor wrap="truncate-end">
            {summary.tail}
          </Text>
          <Button key="open" label="ledger" hotkey="l" plain onPress={() => openPane($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, ledger)
    const shown = await read($, tab)
    const width = Math.max(20, e.props.bodyColumns - 12)

    const tabButton = (to: Tab, label: string, hotkey: string) => (
      <Button
        key={`tab-${to}`}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={shown !== to}
        onPress={() => update($, tab, () => to)}
      />
    )

    const gates = (
      <Box flexDirection="column" rowGap={1}>
        {now.configError !== null && (
          <Text color="error">
            {CONFIG}: {now.configError}
          </Text>
        )}
        {!now.hasConfig && (
          <Box flexDirection="column">
            <Text>No gates declared.</Text>
            <Text dimColor>/attest init writes a starter {CONFIG}.</Text>
            <Text dimColor>Test commands Claude runs are tracked on the Runs tab either way.</Text>
          </Box>
        )}
        {now.gates.map(gate => {
          const { label, tone } = gateLabel(gate)
          const note = gateNote(gate)

          return (
            <Box flexDirection="row" columnGap={2}>
              <Box width={8} flexShrink={0}>
                {tone === null ? <Text dimColor>{label}</Text> : <Text color={tone}>{label}</Text>}
              </Box>
              <Box flexDirection="column">
                <Text>{gate.name}</Text>
                <Text dimColor>{clip(gate.command, width)}</Text>
                {note.isWarning ? (
                  <Text color="warning">{clip(note.text, width)}</Text>
                ) : (
                  <Text dimColor>{clip(note.text, width)}</Text>
                )}
              </Box>
            </Box>
          )
        })}
        {now.gates.length > 0 && (
          <Box flexDirection="row" columnGap={2}>
            <Button
              key="run-stale"
              label="r: run what is not green"
              hotkey="r"
              onPress={() => runGates($, 'stale')}
            />
            <Button key="run-all" label="a: run all" hotkey="a" onPress={() => runGates($, 'all')} />
          </Box>
        )}
        {now.hasConfig && (
          <Text dimColor>
            {CONFIG} is frozen to Claude{now.frozen.length > 1 ? `, with ${now.frozen.length - 1} more` : ''}
          </Text>
        )}
      </Box>
    )

    const claims = (
      <Box flexDirection="column" rowGap={1}>
        {now.claims.length === 0 && (
          <Box flexDirection="column">
            <Text>No claims yet.</Text>
            <Text dimColor>A claim is a sentence in an answer that says something passed.</Text>
          </Box>
        )}
        {now.claims
          .slice(-8)
          .reverse()
          .map(claim => (
            <Box flexDirection="row" columnGap={2}>
              <Box width={8} flexShrink={0}>
                <Text color={verdictTone(claim.verdict)}>{claim.verdict.toUpperCase()}</Text>
              </Box>
              <Box flexDirection="column">
                <Text>"{clip(claim.text, width * 2)}"</Text>
                <Text dimColor>{clip(claim.why, width * 2)}</Text>
              </Box>
            </Box>
          ))}
      </Box>
    )

    const rows = [
      ...now.runs.map(run => ({ order: run.order, run, edit: undefined })),
      ...now.edits.map(edit => ({ order: edit.order, run: undefined, edit })),
    ]
      .sort((a, b) => b.order - a.order)
      .slice(0, 12)

    const runs = (
      <Box flexDirection="column" rowGap={1}>
        {rows.length === 0 && <Text dimColor>Nothing watched yet.</Text>}
        {rows.map(row =>
          row.run !== undefined ? (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={2}>
                <Text>#{row.run.n}</Text>
                <Text color={runTone(row.run)}>
                  {row.run.masked !== null ? 'HIDDEN' : row.run.ok ? 'PASS' : 'FAIL'}
                </Text>
                <Text dimColor>
                  {seconds(row.run.ms)}
                  {row.run.exit !== null ? ` · exit ${row.run.exit}` : ''}
                  {row.run.gate !== null ? ` · ${row.run.gate}` : ''}
                </Text>
              </Box>
              <Text dimColor>{clip(row.run.command, width + 8)}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={2}>
                <Text dimColor>edit</Text>
                <Text>{clip(row.edit.path, width)}</Text>
              </Box>
              {row.edit.staled.length > 0 && (
                <Text color="warning">stales {row.edit.staled.join(', ')}</Text>
              )}
            </Box>
          ),
        )}
        <Text dimColor>Seen by the host, not reported by the model.</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={3}>
          {tabButton('gates', 'Gates', '1')}
          {tabButton('claims', 'Claims', '2')}
          {tabButton('runs', 'Runs', '3')}
        </Box>
        {shown === 'gates' ? gates : shown === 'claims' ? claims : runs}
      </Box>
    )
  })
}
