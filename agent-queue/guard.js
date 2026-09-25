#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash. It denies a heavy command (lint, typecheck, tests, builds, benchmarks)
 * that does not go through `agent-queue/queue.sh run`, so agents in several worktrees never run two of them
 * at once. Everything else, code edits included, passes untouched.
 *
 * The check looks at the first word of every command segment, after environment assignments and wrappers
 * such as `npx` or `caffeinate`, so `grep jest` or `cat tsconfig.json` are never mistaken for a heavy command.
 */
const path = require('path');

const HEAVY_BINARIES = new Set(['jest', 'eslint', 'tsc', 'tsgo', 'reassure', 'oxlint']);
const HEAVY_NPM_SCRIPT = /^(test|lint|typecheck|build|perf)/;
const PERF_SUITE_SCRIPT = /(^|\/)perf-suite\/scripts\/[^/]+\.sh$/;
const WRAPPERS = new Set(['caffeinate', 'time', 'nohup', 'env', 'exec', 'command', 'nice']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);
const QUEUE_SCRIPT = path.join(__dirname, 'queue.sh');
const QUEUE_INVOCATION = /(^|[\s;&|(])(\S*\/)?queue\.sh\s+run(\s|$)/;

function splitSegments(command) {
    return command.split(/&&|\|\||[;|&\n()`]|\$\(/).map((segment) =>
        segment
            .trim()
            .split(/\s+/)
            .map((token) => token.replace(/^["']+|["']+$/g, ''))
            .filter(Boolean),
    );
}

function isAssignment(token) {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function stripPrefixes(tokens) {
    let index = 0;

    while (index < tokens.length) {
        const token = tokens[index];

        if (isAssignment(token) || (index > 0 && token.startsWith('-') && WRAPPERS.has(path.basename(tokens[index - 1])))) {
            index++;
        } else if (SHELLS.has(path.basename(token)) && tokens[index + 1] === '-c') {
            index += 2;
        } else if (WRAPPERS.has(path.basename(token)) || PACKAGE_RUNNERS.has(path.basename(token))) {
            index++;
            while (index < tokens.length && tokens[index].startsWith('-')) {
                index++;
            }
        } else {
            break;
        }
    }

    return tokens.slice(index);
}

function describeHeavyCommand(tokens) {
    const [first, second, third] = tokens;

    if (!first) {
        return undefined;
    }

    const name = path.basename(first);

    if (HEAVY_BINARIES.has(name) || PERF_SUITE_SCRIPT.test(first)) {
        return tokens.slice(0, 2).join(' ');
    }

    if (name === 'node' && second && HEAVY_BINARIES.has(path.basename(second).replace(/\.js$/, ''))) {
        return `${first} ${second}`;
    }

    if (PACKAGE_MANAGERS.has(name)) {
        if (second === 'test' || second === 't') {
            return `${first} ${second}`;
        }
        if ((second === 'run' || second === 'run-script') && third && HEAVY_NPM_SCRIPT.test(third)) {
            return `${first} ${second} ${third}`;
        }
        if (name !== 'npm' && second && HEAVY_NPM_SCRIPT.test(second)) {
            return `${first} ${second}`;
        }
        if (second === 'exec' && third && HEAVY_BINARIES.has(path.basename(third))) {
            return `${first} ${second} ${third}`;
        }
    }

    return undefined;
}

function findHeavyCommand(command) {
    if (QUEUE_INVOCATION.test(command)) {
        return undefined;
    }

    for (const segment of splitSegments(command)) {
        const heavy = describeHeavyCommand(stripPrefixes(segment));

        if (heavy) {
            return heavy;
        }
    }

    return undefined;
}

function deny(reason) {
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: reason,
            },
        }),
    );
}

function main() {
    let input = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        input += chunk;
    });
    process.stdin.on('end', () => {
        let command = '';

        try {
            command = JSON.parse(input).tool_input?.command ?? '';
        } catch {
            return;
        }

        const heavy = findHeavyCommand(command);

        if (!heavy) {
            return;
        }

        deny(
            [
                `"${heavy}" is a heavy command and must go through the machine-wide queue, so agents in other worktrees never run one at the same time.`,
                `Run it as: ${QUEUE_SCRIPT} run -- ${command.trim()}`,
                'The wrapper waits for the slot and passes the exit code through. When the wait plus the run may exceed the Bash timeout, start it with run_in_background and read the output when it finishes.',
                `Check the queue with: ${QUEUE_SCRIPT} status`,
            ].join('\n'),
        );
    });
}

if (require.main === module) {
    main();
}

module.exports = {findHeavyCommand};
