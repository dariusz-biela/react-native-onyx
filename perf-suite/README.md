# Onyx performance suite

An A/B benchmark for `react-native-onyx`, standalone inside this repo. The baseline is `lib/` as committed at a
ref (default `HEAD`), the candidate is the working tree's `lib/`, so an uncommitted change is measured against
the commit it sits on. Both arms run the same scenarios against a copy of Expensify/App's `ONYXKEYS`, its
derived-value dependencies and a deterministic heavy-account fixture.

The folder depends on nothing outside it except the repo's `lib/` (built per arm) and the root `node_modules`.
The root Jest config, ESLint, Prettier and `tsconfig.json` all leave it out, and it has its own `package.json`,
`jest.config.js`, `babel.config.js` and `tsconfig.json`. It is a port of the suite that ran inside an
Expensify/App checkout; [Differences from the App](#differences-from-the-app) lists what the port had to
replace.

Scenario list with the file each row lives in: `CATALOG.md`.

## Setup

```bash
npm ci                              # the repo root: Jest, TypeScript, Babel, fake-indexeddb
(cd perf-suite && npm ci)           # React 19, react-test-renderer, React Compiler, the fixture generators
```

Every command below runs from the repo root. The suite's scripts take the machine-wide queue slot
(`agent-queue/queue.sh`) themselves, so a benchmark never overlaps another session's lint, typecheck or test
run; see `agent-queue/README.md`.

## Run it

```bash
# noise floor: baseline against itself at all three sizes, nothing should flag
caffeinate -i perf-suite/scripts/ab.sh --aa

# the real thing: HEAD against the working tree at small, large and heavy
caffeinate -i perf-suite/scripts/ab.sh

# one area, one size
perf-suite/scripts/ab.sh --filter hooks/ --scale large

# only the suite files a change touches
perf-suite/scripts/ab.sh --files '(api/personalDetails|flows/personalDetailsBatch)\.perf'
```

`ab.sh` builds both arms (a ref build is cached per commit in `.build/ref-<sha>/`), runs one Jest process per size, one size after the other (never in
parallel: concurrent processes contend for cores and memory and move the numbers), writes
`results/<run-id>/REPORT.md` and `report.json`, repoints `results/latest`, and prints the report path.

Options:

| option | effect |
|---|---|
| `--scales a,b,c` | sizes to measure, default `small,large,heavy` |
| `--scale NAME` | one size only |
| `--rounds N` | blocks the samples are split into (default 4), or rounds in `--classic` mode (default 2) |
| `--filter TEXT` | only scenarios whose id or title contains TEXT |
| `--files REGEX` | only suite files whose path under `suites/` matches REGEX |
| `--aa` | the candidate is a clone of the baseline, so the report is a noise floor |
| `--baseline-ref REF`, `--candidate-ref REF` | `lib/` as committed at REF; the defaults are `HEAD` and the working tree |
| `--baseline-dir DIR`, `--candidate-dir DIR` | any prebuilt dist, a published npm build for one |
| `--classic` | one Jest process per arm and round in ABBA order, the mode before hot-swap |

See [Wall clock](#wall-clock) for how long a run takes.

## Three data sizes

Every scenario is measured at `small`, `large` and `heavy` in a default run. Each scenario's `scale`
function reads what it depends on from the profile (reports, report actions, personal details, K hooks
on one key, module listeners, keys in one update batch, keys in the store) and records it as a param, so
the report shows the size each row was measured at. Every field grows from one size to the next, so a
row sees three different data sizes.

A row whose cost cannot depend on the data (a pure function over a fixed input, `Onyx.init` on an empty
store) declares `sizeIndependent: '<reason>'`. The report's "Size check" section lists every other row
whose params are identical at every size, which would mean the three sizes measured the same thing; it
is empty on a healthy run.

Scenarios that write to plain keys still seed the store with the account first (`storeKeys` in their
params), because the cost of a write depends on the cache and the subscribers around it, not only on the
value.

## Hot-swap mode

Both arms load into one Jest process. Every scenario builds one runner per arm (both stay alive), then
`measureLanes` in `harness/measure.ts` runs them iteration by iteration. The order of the two arms is
shuffled in balanced blocks of four turns (two baseline-first, two candidate-first), seeded by
`<scenario id>@<size>` so a rerun draws the same order. A drift of the machine therefore lands on both
arms alike. Each arm's samples are then split into `--rounds` consecutive blocks (default 4) and every
block is written as a round, so `compare.ts` and its flag rule read the run exactly like a classic one,
and the `paired` column (median of the per-block deltas) is the statistic with the least noise in it.
Between-process spread, the 10-20% two identical Jest processes differ by on sub-millisecond rows, does
not exist here; Jest boots once, and the scenario `setup` runs once per arm instead of once per arm and
round.

Orders that were tried and dropped, all measured in A/A runs on 2026-09-23:

- strict baseline-then-candidate: whichever arm ran first was slower, on every row;
- a fixed flip (AB, BA, AB, ...): the samples split into two modes and single rows showed false deltas
  of 18-36%;
- draining timers between turns: slower and noisier than the shuffle.

How it works (`harness/hotswap/`): `jest.config.js` generates one shim per Onyx file into
`perf-suite/.hotswap/`, and maps `react-native-onyx` to that directory. A shim is a proxy that
forwards every access to the same file in the arm that is active right now (`runtime.js`, plain CJS
and excluded from the transform so every importer shares one instance). Function and object
exports are handed out once and stay late-bound, and so are the methods read off an object export:
Expensify/App's `__mocks__/react-native-onyx.ts` copies the `Onyx` object once with a spread, so a method
bound to the arm active at copy time would have pinned every `Onyx.merge` to the baseline. Primitives
are read live. `jest/setupHotswap.ts` mocks each arm's own `storage/index.js` with that arm's
in-memory provider, so the two stores never see each other's rows. `runScenarios.ts` initialises
both arms in `beforeAll` and switches with `setActiveArm` before every call into a runner.

Three details keep the arms symmetric:

- **The loader arm.** `ab.sh` passes a third copy of the baseline, `<baseline>-loader`, which is active
  while the suite files load. Onyx traffic at import time (module-level `connectWithoutView` calls) lands on it and it is never measured. Without it that traffic went to
  the first measured arm, whose functions then carried different V8 type feedback, and connect rows
  read 15-25% slower on that arm in an A/A.
- **The active arm survives `jest.resetModules`.** It is kept on `globalThis`, not in the runtime
  module. Before 2026-09-23 the two suites that reset modules (`api/init`, `flows/boot`) got a fresh
  runtime with no active arm after the reset, so both of their "arms" measured the baseline and those
  rows always read 0%.
- **The storage mock survives it too.** `jest/setupHotswap.ts` caches each arm's mock, so a fresh module
  graph after a reset reads the rows the scenario seeded. Before, it got an empty store, and
  `api/init/boot-cold` hydrated 7 keys instead of the 120 it seeded.

Both arms stay initialised and hold their own cache for the whole process, so the heap is roughly the
sum of two arms. Suite-level state that is keyed once per process has to be keyed per arm instead:
`suites/storage/idb.perf.ts` initialises the real `IDBKeyValProvider` once per arm (both arms then
share the one `fake-indexeddb` database, which is fine because the scenarios clear it in `setup`).

The two arms must live at two different paths. Jest's module registry is keyed by path, so `--aa`
clones the baseline to `<baseline>-aa` and uses the clone as the candidate; an A/A without the clone
shares one Onyx instance between the "arms".

An arm may lack an internal the suite measures (ONYX-PR#834 removed `OnyxConnectionManager`,
`createMemoizedSelector`, `memoizedShallowEqual`, `OnyxSnapshotCache` and the `OnyxUtils` methods
`tryGetCachedValue`, `keyChanged`, `keysChanged`). Such a file loads the module through
`harness/optionalOnyxModule.ts` and passes `requiresOnyxModules` to `runScenarios`; a single
scenario declares `requires: () => typeof OnyxUtils.keyChanged === 'function'`. Either way the
scenario is registered as skipped, in every arm of the process, and the report has no row for it.

## Entry files

Jest runs three entry files from `entry/`, not the suite files directly:

- `entry/shared.perf.ts` loads every suite file into one module registry, each inside a `describe`
  named after its path, so the app layer and the fixtures are imported and transformed once for all of them;
- `entry/apiInit.perf.ts` and `entry/flowsBoot.perf.ts` load `api/init` and `flows/boot` alone,
  because those two call `jest.resetModules` and would throw away the shared registry.

`harness/loadSuites.ts` holds the list. `--files` is applied there, as a regex over the path under
`suites/`; an entry file with no matching suite registers one skipped test. A new suite file needs no
registration unless it resets modules, in which case it goes into `ISOLATED_SUITES` and gets an entry
file of its own.

Jest runs the entry files in one worker (`--maxWorkers 1`) that is recycled once a file leaves it above
`ONYX_PERF_WORKER_MEMORY` (default `1500MB`, `workerIdleMemoryLimit` in `jest.config.js`; `0` restores
`--runInBand`). In-band, every file's registry stayed reachable and the heap grew to 5-6 GB over a run.

## The measurement loop

Per scenario and arm (`harness/measure.ts`):

1. warm-up: up to 8 iterations or 300 ms, at least one;
2. samples: at least 15, then until 3 s of measured time or 200 samples (a scenario's `measure` block
   can change each);
3. between two iterations, `beforeEach` and `afterEach` (untimed) and a scavenge, but only once the heap
   has grown by 8 MB since the last one (`adaptive`).

There is no full collection after the warm-up any more: it cost wall clock on every scenario and
arm, and the A/A noise floor stayed where it was without it. Environment overrides, to be kept the same for every arm and
round of a run:

| variable | effect |
|---|---|
| `ONYX_PERF_ITERATIONS=N` | exactly N samples per arm, no time budget |
| `ONYX_PERF_WARMUP=N` | at most N warm-up iterations (default 8) |
| `ONYX_PERF_GC_MODE=adaptive\|minor\|major\|none` | collection between iterations (default `adaptive`) |
| `ONYX_PERF_GC_PASSES=N` | `global.gc()` calls between iterations in `major` mode (default 2) |
| `ONYX_PERF_SETTLE_PASSES=N` | full collections between the warm-up and the samples (default 0) |

The collection between iterations only has to keep one iteration's garbage out of the next one's
timing, and that garbage lives in the young generation (32 MB). `minor` scavenges after every
iteration; `adaptive` skips the scavenge while less than 8 MB was allocated since the last one, which
is most iterations of the cheap rows. `retainedHeapMb` is the heap after the last collection, so read
its trend, not its level; `major` restores full collections when the level matters.

The mode changes the level of the numbers, not only the wall clock. Measured 2026-09-22 on the `pr834`
arm, classic single-arm runs, twice per mode, `--scale small`:

| row | major GC between iterations | minor GC |
|---|---|---|
| `hooks/mount/warm-key-no-selector` | 0.37 / 0.34 ms | 0.079 / 0.078 ms |
| `hooks/unmount-remount/churn` | 0.47 / 0.50 ms | 0.109 / 0.115 ms |
| `hooks/update/value-changes` | 1.49 / 1.50 ms | 1.23 / 1.26 ms |

A forced full collection after every iteration leaves the next iteration cold (empty young
generation, cold caches), which is a state the app is never in between two renders, so the `minor`
numbers are the steady state and the `major` ones were about 5x inflated on the sub-millisecond rows.
Results from before 2026-09-22 are in the `major` regime and are not comparable in level with newer
runs. The `update/*` rows sit on a floor of about 1.2 ms in either mode, which is the timer
`waitForOnyx` awaits, not Onyx work.

Each result line also records where the time outside the samples went: `setupMs`, `wallMs`,
`phasesMs` (`warmup`, `fullGc`, `measured`, `teardown`) and, as counters, `beforeEachMs`, `afterEachMs`
and `gcMs`. The report's "Cost" section sums them per size.

## Scale profiles

`harness/scale.ts` has four. A default run measures `small`, `large` and `heavy`; `medium` is kept for
single-size runs. `heavy` is the size the app's own performance issues quote for a P95 customer account
(about 20k personal details in Expensify/App#101083, thousands of reports, a hot chat with thousands of
actions):

| profile | reports | active reports x actions | hot report actions | personal details | policies | transactions | module listeners | hook components (K) | update batch keys |
|---|---|---|---|---|---|---|---|---|---|
| small | 50 | 5 x 20 | 100 | 50 | 5 | 50 | 20 | 1 | 10 |
| medium | 300 | 20 x 60 | 500 | 500 | 20 | 500 | 100 | 30 | 40 |
| large | 1500 | 60 x 150 | 2000 | 3000 | 60 | 3000 | 400 | 150 | 150 |
| heavy | 5000 | 100 x 200 | 5000 | 20000 | 100 | 5000 | 500 | 300 | 300 |

K is kept at realistic App counts rather than scaled with the fixtures: 1 is the no-sharing floor,
30 a hot key on one phone screen, 150 a hot key on web with the LHN and a report mounted, 300 the same
on a P95 account. `storeKeyCount(profile)` in `fixtures/account.ts` is the number of keys a seeded store
holds.

The fixture is seeded with one `Onyx.multiSet` of every key (39 ms at `heavy`, against 85 ms for the
per-collection writes it replaced, with identical counters).

`--filter` narrows which scenarios a suite file registers; `--files` decides which suite files are
loaded at all, so it is the faster one while developing:

```bash
perf-suite/scripts/run-arm.sh baseline 1 dev --scale small --files 'flows/lhn'
perf-suite/scripts/ab.sh --aa --scale large --files '(api/multiSet|flows/signOut|hooks/keySwitch)\.perf'
```

Timings from a `--files` run are not directly comparable with timings from a full one: the heap the
process carries is much smaller, and so are the collections.

Lower-level entry points:

```bash
perf-suite/scripts/build-arm.sh candidate                                  # working tree -> .build/candidate/dist
perf-suite/scripts/build-arm.sh baseline --ref HEAD~1                      # a commit -> .build/ref-<sha>/dist
perf-suite/scripts/run-arm.sh baseline 1 my-run --scale small              # one arm, one round
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON perf-suite/scripts/compare.ts my-run
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON perf-suite/scripts/toCsv.ts my-run  # report.json -> report.csv
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON perf-suite/scripts/variants.ts my-run hooks/expense-list  # variants side by side -> variants-<prefix>.md
```

## Wall clock

A full `ab.sh --aa` at small (hot-swap, 170 rows: the 110 scenarios plus the expense-list variants) took 50 s on
an Apple M5 Pro (run `20260925-135337-aa`), with none flagged. In the App-hosted suite the full three-scale A/A
took 262 s (small 24 s, large 89 s, heavy 149 s); most of the difference is the App's import and transform
time, which the port does not have. The report's "Cost" section splits a run into scenario wall clock and what
is left, mostly the Jest boot and the suite file loads.

Scales never run in parallel: `--jobs` exists, but parallel processes share cores and memory and move
the numbers. Use `--scale` or `--files` for a shorter run instead.

## What the suite cannot measure

- **Hermes.** Everything runs on Node's V8 under jsdom. The app's native builds run Hermes, which has no
  JIT and prices closures, `Map`/`WeakMap` traffic and property access differently, and
  Expensify/App#100271 shows the same Onyx change landing at -12% on web and +1% on native for one
  metric. A hook-level win measured here is a V8 number until it is checked on a device.
- **The storage backend.** `suites/storage` runs the real `IDBKeyValProvider` on `fake-indexeddb`, which
  reproduces the main-thread serialization (`structuredClone` per put and get) but not the browser's
  IndexedDB backend. `SQLiteProvider` needs a native module and is not measured at all, so a native
  storage cost (the `json_patch` merge, a full-table read at boot) has to come from a device.
- **Navigation.** A key switch is a prop change on a handful of probes, not a screen transition; nothing
  here includes what React Navigation adds on top of the Onyx work.
- **The product metrics.** `ManualOpenReport`, `ManualSendMessageVisible` and friends are what the team
  optimises against, and a flow here only contains their Onyx-visible part. The suite ranks mechanisms
  and catches regressions in them; it does not predict a span.

## Dependencies of the suite itself

`perf-suite/package.json` holds only what must differ from the repo root: the React version Expensify/App
runs (19.2) with its `react-test-renderer` and type definitions, the React Compiler, and the data libraries of
the fixture generators (`@ngneat/falso`, `date-fns`). Jest, Babel, TypeScript, `fake-indexeddb` and
`jest-environment-jsdom` resolve from the root `node_modules`. The root Jest config only crawls `lib/` and
`tests/`, so it never sees the suite's second copy of React.

## Type-check the suite

```bash
agent-queue/queue.sh run -- perf-suite/scripts/typecheck.sh
```

It emits the declarations of the working tree's `lib/` into `.build/types` and checks the suite against them,
the way Expensify/App reads Onyx through `dist/*.d.ts` with `skipLibCheck`. Checking `lib/` sources directly
would check them under the suite's `CustomTypeOptions` augmentation (`app/onyxTypes.ts`), which `lib/` is not
written for. Zero errors is the bar. The root `npm run typecheck` does not include the suite.

## Differences from the App

The App-hosted suite imported the App itself. The port carries a copy of what the scenarios need in `app/`,
and replaces the rest:

- **Keys, constants and derived dependencies** are generated from an App checkout into `app/generated/`
  (`ONYXKEYS.ts`, `CONST.ts`, `DERIVED_DEPENDENCIES.ts`), see [Refresh the App model](#refresh-the-app-model).
  `app/ONYXKEYS.ts` and `app/CONST.ts` wrap them; `app/types.ts` has loose copies of the value types, with
  only the fields the suite touches, and `app/collections/` the App's test data generators.
- **The derived-value engine** (`app/derived/`) is a port of `src/libs/actions/OnyxDerived/index.ts` with every
  Onyx-facing step kept: the one-shot read of the stored value, one `connectWithoutView` per dependency, no
  write until every connection has fired, callbacks coalesced into one compute on a microtask, collection
  deltas by reference, the reset on `Onyx.clear` and the write back with `skipCacheCheck`. The dependency
  lists are the App's. The compute is synthetic (`computeSyntheticValue.ts`): per member of the first
  collection dependency it derives a small attribute object, incrementally from the delta when there is a
  current value. Onyx sees the same reads, subscriptions and writes; the App's own compute time is not in it.
- **No logging or telemetry.** `Log`, the telemetry spans and the derived-value loop detector are App-side
  and left out.
- **A fixed `en` locale.** The locale dependency of a derived value is gated on
  `RAM_ONLY_ARE_TRANSLATIONS_LOADING` as in the App, and resolves to `en` once the flag clears; nothing
  loads translations.
- **`useOnyx` and the search snapshot.** `app/useOnyx.ts` ports the App's `src/hooks/useOnyx.ts` wrapper,
  snapshot branch included, over the contexts in `app/search.tsx`. `app/selectors.ts` has the selectors the
  scenarios read through.
- **A test renderer in place of `@testing-library/react-native`.** `harness/renderer.ts` does what RTL 13 does
  for the App's hook tests: a concurrent-root `react-test-renderer` created inside a synchronous `act`, with
  `IS_REACT_NATIVE_TEST_ENVIRONMENT` and `IS_REACT_ACT_ENVIRONMENT` set (`jest/setupHarness.ts`).
  `react-native` maps to a stub (`app/reactNative.ts`).
- **Real `setImmediate`.** The App gets a `setImmediate` on jsdom from its global fake timers. The suite runs
  on real timers, so its environment exposes Node's.

Parity with the App-hosted suite, checked 2026-09-25 on the `useOnyx` slot rewrite (`pr834` against
`pr834-slots`, `--files 'hooks/'`, run `20260925-135744`): the same rows move the same way, nothing is slower,
and every behavioural counter (renders, mounts, notifications) is identical between the arms. The largest
deltas match: `mount/collection-selector` -78.8% at medium and -96.5% at large (-77% and -95.7% in the App),
`update/collection-selector` -67.0% and -97.3% (-62% and -96.7%). The port flags a few more small rows (4 at
medium and 9 at large, against 3 and 7), for example `parent-rerender/stable` -25.3% against -29.8% and
`mount/warm-key-shared-selector` -13.1% at large, because none of the App's own cost sits in the timed path.

## Refresh the App model

```bash
agent-queue/queue.sh run -- perf-suite/app/snapshot/refresh.sh <path-to-Expensify-App-checkout>
```

It copies `app/snapshot/appModel.snapshot.ts` into the App's `tests/unit` for one Jest run (only the App's own
Jest setup can load its `ONYXKEYS`, `CONST` and derived configs), writes `app/generated/` with the App commit it
came from in the header, and removes the test file again. `appModel.snapshot.ts` picks which constants are
copied; add a field there when a scenario needs one. Commit the regenerated files with the change that needs
them, then run the typecheck.

## Read the report

One table per area. Each row is a scenario with both arms' median (plus MAD, p10, p90 and the
pooled sample count), the delta of the medians, a flag, and the `src/` call sites the scenario
stands for.

A row is flagged `FASTER` or `SLOWER` only when the pooled median delta clears a 5% relative
floor and twice the larger of the two MADs, and the per-round deltas all point the same way (each
above the floor). The `paired` column shows those per-round deltas condensed: their median, and how
many rounds share its sign over the rounds both arms have, so `-6.2% (4/4)` is four agreeing rounds
and `+4.6% (1/2)` a coin toss. Two Jest processes running identical code can differ by 10-20% on
sub-millisecond scenarios, which is why a one-round run can only be indicative; use two or more
rounds for a verdict. Everything else reads `noise`. `MISSING ARM` means one arm produced no
samples for that scenario, which is a bug in the run, not a result.

Iterations are pooled across rounds before the statistic is taken, so a two-round ABBA run gives
one median per arm over both orderings.

In a hot-swap A/A of the App-hosted suite the paired deltas sat at p50 0.6-0.7% and p90 2.4-3.0% at every scale. A handful of
rows whose median is a few microseconds lean 3-6% the same way in two full runs, for example
`subscriptions/fanout/collection-member` at small (-6.2% and -6.5%, about 6 µs), but land at -0.4% and
+0.8% when their file runs alone, so the lean comes from the state of the full-suite process, not from
either arm. A microsecond-level row near the 5% floor needs a second full run or a `--files` rerun before it
is read as a result. `node perf-suite/scripts/lean.ts <run-id> <run-id>` lists the rows that lean
the same way in two runs.

A row whose title starts with "indicative only" has a timing the suite cannot stabilise; read its
counters instead.

## The arm mechanism

`jest.config.js` maps `react-native-onyx` and `react-native-onyx/dist/*` into `$ONYX_PERF_ARM_DIR` (a classic
run) or into the generated hot-swap shims in `.hotswap/` (the default). It throws if the variable is unset or the
directory has no `index.js`. `scripts/build-arm.sh` builds an arm with the repo's own `tsconfig.build.json`,
`--noCheck` and no declarations: the arm only has to run, and a type error in an old ref must not block a
benchmark of it.

Other settings in `jest.config.js`:

- `roots` is only `entry/`. The arms under `.build/` carry `storage/__mocks__` folders that jest-haste-map would
  register as duplicate manual mocks; every other file resolves through the file system.
- `testEnvironment` is jsdom, as in Expensify/App, plus Node's `structuredClone` (for `fake-indexeddb`) and
  Node's real `setImmediate` (see [Differences from the App](#differences-from-the-app)).
- `haste.defaultPlatform` is `ios`: the App runs Jest on the jest-expo iOS preset, so Onyx resolves its
  `.native` files there and does here too.
- `fakeTimers.enableGlobally` is off. The harness measures wall-clock time and Onyx notifies on
  `process.nextTick` and timers.
- The arms stay untransformed (`transformIgnorePatterns`). Both are plain CommonJS `tsc` output, and running them
  through `babel-jest` would hand `useOnyx` to the React Compiler, which rewrites the function under
  measurement and never happens in the real app. Everything else goes through `babel.config.js`, which runs
  the React Compiler on the suite's components the way the App compiles its own. `@ngneat/falso` and `uuid`
  ship ESM and are transformed.
- `testSequencer` sorts the entry files by path. Jest's default sequencer orders by cached timing, so the
  file order changed once a run had been measured.
- `workerIdleMemoryLimit` comes from `ONYX_PERF_WORKER_MEMORY` (Jest 29 has no CLI flag for it).
- `react` maps to the suite's copy. Packages that resolve from the repo root (`use-sync-external-store`, which
  an arm may import) would otherwise load the root's React 18 next to the suite's React 19 and fail on the
  first hook.
