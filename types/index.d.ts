export type GateStatus = 'not-run' | 'pass' | 'fail' | 'stale'

/** One declared gate and what the host last saw of it. */
export type GateState = {
  name: string
  command: string
  /** Paths whose edits stale this gate; empty means any edit does. */
  watch: string[]
  timeoutSec: number
  status: GateStatus
  /** The run that set the status, or null before any. */
  run: number | null
  /** True once this gate has been seen failing, in this session or an earlier one. */
  seenRed: boolean
  /** The file whose edit staled a pass, or null. */
  staleBy: string | null
  /** True while a rerun the person asked for is in flight. */
  isRunning: boolean
}

/** One check the host watched: a gate command or a test-like command. */
export type Run = {
  n: number
  /** Place in the session's order of runs and edits. */
  order: number
  /** The tool call's id, or `direct-<n>` for a rerun from the pane. */
  id: string
  turn: number
  ms: number
  command: string
  ok: boolean
  exit: number | null
  /** What hid the exit code, or null when nothing did. */
  masked: string | null
  gate: string | null
}

/** One file change the host watched. */
export type EditRow = {
  order: number
  id: string
  turn: number
  path: string
  /** Gates this edit turned from pass to stale. */
  staled: string[]
}

export type Verdict = 'backed' | 'stale' | 'unbacked'

/** One success claim found in an answer, judged against the ledger. */
export type Claim = {
  turn: number
  text: string
  verdict: Verdict
  why: string
}

export type Ledger = {
  /** Count of runs and edits so far. */
  order: number
  /** Count of runs so far. */
  runCount: number
  turn: number
  hasConfig: boolean
  configError: string | null
  frozen: string[]
  gates: GateState[]
  runs: Run[]
  edits: EditRow[]
  claims: Claim[]
}

export type Tab = 'gates' | 'claims' | 'runs'

declare module 'claude-code' {
  interface PluginState {
    'attest-ledger': { ledger: Ledger; tab: Tab }
  }
}
