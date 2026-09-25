#!/bin/bash
# A machine-wide FIFO queue with one slot for heavy commands (lint, typecheck, tests, benchmarks).
#
# Several agents in several worktrees may edit code at the same time, but only one of them may run a
# heavy command at any moment. Every heavy command goes through `queue.sh run`, which waits for its turn,
# runs the command and passes its exit code through.
#
# Usage:
#   queue.sh run [--label TEXT] -- <command...>   wait for the slot, run the command, release the slot
#   queue.sh status                               the running command and everyone waiting, in order
#   queue.sh watch [SECONDS]                      status, refreshed every SECONDS (default 2)
#   queue.sh log [-n N]                           the last N finished commands (default 20)
#   queue.sh cancel <ticket>                      stop a waiting or running entry by its ticket
#   queue.sh clean                                drop entries whose processes are gone
#
# State lives in $AGENT_QUEUE_DIR (default ~/.agent-queue), shared by every worktree on the machine.
# A command started inside `queue.sh run` inherits AGENT_QUEUE_HELD=1, so a nested `queue.sh run` runs
# its command at once instead of waiting for the slot its parent holds.
#
# Written for the macOS system bash (3.2), so no associative arrays and no mapfile.
set -euo pipefail

QUEUE_DIR="${AGENT_QUEUE_DIR:-$HOME/.agent-queue}"
WAITING_DIR="$QUEUE_DIR/waiting"
RUNNING_FILE="$QUEUE_DIR/running"
MUTEX_DIR="$QUEUE_DIR/mutex"
COUNTER_FILE="$QUEUE_DIR/counter"
HISTORY_FILE="$QUEUE_DIR/history.tsv"
POLL_SECONDS="${AGENT_QUEUE_POLL_SECONDS:-1}"
REPORT_EVERY_SECONDS="${AGENT_QUEUE_REPORT_SECONDS:-30}"

mkdir -p "$WAITING_DIR"

log() {
    echo "queue: $*" >&2
}

now() {
    date +%s
}

format_duration() {
    local seconds="$1"

    if ((seconds >= 3600)); then
        printf '%dh%02dm' $((seconds / 3600)) $((seconds % 3600 / 60))
    elif ((seconds >= 60)); then
        printf '%dm%02ds' $((seconds / 60)) $((seconds % 60))
    else
        printf '%ds' "$seconds"
    fi
}

# The start time of a process, so a recycled pid is never mistaken for the original process.
process_start() {
    ps -o lstart= -p "$1" 2>/dev/null || true
}

is_process_alive() {
    local pid="$1"
    local start="$2"

    [[ -n "$pid" && "$(process_start "$pid")" == "$start" ]]
}

is_group_alive() {
    local group="$1"

    [[ -n "$group" ]] && kill -0 -- "-$group" 2>/dev/null
}

# Entries are small key=value files, written to a temporary name and renamed, so a reader never sees half of one.
read_field() {
    local file="$1"
    local field="$2"

    awk -v prefix="$field=" 'index($0, prefix) == 1 {print substr($0, length(prefix) + 1); exit}' "$file" 2>/dev/null || true
}

write_entry() {
    local file="$1"
    shift

    printf '%s\n' "$@" > "$file.tmp.$$"
    mv "$file.tmp.$$" "$file"
}

acquire_mutex() {
    local holder

    until mkdir "$MUTEX_DIR" 2>/dev/null; do
        holder="$(cat "$MUTEX_DIR/owner" 2>/dev/null || true)"

        # A holder killed inside the critical section would block the queue forever. One killed between the
        # mkdir and writing its owner file leaves no owner at all, so an ownerless mutex expires after 5 s.
        if [[ -n "$holder" ]] && ! is_process_alive "${holder%%|*}" "${holder#*|}"; then
            rm -rf "$MUTEX_DIR"
            continue
        fi
        if [[ -z "$holder" ]] && (($(now) - $(stat -f %m "$MUTEX_DIR" 2>/dev/null || now) > 5)); then
            rm -rf "$MUTEX_DIR"
            continue
        fi

        sleep 0.05
    done

    echo "$$|$(process_start $$)" > "$MUTEX_DIR/owner"
}

release_mutex() {
    rm -rf "$MUTEX_DIR"
}

append_history() {
    local ticket="$1"
    local label="$2"
    local cwd="$3"
    local command="$4"
    local started="$5"
    local finished="$6"
    local status="$7"

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ticket" "$started" "$finished" "$status" "$label" "$cwd" "$command" >> "$HISTORY_FILE"
}