- `cacheDirectory` is `perf-suite/.jest-cache`, separate from the root one.

## Add a scenario

Create `suites/<area>/<name>.perf.ts` (`.tsx` if it renders); `entry/shared.perf.ts` picks it up without
registration. Pick the id from `CATALOG.md`; the
area is derived from the first path segment, so it must be one of `api`, `subscriptions`, `hooks`,
`internals`, `flows`, `storage`.

```ts
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

const scenario = defineScenario({
    id: 'api/set/single-small',
    title: 'Onyx.set of a small object on a plain key with no subscribers',
    realUsage: [{file: 'src/libs/actions/App.ts', line: 423, note: 'what that line does'}],
    scale: (profile) => ({reports: profile.reports}),
    measure: {timeBudgetMs: 4000},
    setup: async (params): Promise<Context> => ({...}),
    beforeEach: async (context) => {...},
    run: async (context, params) => {
        await Onyx.set(...);
        return {somethingCounted: context.state.callbacks};
    },
    afterEach: async (context) => {...},
    teardown: async (context) => {...},
});

runScenarios([scenario]);
```

Rules that matter:

- `run` is the only timed part. Anything that restores pre-conditions belongs in `beforeEach`.
- Every iteration must do real work. If the value written is identical to the last one, Onyx skips
  the write and the scenario measures nothing; bump a revision counter in `beforeEach`.
