# agent-queue

One machine-wide slot for heavy commands, so several Claude sessions (and their subagents) working in several Onyx worktrees can write code in parallel but never lint, typecheck, test or benchmark at the same time.

- `queue.sh`: a FIFO queue with one slot. State lives in `~/.agent-queue` (override with `AGENT_QUEUE_DIR`), so every worktree on the machine shares it.
- `guard.js`: a Claude Code `PreToolUse` hook for Bash, registered in `.claude/settings.json`. It denies a heavy command started outside the queue and tells the agent how to run it through the queue. It fires for subagents too.

## Running a command through the queue

```sh
agent-queue/queue.sh run -- npx jest tests/unit/onyxTest.ts
agent-queue/queue.sh run --label "slots A/B" -- npm run typecheck
```

`run` takes a ticket, waits until every earlier ticket has finished, runs the command in its own process group and exits with the command's exit code. While it waits it prints its position and the running command every 30 seconds (`AGENT_QUEUE_REPORT_SECONDS`).

- The label defaults to the worktree folder name, so `status` shows who is running what.
- A `queue.sh run` nested inside another one runs at once, because its parent already holds the slot. This keeps scripts that call the queue themselves from deadlocking.
- Ctrl-C, `TERM` or `HUP` on the wrapper kills the whole command process group and frees the slot.
- If the wrapper dies with `SIGKILL`, the command keeps the slot until its process group exits. Then the next waiting entry takes over and the history records `orphaned`.

## Monitoring

```sh
agent-queue/queue.sh status      # load average, the running command, the waiting list in order
agent-queue/queue.sh watch 2     # the same, refreshed every 2 seconds
agent-queue/queue.sh log -n 50   # finished commands with duration, exit status, label and cwd
agent-queue/queue.sh cancel 42   # stop ticket 42, waiting or running
agent-queue/queue.sh clean       # drop entries whose processes are gone
```

## What the guard blocks

The guard checks the first word of every command segment (split on `;`, `&&`, `||`, `|`, `&`, subshells and newlines). Before it checks, it skips environment assignments and wrappers such as `npx`, `caffeinate`, `time`, `nohup`, `env` and `bash -c`. It blocks:

- `jest`, `eslint`, `tsc`, `tsgo`, `reassure`, `oxlint`, from `npx`, `node_modules/.bin` or `npm exec`;
- `npm test` and `npm run test*|lint*|typecheck*|build*|perf*`, and the same scripts under `yarn`, `pnpm` and `bun`;
- `perf-suite/scripts/*.sh`.

A command that contains `queue.sh run` is always allowed. Reading files with these names (`cat jest.config.js`, `grep jest`) is never blocked. `npx prettier` on a few files is cheap and stays allowed.

Hooks load when a session starts. A session that was already running when `.claude/settings.json` changed picks the hook up only after `/hooks` review or a restart.

## Instructions for agents

- Write code in parallel freely. Put every lint, typecheck, test, build or benchmark behind `agent-queue/queue.sh run -- <command>`.
- The Bash tool times out after 10 minutes, and that includes the time spent waiting in the queue. For anything that may wait or run longer, start the queued command with `run_in_background` and read its output when it finishes.
- Keep a queued command narrow: the changed test files, `eslint` on the changed files. The whole queue waits for it.
- Never cancel another session's ticket.
