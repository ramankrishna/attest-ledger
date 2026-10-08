# Attest

A mod for Claude Code that shows what actually ran next to what Claude said ran.

When Claude writes "all tests pass", Attest checks that against what it watched happen in the session: which test commands ran, whether they failed, and whether any file changed after the last pass. It then says, under the answer, whether the claim is backed.

It asks no model anything. Every verdict comes from rules you can read in `hooks/ledger.ts`.

## What you see

- **Under a test run**: one line with the outcome, the time it took, and the gate it moved.
- **Under an answer**: a count of the success claims in it, and how many are backed, stale or unbacked.
- **Above the prompt**: the worst thing first, then how many gates are green.
- **`/attest`**: a pane with three tabs. Gates, Claims and Runs.
- **A question** before Claude changes a file you froze.

## The three verdicts

| Verdict | Meaning |
| :- | :- |
| backed | A check passed and nothing has changed since. |
| stale | A check passed, then a file changed. The pass no longer counts. |
| unbacked | No check ran, the last one failed, or its exit code was hidden. |

## Install

```
/plugin install attest-ledger --marketplace ramankrishna/attest-ledger
```

Answer `y` to add the marketplace, then pick a scope. Needs Claude Code v2.1.287 or later.

## Use it without any setup

Attest already recognises common test, lint and type-check commands: pytest, npm test, cargo test, go test, make test, tsc, ruff, eslint and others. Run Claude as usual and the lines appear.

## Declare your own gates

Run `/attest init`, or write `.attest.json` at the project root yourself:

```json
{
  "gates": [
    { "name": "unit", "command": "pytest -q" },
    { "name": "cartpole_floor", "command": "python eval.py --env CartPole-v1", "watch": ["ppo/"], "timeoutSec": 300 }
  ],
  "frozen": ["gates.json"]
}
```

- `name` and `command` are required. A Bash command that contains `command` counts as a run of that gate.
- `watch` lists the paths whose edits make a pass stale. Leave it out and any edit does.
- `timeoutSec` applies when you rerun the gate from the pane. Default 120, at most 600.
- `frozen` lists files Claude may not change without asking you. `.attest.json` is always frozen, so Claude cannot quietly lower a bar it is being measured against.

## Things it checks that are easy to miss

- **Hidden exit codes.** `pytest || true`, `set +e`, and `pytest | tail` without `pipefail` all report success whatever the tests did. Such a run is shown and not counted.
- **Gates that have never failed.** A gate that has only ever passed is marked unproven until it has been seen failing once. That history is kept between sessions.
- **Edits after a pass.** Changes made with the Edit and Write tools, and file changes a shell command reports, both make a pass stale.

## What it runs, reads and stores

- **Reads** `.attest.json` at the project root, and checks whether `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pytest.ini` or `Makefile` exist when you run `/attest init`.
- **Writes** `.attest.json` once, only when you run `/attest init` and the file does not exist.
- **Runs** a gate's `command` through `sh -c` in the project root, only when you press a run button in the pane. The commands are the ones in your own `.attest.json`.
- **Stores** one flag per gate, on your machine, saying it has been seen failing.
- **Sends nothing.** No network calls, no model calls, no telemetry.

Like every mod, it runs with the same access to your machine as Claude Code itself.

## Limits

- Claim detection is a set of patterns over the answer's text. It is deliberately narrow: hedged, negated and future sentences are skipped, so it misses more than it flags.
- Claude Code reports that a shell command failed, not always its exit code. Attest shows the code when the result names it and "failed" otherwise.
- The guard on frozen files covers the Edit and Write tools and obvious shell writes such as redirects, `sed -i`, `mv` and `rm`. A determined script can still get past it.
- A command that runs in the background is shown and not counted, since its result is not known when the call returns.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