- `realUsage` must not be empty. Its `src/` paths are Expensify/App paths, and the line numbers must be
  checked with grep in an App checkout before they go in.
- Return counters from `run` for anything worth watching next to the timing, for example how many
  subscriber callbacks a write produced. `retainedHeapMb` is recorded automatically after each
  iteration's collection; a rising series there means the scenario leaks state between iterations.
- Keep a sample above roughly 0.3 ms. Below that the harness's own `await` around the timed region is
  a visible part of the measurement and the row drifts by 15% against itself. Repeat the call inside
  `run` rather than adding iterations, and record the repeat count in `scale` so the report shows it.
- A scenario whose iteration is expensive is bounded by `minIterations`, not by `timeBudgetMs`: the
  budget is only checked once `minIterations` has been reached. Ten samples per round were not enough
  for any of the React-heavy rows; 24 were.
- Read the fixture with `getHeavyAccount()`; it resolves the scale profile itself and is built once
  per Jest file. `seedOnyxWithAccount(account)` writes it in one `multiSet`.
- `scale` must read every profile field the work depends on, so the three sizes measure three sizes. A
  scenario whose work cannot depend on the data declares `sizeIndependent: '<reason>'` instead; any other
  row with identical params at every size is listed in the report's "Size check".
- Never call `jest.resetModules` from a suite in the shared entry; such a suite goes into
  `ISOLATED_SUITES` in `harness/loadSuites.ts` with an entry file of its own.
