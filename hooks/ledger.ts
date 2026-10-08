// The ledger's rules, with no engine in them: every function here is pure, so
// the tests and the hooks read the same judgement.

import type {
  Claim,
  EditRow,
  GateState,
  Ledger,
  Run,
  Verdict,
} from '../types'

export const CONFIG = '.attest.json'

export const EMPTY: Ledger = {
  order: 0,
  runCount: 0,
  turn: 0,
  hasConfig: false,
  configError: null,
  frozen: [],
  gates: [],
  runs: [],
  edits: [],
  claims: [],
}

const KEEP = 200

// ---------------------------------------------------------------- config

export type GateSpec = {
  name: string
  command: string
  watch: string[]
  timeoutSec: number
}

export type Config = { gates: GateSpec[]; frozen: string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(one => typeof one === 'string')

/** Reads `.attest.json`; answers the config, or one line saying what is wrong. */
export function parseConfig(text: string): Config | string {
  let data: unknown

  try {
    data = JSON.parse(text)
  } catch {
    return 'not valid JSON'
  }

  if (!isRecord(data)) return 'expected an object with "gates"'

  const rawGates = data.gates ?? []
  const rawFrozen = data.frozen ?? []

  if (!Array.isArray(rawGates)) return '"gates" must be a list'
  if (!isStrings(rawFrozen)) return '"frozen" must be a list of paths'

  const gates: GateSpec[] = []

  for (const raw of rawGates) {
    if (!isRecord(raw)) return 'each gate must be an object'

    const { name, command, watch, timeoutSec } = raw

    if (typeof name !== 'string' || !/^[\w.-]{1,64}$/.test(name)) {
      return 'a gate name must be 1-64 letters, digits, "_", "." or "-"'
    }
    if (typeof command !== 'string' || command.trim() === '') {
      return `gate ${name} needs a "command"`
    }
    if (watch !== undefined && !isStrings(watch)) {
      return `gate ${name}: "watch" must be a list of paths`
    }
    if (
      timeoutSec !== undefined &&
      (typeof timeoutSec !== 'number' || timeoutSec < 1 || timeoutSec > 600)
    ) {
      return `gate ${name}: "timeoutSec" must be between 1 and 600`
    }
    if (gates.some(one => one.name === name)) return `gate ${name} is declared twice`

    gates.push({
      name,
      command: squash(command),
      watch: watch ?? [],
      timeoutSec: timeoutSec ?? 120,
    })
  }

  return { gates, frozen: rawFrozen.map(one => one.replace(/^\.\//, '')) }
}

/**
 * Lays a config over the ledger: a gate that is still declared with the same
 * command keeps what was seen of it, the rest start as not run.
 */
export function applyConfig(
  ledger: Ledger,
  config: Config | null,
  seenRed: Readonly<Record<string, boolean>>,
): Ledger {
  if (config === null) {
    return { ...ledger, hasConfig: false, configError: null, frozen: [], gates: [] }
  }

  const gates = config.gates.map((spec): GateState => {
    const was = ledger.gates.find(
      one => one.name === spec.name && one.command === spec.command,
    )

    return {
      name: spec.name,
      command: spec.command,
      watch: spec.watch,
      timeoutSec: spec.timeoutSec,
      status: was?.status ?? 'not-run',
      run: was?.run ?? null,
      seenRed: (was?.seenRed ?? false) || seenRed[spec.name] === true,
      staleBy: was?.staleBy ?? null,
      isRunning: false,
    }
  })

  return {
    ...ledger,
    hasConfig: true,
    configError: null,
    frozen: [CONFIG, ...config.frozen.filter(one => one !== CONFIG)],
    gates,
  }
}

// --------------------------------------------------------------- commands

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

const TESTLIKE = new RegExp(
  [
    String.raw`\bpytest\b`,
    String.raw`\bpy\.test\b`,
    String.raw`\bpython3?\s+-m\s+(pytest|unittest)\b`,
    String.raw`\b(tox|nox)\b`,
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check)\b`,
    String.raw`\bnpx\s+(jest|vitest|tsc|eslint|playwright)\b`,
    String.raw`\b(jest|vitest|mocha)\b`,
    String.raw`\bcargo\s+(test|check|clippy)\b`,
    String.raw`\bgo\s+(test|vet)\b`,
    String.raw`\bmake\s+(test|check|lint|gates?|verify)\b`,
    String.raw`(\bmvn|\bgradle|\./gradlew)\s+(test|verify|check)\b`,
    String.raw`\btsc\b`,
    String.raw`\b(ruff|mypy|eslint|flake8)\b`,
    String.raw`\b(rspec|phpunit|ctest)\b`,
    String.raw`\b(dotnet|swift)\s+test\b`,
    String.raw`\bclaude\s+plugin\s+(test|validate)\b`,
  ].join('|'),
)

const NOT_A_RUN =
  /^\s*(cat|grep|rg|ls|echo|which|head|tail|sed|awk|find|cd|export|git)\b|\b(install|uninstall|add|remove)\b/

/** True when some part of the command runs tests, a linter or a type check. */
export function isTestLike(command: string): boolean {
  return command
    .split(/&&|\|\||[;|\n]/)
    .some(part => TESTLIKE.test(part) && !NOT_A_RUN.test(part))
}

/** The declared gate this command runs: the longest whose command it holds. */
export function matchGate(
  gates: readonly GateState[],
  command: string,
): GateState | null {
  const flat = squash(command)
  let best: GateState | null = null

  for (const gate of gates) {
    if (flat.includes(gate.command) && gate.command.length > (best?.command.length ?? 0)) {
      best = gate
    }
  }

  return best
}

/** What makes this command a check: its gate, or null for a test-like one. */
export function checkOf(
  ledger: Ledger,
  command: string,
): { gate: string | null } | null {
  const gate = matchGate(ledger.gates, command)

  if (gate !== null) return { gate: gate.name }

  return isTestLike(command) ? { gate: null } : null
}

/**
 * What in the command hides its exit code from whoever reads it, or null:
 * `|| true` and its kin, `set +e`, or a pipe with no `pipefail`.
 */
export function maskOf(command: string): string | null {
  const swallowed = /\|\|\s*(true|:|exit\s+0|echo\b[^;&|]*)\s*(?=$|[;)&\n])/.exec(command)

  if (swallowed !== null) return squash(swallowed[0])
  if (/;\s*(true|exit\s+0)\s*$/.test(command)) return 'a trailing "true"'
  if (/\bset\s+\+e\b/.test(command)) return 'set +e'
  if (/(^|[^|])\|(?!\|)/.test(command) && !/pipefail/.test(command)) {
    return 'a pipe without pipefail'
  }

  return null
}

/** The exit code a failed Bash call reported in the text the model read. */
export function exitOf(text: string | undefined): number | null {
  const found = /Exit code:? (\d+)/i.exec(text ?? '')

  return found?.[1] === undefined ? null : Number(found[1])
}

// ------------------------------------------------------------------ paths

export function relative(root: string, path: string): string {
  const base = root.endsWith('/') ? root : `${root}/`

  return root !== '' && path.startsWith(base) ? path.slice(base.length) : path
}

const JUNK =
  /(^|\/)(\.git|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|target|dist|build|coverage)\//

/** A path no gate should go stale over: caches, builds, the repository's own. */
export const isJunk = (path: string): boolean => JUNK.test(path) || path.endsWith('.pyc')

export function isFrozen(frozen: readonly string[], path: string): boolean {
  return frozen.some(one => path === one || path.endsWith(`/${one}`))
}

const WRITES =
  /\bsed\s+[^|;&]*-i|\btee\b|\bmv\b|\brm\b|\bcp\b|\btruncate\b|\bpatch\b|\bgit\s+(checkout|restore|apply)\b|\b(python3?|node|perl|ruby)\s+-\w*[ce]\b/

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The frozen file a shell command looks set to write, or null. */
export function bashFrozenHit(frozen: readonly string[], command: string): string | null {
  for (const one of frozen) {
    const base = one.split('/').pop() ?? one

    if (!command.includes(base)) continue

    const redirect = new RegExp(String.raw`>{1,2}\s*["']?[^\s"'|;&]*${escapeRegExp(base)}`)

    if (redirect.test(command) || WRITES.test(command)) return one
  }

  return null
}

function touches(gate: GateState, path: string): boolean {
  if (gate.watch.length === 0) return true

  return gate.watch.some(pattern => {
    if (pattern.startsWith('*.')) return path.endsWith(pattern.slice(1))

    const folder = pattern.endsWith('/') ? pattern : `${pattern}/`

    return path === pattern || path.startsWith(folder)
  })
}

// -------------------------------------------------------------- recording

export type RunInput = {
  id: string
  command: string
  ok: boolean
  exit: number | null
  ms: number
  masked: string | null
  gate: string | null
}

/** Adds one watched check; a masked one changes no gate. */
export function recordRun(ledger: Ledger, input: RunInput): Ledger {
  const run: Run = {
    n: ledger.runCount + 1,
    order: ledger.order + 1,
    id: input.id,
    turn: ledger.turn,
    ms: Math.max(0, Math.round(input.ms)),
    command: squash(input.command).slice(0, 400),
    ok: input.ok,
    exit: input.exit,
    masked: input.masked,
    gate: input.gate,
  }

  const gates = ledger.gates.map((gate): GateState => {
    if (gate.name !== input.gate) return gate
    if (input.masked !== null) return { ...gate, isRunning: false }

    return {
      ...gate,
      status: input.ok ? 'pass' : 'fail',
      run: run.n,
      seenRed: gate.seenRed || !input.ok,
      staleBy: null,
      isRunning: false,
    }
  })

  return {
    ...ledger,
    order: run.order,
    runCount: run.n,
    gates,
    runs: [...ledger.runs, run].slice(-KEEP),
  }
}

/** Adds one watched file change; every passing gate it touches goes stale. */
export function recordEdit(
  ledger: Ledger,
  input: { id: string; path: string },
): Ledger {
  const staled: string[] = []

  const gates = ledger.gates.map((gate): GateState => {
    if (gate.status !== 'pass' || !touches(gate, input.path)) return gate

    staled.push(gate.name)

    return { ...gate, status: 'stale', staleBy: input.path }
  })

  const edit: EditRow = {
    order: ledger.order + 1,
    id: input.id,
    turn: ledger.turn,
    path: input.path,
    staled,
  }

  return {
    ...ledger,
    order: edit.order,
    gates,
    edits: [...ledger.edits, edit].slice(-KEEP),
  }
}

export function setRunning(ledger: Ledger, name: string, isRunning: boolean): Ledger {
  return {
    ...ledger,
    gates: ledger.gates.map(gate => (gate.name === name ? { ...gate, isRunning } : gate)),
  }
}

// ----------------------------------------------------------------- claims

const HEDGE =
  /\b(not|never|no longer|cannot|can't|couldn't|didn't|doesn't|don't|haven't|hasn't|isn't|aren't|wasn't|won't|fail(s|ed|ing|ure|ures)?|broken|should|would|could|might|may|will|once|if|unless|until|need(s|ed)? to|want(s|ed)? to|try|trying|to make|to get|expect(s|ed)?|todo|next steps?|please)\b|\?\s*$/i

const SUCCESS = /\b(pass(es|ed|ing)?|green|clears?|cleared|succeed(s|ed)?|meets?|met)\b/i

const CLAIM = new RegExp(
  [
    String.raw`\b(tests?|specs?|suite|checks?|gates?|build|lint|linter|type ?checks?|ci)\b[^.!?\n]{0,50}\b(pass(es|ed|ing)?|green|succeed(s|ed)?|clean)\b`,
    String.raw`\b(passing|green)\s+(tests?|build|suite|ci|checks?)\b`,
    String.raw`\beverything\s+(passes|is green|works)\b`,
    String.raw`\b(verified|confirmed)\b`,
    String.raw`\bclears?\s+the\s+(floor|bar|threshold)\b`,
    String.raw`\b(passes|passing|green)\s+(now|again)\b`,
  ].join('|'),
  'i',
)

function sentencesOf(answer: string): string[] {
  return answer
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n+|(?<=[.!?])\s+/)
    .map(one => one.replace(/^[\s>#*\-•\d.)]+/, '').replace(/[*_`]/g, '').trim())
    .filter(one => one.length >= 8)
    .slice(0, 60)
}

function mentions(sentence: string, name: string): boolean {
  const text = sentence.toLowerCase()
  const lower = name.toLowerCase()
  const words = lower.split(/[_.-]+/).filter(word => word.length >= 3)

  return text.includes(lower) || (words.length > 0 && words.every(word => text.includes(word)))
}

function lastEditAfter(ledger: Ledger, order: number): EditRow | undefined {
  return ledger.edits.findLast(edit => edit.order > order && !isJunk(edit.path))
}

type Judgement = { verdict: Verdict; why: string }

function judgeGate(gate: GateState): Judgement {
  switch (gate.status) {
    case 'pass':
      return { verdict: 'backed', why: `run #${gate.run} passed, nothing it watches changed since` }
    case 'stale':
      return { verdict: 'stale', why: `${gate.staleBy} changed after run #${gate.run} passed` }
    case 'fail':
      return { verdict: 'unbacked', why: `run #${gate.run} failed` }
    case 'not-run':
      return { verdict: 'unbacked', why: `${gate.name} has not run this session` }
  }
}

function judgeGeneric(ledger: Ledger): Judgement {
  const last = ledger.runs.at(-1)

  if (last === undefined) {
    return { verdict: 'unbacked', why: 'no test or gate command has run this session' }
  }
  if (last.masked !== null) {
    return { verdict: 'unbacked', why: `run #${last.n} hid its exit code (${last.masked})` }
  }
  if (!last.ok) return { verdict: 'unbacked', why: `run #${last.n} failed` }

  const failing = ledger.gates.find(gate => gate.status === 'fail')

  if (failing !== undefined) {
    return { verdict: 'unbacked', why: `gate ${failing.name} is failing` }
  }

  const edit = lastEditAfter(ledger, last.order)

  if (edit !== undefined) {
    return { verdict: 'stale', why: `${edit.path} changed after run #${last.n} passed` }
  }

  return { verdict: 'backed', why: `run #${last.n} passed, nothing changed since` }
}

/**
 * The success claims in an answer, each judged against what the host saw.
 *
 * Deliberately narrow: a hedged, negated, conditional or future sentence is
 * no claim, so a miss is likelier than a false flag.
 */
export function claimsOf(ledger: Ledger, answer: string): Claim[] {
  const claims: Claim[] = []

  for (const sentence of sentencesOf(answer)) {
    if (HEDGE.test(sentence)) continue

    const gate = ledger.gates.find(one => mentions(sentence, one.name))
    let judged: Judgement | null = null

    if (gate !== undefined && SUCCESS.test(sentence)) judged = judgeGate(gate)
    else if (CLAIM.test(sentence)) judged = judgeGeneric(ledger)

    if (judged === null) continue

    const text = sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence

    if (claims.some(one => one.text === text)) continue

    claims.push({ turn: ledger.turn, text, ...judged })

    if (claims.length === 8) break
  }

  return claims
}

export function addClaims(ledger: Ledger, claims: readonly Claim[]): Ledger {
  return { ...ledger, claims: [...ledger.claims, ...claims].slice(-100) }
}

// ------------------------------------------------------------------ words

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 3))}...` : text

/** The line shown under an answer that made claims. */
export function turnLine(claims: readonly Claim[]): string {
  const count = (verdict: Verdict): number =>
    claims.filter(claim => claim.verdict === verdict).length
  const stale = count('stale')
  const unbacked = count('unbacked')

  if (stale + unbacked === 0) return `attest: ${plural(claims.length, 'claim')} · all backed`

  return [
    `attest: ${plural(claims.length, 'claim')}`,
    `${count('backed')} backed`,
    ...(stale > 0 ? [`${stale} stale`] : []),
    ...(unbacked > 0 ? [`${unbacked} unbacked`] : []),
  ].join(' · ')
}

/** How a watched run reads: its outcome first, then what it moved. */
export function runLine(run: Run): string {
  const outcome = run.ok ? 'ok' : run.exit !== null ? `exit ${run.exit}` : 'failed'
  const parts = [outcome, seconds(run.ms)]

  if (run.masked !== null) {
    parts.push(`exit code hidden by ${run.masked}`)
    parts.push(run.gate !== null ? `gate ${run.gate} NOT COUNTED` : 'NOT COUNTED')
  } else if (run.gate !== null) {
    parts.push(`gate ${run.gate} ${run.ok ? 'PASS' : 'FAIL'}`)
  }

  parts.push(`run #${run.n}`)

  return parts.join(' · ')
}

export type Tone = 'success' | 'warning' | 'error'

export const runTone = (run: Run): Tone =>
  run.masked !== null ? 'warning' : run.ok ? 'success' : 'error'

export const verdictTone = (verdict: Verdict): Tone =>
  verdict === 'backed' ? 'success' : verdict === 'stale' ? 'warning' : 'error'

export function gateLabel(gate: GateState): { label: string; tone: Tone | null } {
  if (gate.isRunning) return { label: 'RUNNING', tone: null }

  switch (gate.status) {
    case 'pass':
      return { label: 'PASS', tone: 'success' }
    case 'fail':
      return { label: 'FAIL', tone: 'error' }
    case 'stale':
      return { label: 'STALE', tone: 'warning' }
    case 'not-run':
      return { label: 'NOT RUN', tone: null }
  }
}

/** The second line under a gate: why its status is what it is. */
export function gateNote(gate: GateState): { text: string; isWarning: boolean } {
  switch (gate.status) {
    case 'pass':
      return gate.seenRed
        ? { text: `run #${gate.run} · has been seen failing`, isWarning: false }
        : { text: `run #${gate.run} · never seen red, unproven`, isWarning: true }
    case 'stale':
      return { text: `${gate.staleBy} changed after run #${gate.run}`, isWarning: true }
    case 'fail':
      return { text: `run #${gate.run} failed`, isWarning: false }
    case 'not-run':
      return { text: 'not run this session', isWarning: false }
  }
}

export type Summary = { tone: Tone | null; head: string; tail: string }

/** The band's one line: the worst thing first; null while there is nothing to say. */
export function summarize(ledger: Ledger): Summary | null {
  if (ledger.configError !== null) {
    return { tone: 'error', head: `✗ ${CONFIG} is not usable`, tail: ledger.configError }
  }
  if (!ledger.hasConfig && ledger.runs.length === 0 && ledger.claims.length === 0) return null

  const passing = ledger.gates.filter(gate => gate.status === 'pass')
  const unproven = passing.filter(gate => !gate.seenRed).length
  const tail = ledger.hasConfig
    ? `gates ${passing.length}/${ledger.gates.length} green${unproven > 0 ? ` · ${unproven} unproven` : ''}`
    : `${plural(ledger.runs.length, 'check')} seen`

  const failing = ledger.gates.filter(gate => gate.status === 'fail')
  const [firstFailing] = failing

  if (firstFailing !== undefined) {
    const more = failing.length > 1 ? ` +${failing.length - 1} more` : ''

    return { tone: 'error', head: `✗ ${firstFailing.name} FAIL${more}`, tail }
  }

  const last = ledger.runs.at(-1)

  if (last !== undefined && !last.ok && last.masked === null) {
    return { tone: 'error', head: `✗ run #${last.n} failed`, tail }
  }

  const now = ledger.claims.filter(claim => claim.turn === ledger.turn)
  const unbacked = now.filter(claim => claim.verdict === 'unbacked').length
  const stale = now.filter(claim => claim.verdict === 'stale').length
  const staleGates = ledger.gates.filter(gate => gate.status === 'stale').length
  const parts = [
    ...(unbacked > 0 ? [`${unbacked} unbacked`] : []),
    ...(stale > 0 ? [`${stale} stale`] : []),
    ...(unbacked + stale === 0 && staleGates > 0 ? [`${plural(staleGates, 'gate')} stale`] : []),
  ]

  if (parts.length > 0) return { tone: 'warning', head: `▲ ${parts.join(' · ')}`, tail }
  if (now.length > 0) return { tone: 'success', head: '✓ all claims backed', tail }
  if (last?.ok === true && last.masked === null) {
    return { tone: 'success', head: `✓ run #${last.n} passed`, tail }
  }

  return { tone: null, head: 'nothing checked yet', tail }
}
