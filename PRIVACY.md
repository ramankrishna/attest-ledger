# Privacy

Last updated: October 8, 2026

Attest is a mod that runs inside Claude Code on your own machine. It has no server and no account.

## What it collects

Nothing. Attest does not collect, transmit or share any data. It makes no network requests, calls no model, and sends no telemetry or analytics. The author receives no information about you or your use of it.

## What it handles on your machine

To do its job, Attest works with the following, all of which stay on your computer:

- **During a session, in memory:** the test and gate commands Claude runs, whether each one failed, how long it took, the paths of files Claude changes, and sentences from Claude's answers that say something passed. This is held by Claude Code for the length of the session and is gone when the session ends.
- **Between sessions, on disk:** one flag per gate you declare, recording that the gate has been seen failing. It is kept in Claude Code's own plugin store on your machine, keyed by your project's path and the gate's name.
- **In your project:** it reads `.attest.json`, and writes that file once if you run `/attest init` and it does not exist yet.

## Removing its data

Uninstalling the plugin stops all of the above. The stored flags live in Claude Code's plugin store under `~/.claude/plugins/store/` and can be deleted there. `.attest.json` is a file in your project and is yours to keep or delete.

## What Attest does not cover

Attest runs inside Claude Code. How Claude Code and Anthropic handle your prompts, code and usage is governed by Anthropic's own policies, not this one.

## Changes

Any change to this policy will be made in this file, and the history is visible in the repository.

## Contact

Questions or concerns: open an issue at https://github.com/ramankrishna/attest-ledger/issues
