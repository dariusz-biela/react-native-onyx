# react-native-onyx (research fork)

## Heavy commands go through the queue

Several sessions work in several worktrees of this repo at once. Writing code in parallel is fine, but lint, typecheck, tests, builds and benchmarks share one machine-wide slot:

```sh
agent-queue/queue.sh run -- <command>
```

A `PreToolUse` hook (`agent-queue/guard.js`) denies these commands when they run outside the queue. The wait counts against the 10-minute Bash timeout, so start long or possibly waiting commands with `run_in_background`. Check the queue with `agent-queue/queue.sh status`. Details are in `agent-queue/README.md`.