# Called with the mutex held. The running entry stays while the command's process group has any process
# left, even when the queue.sh that started it was killed, because orphaned jest workers still load the machine.
clean_stale_entries() {
    local file

    for file in "$WAITING_DIR"/*; do
        [[ -f "$file" ]] || continue

        if ! is_process_alive "$(read_field "$file" pid)" "$(read_field "$file" pid_start)"; then
            rm -f "$file"
        fi
    done

    if [[ -f "$RUNNING_FILE" ]]; then
        local owner_alive=false

        if is_process_alive "$(read_field "$RUNNING_FILE" pid)" "$(read_field "$RUNNING_FILE" pid_start)"; then
            owner_alive=true
        fi

        if [[ "$owner_alive" == false ]] && ! is_group_alive "$(read_field "$RUNNING_FILE" group)"; then
            append_history "$(read_field "$RUNNING_FILE" ticket)" "$(read_field "$RUNNING_FILE" label)" \
                "$(read_field "$RUNNING_FILE" cwd)" "$(read_field "$RUNNING_FILE" command)" \
                "$(read_field "$RUNNING_FILE" started)" "$(now)" "orphaned"
            rm -f "$RUNNING_FILE"
        fi
    fi
}

next_ticket() {
    local ticket

    ticket=$(($(cat "$COUNTER_FILE" 2>/dev/null || echo 0) + 1))
    echo "$ticket" > "$COUNTER_FILE"
    echo "$ticket"
}

# Tickets are zero-padded file names, so a plain sorted glob is the queue order. No `| head` on this
# output anywhere: with pipefail, the SIGPIPE a closed reader sends would kill the script.
first_waiting_ticket() {
    local file

    for file in "$WAITING_DIR"/*; do
        if [[ -f "$file" ]]; then
            basename "$file"
            return
        fi
    done
}

waiting_tickets() {
    local file

    for file in "$WAITING_DIR"/*; do
        [[ -f "$file" ]] || continue
        basename "$file"
    done
}

default_label() {
    local root

    root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
    basename "$root"
}

run_command() {
    local label=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --label)
                label="$2"
                shift 2
                ;;
            --)
                shift
                break
                ;;
            *)
                break
                ;;
        esac
    done

    if [[ $# -eq 0 ]]; then
        echo "Usage: queue.sh run [--label TEXT] -- <command...>" >&2
        exit 2
    fi

    if [[ "${AGENT_QUEUE_HELD:-}" == 1 ]]; then
        exec "$@"
    fi

    label="${label:-$(default_label)}"

    # Entries are one field per line and the history is TSV, so tabs and newlines in the command are flattened.
    local command_text
    command_text="$(printf '%s' "$*" | tr '\t\n' '  ')"
    local cwd
    cwd="$(pwd)"
    local own_start
    own_start="$(process_start $$)"

    acquire_mutex
    local ticket
    ticket="$(printf '%08d' "$(next_ticket)")"
    local waiting_file="$WAITING_DIR/$ticket"
    write_entry "$waiting_file" "ticket=$ticket" "pid=$$" "pid_start=$own_start" "label=$label" "cwd=$cwd" \
        "command=$command_text" "enqueued=$(now)"
    release_mutex

    local child=""
    local started=""

    cleanup() {
        local signal="$1"

        if [[ -n "$child" ]]; then
            kill -TERM -- "-$child" 2>/dev/null || true
            wait "$child" 2>/dev/null || true
        fi

        acquire_mutex
        rm -f "$waiting_file"
        if [[ -n "$started" && "$(read_field "$RUNNING_FILE" ticket)" == "$ticket" ]]; then
            append_history "$ticket" "$label" "$cwd" "$command_text" "$started" "$(now)" "$signal"
            rm -f "$RUNNING_FILE"
        fi
        release_mutex

        exit 130
    }
    trap 'cleanup interrupted' INT
    trap 'cleanup terminated' TERM
    trap 'cleanup hangup' HUP

    local enqueued
    enqueued="$(now)"
    local last_report=0
    local is_claimed=false

    while true; do
        acquire_mutex
        clean_stale_entries

        local first
        first="$(first_waiting_ticket)"

        if [[ ! -f "$RUNNING_FILE" && "$first" == "$ticket" ]]; then
            started="$(now)"
            write_entry "$RUNNING_FILE" "ticket=$ticket" "pid=$$" "pid_start=$own_start" "label=$label" \
                "cwd=$cwd" "command=$command_text" "enqueued=$enqueued" "started=$started"
            rm -f "$waiting_file"
            is_claimed=true
        fi

        local position
        position="$(waiting_tickets | grep -n "^$ticket\$" | cut -d: -f1 || true)"
        local holder_label=""
        local holder_started=""
        if [[ -f "$RUNNING_FILE" ]]; then
            holder_label="$(read_field "$RUNNING_FILE" label): $(read_field "$RUNNING_FILE" command)"
            holder_started="$(read_field "$RUNNING_FILE" started)"
        fi
        release_mutex

        if [[ "$is_claimed" == true ]]; then
            break
        fi

        if (($(now) - last_report >= REPORT_EVERY_SECONDS)); then
            last_report="$(now)"
            log "ticket $((10#$ticket)) waiting $(format_duration $((last_report - enqueued))), position ${position:-?}, running: ${holder_label:-nothing} (for $(format_duration $((last_report - ${holder_started:-$last_report}))))"
        fi

        sleep "$POLL_SECONDS"
    done

    log "ticket $((10#$ticket)) running after $(format_duration $((started - enqueued))) in the queue: $command_text"

    # Job control puts the command in a process group of its own, so the whole tree (jest workers included)
    # can be stopped, and a running entry can be checked for leftover processes after queue.sh is gone.
    set -m
    AGENT_QUEUE_HELD=1 "$@" &
    child=$!
    set +m

    acquire_mutex
    write_entry "$RUNNING_FILE" "ticket=$ticket" "pid=$$" "pid_start=$own_start" "group=$child" "label=$label" \
        "cwd=$cwd" "command=$command_text" "enqueued=$enqueued" "started=$started"
    release_mutex

    local status=0
    wait "$child" || status=$?
    child=""

    acquire_mutex
    append_history "$ticket" "$label" "$cwd" "$command_text" "$started" "$(now)" "$status"
    rm -f "$RUNNING_FILE"
    release_mutex

    log "ticket $((10#$ticket)) finished with $status after $(format_duration $(($(now) - started)))"
    exit "$status"
}

print_status() {
    acquire_mutex
    clean_stale_entries
    release_mutex

    local current
    current="$(now)"

    echo "load average: $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs)"

    if [[ -f "$RUNNING_FILE" ]]; then
        local started
        started="$(read_field "$RUNNING_FILE" started)"
        printf 'RUNNING  #%d  %s  for %s\n         %s\n         %s\n' \
            "$((10#$(read_field "$RUNNING_FILE" ticket)))" "$(read_field "$RUNNING_FILE" label)" \
            "$(format_duration $((current - started)))" "$(read_field "$RUNNING_FILE" cwd)" \
            "$(read_field "$RUNNING_FILE" command)"
    else
        echo "RUNNING  nothing"
    fi

    local position=0
    local ticket
    for ticket in $(waiting_tickets); do
        local file="$WAITING_DIR/$ticket"
        position=$((position + 1))
        printf 'WAIT %2d  #%d  %s  for %s\n         %s\n         %s\n' "$position" "$((10#$ticket))" \
            "$(read_field "$file" label)" "$(format_duration $((current - $(read_field "$file" enqueued))))" \
            "$(read_field "$file" cwd)" "$(read_field "$file" command)"
    done

    if ((position == 0)); then
        echo "WAITING  nobody"
    fi
}

print_log() {
    local count=20

    if [[ "${1:-}" == "-n" ]]; then
        count="$2"
    fi

    if [[ ! -f "$HISTORY_FILE" ]]; then
        echo "no finished commands yet"
        return
    fi

    tail -n "$count" "$HISTORY_FILE" | while IFS=$'\t' read -r ticket started finished status label cwd command; do
        printf '#%-5d %s  %7s  exit %-10s %-28s %s\n' "$((10#$ticket))" "$(date -r "$started" '+%m-%d %H:%M:%S')" \
            "$(format_duration $((finished - started)))" "$status" "$label" "$command"
    done
}

cancel_ticket() {
    local ticket
    ticket="$(printf '%08d' "$((10#${1:?Usage: queue.sh cancel <ticket>}))")"
    local file="$WAITING_DIR/$ticket"

    if [[ ! -f "$file" && "$(read_field "$RUNNING_FILE" ticket)" == "$ticket" ]]; then
        file="$RUNNING_FILE"
    fi

    if [[ ! -f "$file" ]]; then
        echo "queue: no waiting or running entry with ticket $((10#$ticket))" >&2
        exit 1
    fi

    # The entry's own queue.sh stops the command's process group and releases the slot in its trap.
    kill -TERM "$(read_field "$file" pid)"
    echo "queue: cancelled ticket $((10#$ticket))"
}

case "${1:-}" in
    run)
        shift
        run_command "$@"
        ;;
    status)
        print_status
        ;;
    watch)
        while true; do
            clear
            print_status
            echo
            print_log -n 10
            sleep "${2:-2}"
        done
        ;;
    log)
        shift
        print_log "$@"
        ;;
    cancel)
        cancel_ticket "${2:-}"
        ;;
    clean)
        acquire_mutex
        clean_stale_entries
        release_mutex
        print_status
        ;;
    *)
        sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
