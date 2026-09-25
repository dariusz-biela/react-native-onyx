# Sourced by the suite's entry scripts: re-runs the calling script through the machine-wide queue
# (agent-queue/queue.sh) unless it already holds the slot, so a benchmark never overlaps another
# session's lint, typecheck or test run. `hold_queue_slot "$0" "$@"` must be the first command.
hold_queue_slot() {
    if [[ "${AGENT_QUEUE_HELD:-}" == 1 ]]; then
        return 0
    fi

    local queue_script
    queue_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/agent-queue/queue.sh"
    exec "$queue_script" run --label "perf-suite $(basename "$1")" -- "$@"
}
