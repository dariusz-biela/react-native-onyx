# Scenario catalog

The full list of scenarios the suite must cover, grouped by suite folder. Each entry names the
Onyx surface it measures and the real app usage it stands for. Anchors are `src/` paths; the
implementing agent verifies the line numbers with grep before writing them into `realUsage`.

Sizes refer to the scale profile in `harness/scale.ts`. A default run measures every row at `small`,
`large` and `heavy` (a P95 customer account, see README.md); N, K, M, U and A below are the profile's
reports or personal details, hooks on one key, module listeners, keys in one update batch and actions per
active report. Every scenario runs against the app's real `ONYXKEYS` and the shared
heavy-account fixture unless stated.

Legend for the "what is timed" column: the timed region is the awaited public call unless noted.
The "status" column names the suite file the row is implemented in, relative to `suites/`, and
carries a short note wherever the implementation departs from the row as written here. HANDOFF.md
has the full reasoning behind every one of those notes.

## suites/api

| id | what is timed | real usage | status |
|---|---|---|---|
| api/set/single-small | `Onyx.set` of a small object on a plain key (e.g. `ONYXKEYS.IS_LOADING_APP`) with no subscribers | `src/libs/actions/App.ts` setIsLoadingApp-style flags, `Onyx.set(` has 260 sites | `api/set.perf.ts` |
| api/set/single-large | `Onyx.set` of the whole `PERSONAL_DETAILS_LIST` (N entries) | `src/libs/actions/PersonalDetails.ts` | `api/set.perf.ts` |
| api/set/null-removes | `Onyx.set(key, null)` on a key with a value | `src/libs/actions/Wallet.ts:293`, `OdometerTransactionUtils.ts:104` | `api/set.perf.ts` |
| api/set/with-subscribers | `Onyx.set` on a key watched by M `connectWithoutView` listeners + K hooks | `ONYXKEYS.SESSION` is read by 173 hooks and many module listeners | `api/set.perf.ts`, module listeners only, the hook side is in suites/flows |
| api/multiSet/mixed-keys | `Onyx.multiSet` of ~10 unrelated keys | `src/libs/actions/App.ts:423`, `PersistedRequests.ts:322` | `api/multiSet.perf.ts`, ten multiSet calls per sample |
| api/multiSet/collection-members | `Onyx.multiSet` of N report members (the Onyx perf-test pattern) | `src/libs/actions/ImportOnyxState.ts:22` | `api/multiSet.perf.ts` |
| api/merge/single-field-report | merge one field into one report while the report collection has subscribers | `src/libs/actions/Report/index.ts:1542` | `api/merge.perf.ts` |
| api/merge/report-actions-batch | merge a page of 50 actions into a report with 300 | `src/libs/Middleware/Pagination.ts` + `Report/index.ts:2469` | `api/merge.perf.ts`, target size comes from the scale profile, not a fixed 300 |
| api/merge/same-key-burst | 20 merges on the same key in one tick (merge queue batching) | typing indicator `Report/index.ts:654`, form drafts | `api/merge.perf.ts` |
| api/merge/nested-null-removal | merge with a nested `null` clearing `pendingAction` of one action inside a report actions member of A actions | `Report/index.ts:1520`, `Report/index.ts:1085` (success data of a sent comment) | `api/merge.perf.ts` |
| api/merge/array-vs-object | merge where an array replaces an object (compat check path) | `utils.checkCompatibilityWithExistingValue` | `api/merge.perf.ts`, array over array, an array over an object is rejected before any work |
| api/merge/deep-personal-details | merge one entry into `PERSONAL_DETAILS_LIST` with N entries | `src/libs/actions/PersonalDetails.ts` | `api/merge.perf.ts` |
| api/mergeCollection/transactions | `Onyx.mergeCollection` of K transaction drafts | `src/libs/actions/IOU/MoneyRequest.ts:670` | `api/mergeCollection.perf.ts` |
| api/mergeCollection/reports-full | `Onyx.mergeCollection` of N reports (OpenApp size) with LHN-style subscribers | OpenApp response applied through `Onyx.update` -> mergeCollection | `api/mergeCollection.perf.ts` |
| api/setCollection/drafts-clear | `Onyx.setCollection(REPORT_ACTIONS_DRAFTS, {})` with M drafts present | `src/libs/actions/Report/index.ts:3774` | `api/setCollection.perf.ts` |
| api/setCollection/replace | `Onyx.setCollection` replacing N members with N others | `src/libs/actions/ImportOnyxState.ts:15` | `api/setCollection.perf.ts` |
| api/update/openapp-batch | `Onyx.update` with a realistic OpenApp payload (reports, reportActions, personalDetails, policies as mergeCollection/merge/set) | `src/libs/Middleware/SaveResponseInOnyx.ts`, `src/libs/actions/OnyxUpdates.ts` | `api/update.perf.ts` |
| api/update/pusher-small | `Onyx.update` with 3 small merges (report + reportActions + reportMetadata) | `src/libs/actions/OnyxUpdates.ts:128` | `api/update.perf.ts` |
| api/update/optimistic-success-pair | two `Onyx.update` calls (optimisticData then successData) for a sent comment | `src/libs/actions/Report/index.ts` addComment, `SequentialQueue.ts:490` | `api/update.perf.ts` |
| api/update/failure-rollback | `Onyx.update(failureData)` after optimistic | `SequentialQueue.ts:522` | `api/update.perf.ts` |
| api/update/mixed-methods | one batch with set + merge + mergeCollection + setCollection entries | `src/libs/actions/Card.ts:1679` style | `api/update.perf.ts`, U collection members and the personal details list |
| api/update/member-set-and-remove | two `Onyx.update` calls on U transaction members, one setting them and one setting them to null, both grouped into `partialSetCollection`, with M collection listeners | `ImportTransactions.ts:364`, `ImportTransactions.ts:369` | `api/update.perf.ts` |
| api/clear/sign-out | `Onyx.clear(KEYS_TO_PRESERVE_ON_SIGN_OUT)` with the full account loaded and M listeners + K hooks mounted | `src/libs/actions/SignInRedirect.ts:104` | `api/clear.perf.ts`, module listeners only, preserve list copied into fixtures/signOutKeys.ts |
| api/clear/preserve-none | `Onyx.clear()` with only cache, no subscribers | `ImportOnyxState.ts:10` | `api/clear.perf.ts` |
| api/init/boot-cold | `Onyx.init` with the app config and N keys already in (mock) storage: time until `OnyxUtils.getDeferredInitTask()` resolves | `src/setup/index.ts:45` | `api/init.perf.ts`, cold init through jest.resetModules() |
| api/init/boot-empty | `Onyx.init` with empty storage | first launch | `api/init.perf.ts`, cold init through jest.resetModules() |
| api/connect-disconnect/churn | `Onyx.connect` + `Onyx.disconnect` 200 times on the same warm key | `src/libs/actions/OnyxDerived/index.ts:50` one-shot reads, `cleanupPreMountedDraftReports.ts` | `api/connectDisconnect.perf.ts` |
| api/merge/hot-report-single-action | `Onyx.merge` of one new action into the hot report actions member that already holds H actions (`hotReportActions` in the profile) | `src/libs/actions/Report/index.ts:2469`, a Pusher update on a busy chat | `api/hotReport.perf.ts` |
| api/merge/hot-report-page | `Onyx.merge` of a 50-action page into the hot member with H actions | `src/libs/Middleware/Pagination.ts:173` | `api/hotReport.perf.ts` |
| api/merge/personal-details-batch | `Onyx.merge` of a 100-entry patch into `PERSONAL_DETAILS_LIST` with N entries, no subscribers (the ReconnectApp batch of Expensify/App#101083) | `src/libs/actions/PersonalDetails.ts:127`, `OnyxUpdates.ts:66` | `api/personalDetails.perf.ts` |

## suites/subscriptions

| id | what is timed | real usage | status |
|---|---|---|---|
| subscriptions/connect/plain-key-warm | `connectWithoutView` on a warm plain key until the first callback | `src/libs/ApiUtils.ts:23`, `SessionUtils.ts:73` | `subscriptions/connect.perf.ts` |
| subscriptions/connect/plain-key-cold | same on a key only in (mock) storage, not in cache | boot-time module listeners | `subscriptions/connect.perf.ts`, cold state via cache.drop then cache.addKey |
| subscriptions/connect/collection-object | `connectWithoutView` on `COLLECTION.REPORT` until the first callback (3.0.111 always delivers the whole collection object; there is no `waitForCollectionCallback`, `sourceValue` or `initWithStoredValues` option in this version) | `src/libs/actions/OnyxDerived/index.ts:266` (report attributes depend on the report collection) | `subscriptions/connectCollection.perf.ts` |
| subscriptions/connect/collection-member-key | `connectWithoutView` on one `COLLECTION.REPORT}${id}` member key until the first callback | `src/libs/cleanupPreMountedDraftReports.ts` style | `subscriptions/connect.perf.ts` |
| subscriptions/fanout/plain-key | one `Onyx.merge` on a key with M listeners: time to the last callback | `ONYXKEYS.NETWORK`, `SESSION` module listeners | `subscriptions/fanout.perf.ts` |
| subscriptions/fanout/collection-member | one member merge with M collection-object listeners + M member listeners | LHN + derived values on report changes | `subscriptions/fanout.perf.ts` |
| subscriptions/fanout/unrelated-key | one merge on a key with no listeners while M listeners watch other keys (the keyChanged scan) | any write in a loaded app | `subscriptions/fanout.perf.ts` |
| subscriptions/fanout/mergeCollection | `mergeCollection` of 100 reports with M collection listeners: callbacks fired once per listener, not per member | OpenApp apply with derived values live | `subscriptions/fanout.perf.ts` |
| subscriptions/reuseConnection/false | connect 100 times with `reuseConnection: false` vs default | `src/libs/Network/SequentialQueue.ts:646` | `subscriptions/reuseConnection.perf.ts`, read together with api/connect-disconnect/churn |
| subscriptions/disconnect/all | `disconnect` of M listeners in a row | sign-out, `OnyxConnectionManager.disconnectAll` | `subscriptions/disconnect.perf.ts` |
| subscriptions/derived/report-attributes | the real `OnyxDerived` init + one report merge until the derived key updates | `src/libs/actions/OnyxDerived/index.ts` | `subscriptions/derived.perf.ts`, real initOnyxDerivedValues, needs the IntlStore recipe |
| subscriptions/derived/reconnect-delta | a ReconnectApp delta of min(200, N) reports applied through `Onyx.update` with the real `OnyxDerived` init live, until report attributes are written and Onyx drains | `src/libs/actions/OnyxDerived/configs/reportAttributes.ts:219` | `subscriptions/derivedBatch.perf.ts` |
| subscriptions/instance-sync/apply-remote-batch | the handler `Onyx.init` gives the storage layer for another tab's write, applying U report members and two plain keys on a loaded app | `src/setup/index.ts:45` (web syncs tabs by default), `OnyxUpdates.ts:128` | `subscriptions/instanceSync.perf.tsx`, the handler is captured by running init again with `keepInstancesSync` swapped |

## suites/hooks

All through the app wrapper `@hooks/useOnyx` (`src/hooks/useOnyx.ts`), rendered with the same
renderer the app's hook tests use. `K` = `hookComponents` from the scale profile.

| id | what is timed | real usage | status |
|---|---|---|---|
| hooks/mount/warm-key-no-selector | mount K components reading `ONYXKEYS.SESSION` | 173 sites | `hooks/useOnyxMount.perf.tsx` |
| hooks/mount/warm-key-shared-selector | mount K components with one module-level selector | `src/selectors/*` (`isTrackIntentUserSelector` 76 sites) | `hooks/useOnyxMount.perf.tsx` |
| hooks/mount/warm-key-inline-selector | mount K components each with its own inline selector | most `selector:` sites (943) | `hooks/useOnyxMount.perf.tsx` |
| hooks/mount/cold-key | mount K components on a key not yet in cache | first screen after boot | `hooks/useOnyxMount.perf.tsx`, key in neither cache nor storage, fresh key per iteration |
| hooks/mount/collection | mount K components reading `COLLECTION.POLICY` (whole collection) | 180 sites | `hooks/useOnyxMount.perf.tsx` |
| hooks/mount/collection-member | mount K components each reading a different `COLLECTION.REPORT}${id}` | report rows in LHN | `hooks/useOnyxMount.perf.tsx` |
| hooks/update/value-changes | one merge that changes the result for all K | session/account update | `hooks/update.perf.tsx` |
| hooks/update/result-unchanged | one merge on the key where the selector result stays equal | the -87% row in repo/onyx-hook-perf/FINDINGS.md | `hooks/update.perf.tsx` |
| hooks/update/unrelated-member | K components on different members, one member merged: only one re-renders | LHN row update | `hooks/update.perf.tsx` |
| hooks/update/collection-object | K components on the collection object, one member merged | policy list under updates | `hooks/update.perf.tsx` |
| hooks/update/burst | 20 merges in one tick on a watched key | typing indicator, drafts | `hooks/update.perf.tsx` |
| hooks/key-switch/report-screen | max(1, K/10) components walking their key together across 20 report member keys | report screen navigation | `hooks/keySwitch.perf.tsx`, indicative only, see HANDOFF.md |
| hooks/unmount-remount/churn | mount and unmount K components repeatedly on a warm key | list virtualization | `hooks/churn.perf.tsx` |
| hooks/parent-rerender/stable | parent re-renders K children whose Onyx value did not change | any parent state change | `hooks/parentRerender.perf.tsx` |
| hooks/snapshot/search-path | K components inside `SearchResultsContext` reading through the snapshot branch of the wrapper | `src/hooks/useOnyx.ts` snapshot path, Search page | `hooks/snapshot.perf.tsx`, the real contexts, not SearchContextProvider |
| hooks/loading-status/pending-merge | mount while a merge for the key is queued (status `loading` path) | initial data fetch | `hooks/loadingStatus.perf.tsx`, the pending merge is started inside the timed region |
| hooks/mount/collection-selector | mount K components on `COLLECTION.REPORT` through one module-level selector that projects all N reports | `src/hooks/usePersonalDetailOptions.ts:188`, one of 121 collection-plus-selector sites | `hooks/collectionSelector.perf.tsx`, every hook renders twice on mount, see HANDOFF.md |
| hooks/update/collection-selector | one report member merge with those K hooks mounted, so every hook re-projects all N reports | same | `hooks/collectionSelector.perf.tsx` |
| hooks/update/per-instance-selector | one personal details merge changing one person, with K hooks on the N-entry list each selecting a different person | `MoneyRequestHeader.tsx:63`, `selectors/PersonalDetails.ts:26` | `hooks/update.perf.tsx`, one hook re-renders |
| hooks/unmount-remount/member-keys | mount plus unmount K components each on its own report member key (the LHN fling) | `OptionRowLHNData.tsx:125` | `hooks/memberChurn.perf.tsx`, read against `hooks/unmount-remount/churn` |
| hooks/expense-list/{pattern}/mount | mount a 100-row expense list over the scale's N transactions, `{pattern}` is `root-all`, `root-all-memo`, `root-ids`, `root-ids-memo` or `root-fresh-items` (the root rebuilds every item object on each change, like getSections on Search, `useSearchSnapshot.ts:188`) | `MoneyRequestReportTransactionList.tsx:172` | `hooks/expenseList.perf.tsx`; `root-all*` read the full transactions in the root and pass them down (`MoneyRequestReportView.tsx:134`), `root-ids*` read ids in the root and each row reads its own member key (`TransactionPreview/index.tsx:52`), `*-memo` wrap the row in `memo`. Compare patterns with `scripts/variants.ts` |
| hooks/expense-list/{pattern}/edit-one | one `Onyx.merge` into one listed transaction | `UpdateMoneyRequest.ts:518` | `hooks/expenseList.perf.tsx` |
| hooks/expense-list/{pattern}/edit-all | one `Onyx.mergeCollection` into all 100 listed transactions | `OnyxUpdates.ts:66` | `hooks/expenseList.perf.tsx` |
| hooks/expense-list/{pattern}/unrelated-member | one `Onyx.merge` into a transaction outside the list | any other report's expense | `hooks/expenseList.perf.tsx`, expect `renders: 0` |
| hooks/expense-list/{pattern}/add | `Onyx.set` of a new transaction on the listed report | `TrackExpense.ts:1667` | `hooks/expenseList.perf.tsx` |
| hooks/expense-list/{pattern}/remove | `Onyx.set(key, null)` of one listed transaction | `DeleteMoneyRequest.ts:775` | `hooks/expenseList.perf.tsx` |
| hooks/expense-list-heavy-row/{pattern}/{operation} | the same 30 scenarios with a row shaped like TransactionItemRowWide: 8 cell components, each reading a styles context, date and amount formatted through `Intl` | `src/components/TransactionItemRow/TransactionItemRowWide.tsx` | `hooks/expenseList.perf.tsx`, rows in `hooks/expenseListRows.tsx`; the light rows measure Onyx and React bookkeeping, these add what the re-rendered rows cost |

## suites/internals

| id | what is timed | real usage | status |
|---|---|---|---|
| internals/OnyxCache/get-set | N `cache.set` then N `cache.get` | every read and write | `internals/onyxCache.perf.ts` |
| internals/OnyxCache/merge-collection | `cache.merge` of 100 members into a collection with N | `OnyxUtils.mergeCollectionWithPatches` | `internals/onyxCache.perf.ts` |
| internals/OnyxCache/collection-snapshot | `getCollectionData` on a dirty collection of N (rebuild) vs clean (cached) | `getCachedCollection` for collection subscribers | `internals/onyxCache.perf.ts`, rebuild and cached read in one timed region |
| internals/OnyxCache/drop-and-eviction | `drop` + `getKeyForEviction` with the app's evictable keys and a large recently-accessed list | `OnyxUtils.remove`, storage full path | `internals/onyxCache.perf.ts`, does not scale with the profile, a coverage row |
| internals/OnyxCache/hydrate | `hydrate` of N keys | `initStoreValues` at boot | `internals/onyxCache.perf.ts` |
| internals/OnyxKeys/isKeyMatch | `isKeyMatch` / `getCollectionKey` / `splitCollectionMemberKey` / `isCollectionMemberKey` over 10k app keys | hot path of every notify | `internals/onyxKeys.perf.ts` |
| internals/OnyxUtils/keyChanged-scan | `keyChanged` with M subscribers on other keys (the scan cost) | every write | `internals/onyxUtilsNotify.perf.ts`, a hundred calls per sample |
| internals/OnyxUtils/keysChanged | `keysChanged` for a collection with M collection subscribers | mergeCollection notify | `internals/onyxUtilsNotify.perf.ts`, twenty calls per sample |
| internals/OnyxUtils/getCachedCollection | `getCachedCollection` for N members | collection subscribers | `internals/onyxUtilsCollections.perf.ts` |
| internals/OnyxUtils/mergeChanges | `mergeChanges` / `mergeAndMarkChanges` over a queue of 20 changes | merge queue flush | `internals/onyxUtilsMerge.perf.ts`, covers mergeAndMarkChanges too |
| internals/OnyxUtils/prepareKeyValuePairsForStorage | over N pairs with nested nulls | every multiSet/mergeCollection | `internals/onyxUtilsMerge.perf.ts` |
| internals/OnyxUtils/reduceCollectionWithSelector | selector applied over N members | `useOnyx` with a selector on a collection | `internals/onyxUtilsCollections.perf.ts` |
| internals/OnyxUtils/updateSnapshots | `updateSnapshots` with 5 snapshots of 500 rows and a batch of 10 updates | Search results kept in sync | `internals/onyxUtilsCollections.perf.ts` |
| internals/OnyxUtils/tryGetCachedValue | 10k reads of a plain key and of a collection key | every `getSnapshot` | `internals/onyxUtilsCollections.perf.ts` |
| internals/utils/fastMerge-deep | `fastMerge` of two realistic reportActions maps (300 + 50) | every merge | `internals/fastMerge.perf.ts` |
| internals/utils/fastMerge-shallow | `fastMerge` of a report with a 2-field patch | every small merge | `internals/fastMerge.perf.ts` |
| internals/utils/removeNestedNullValues | over the personal details list with scattered nulls | set/multiSet prepare | `internals/utils.perf.ts`, ten passes per sample |
| internals/utils/checkCompatibilityWithExistingValue | 10k calls | merge queue | `internals/utils.perf.ts` |
| internals/OnyxMerge/apply | ten `OnyxMerge.applyMerge` calls on report + patches, the native variant the directory import resolves to | merge path | `internals/onyxMerge.perf.ts`, ten calls per sample |
| internals/OnyxMerge/apply-web | the same ten calls through the web variant, imported by its explicit `index.js` path | merge path on web | `internals/onyxMerge.perf.ts`, the `isWebVariant` counter proves which file ran |
| internals/createMemoizedSelector/hit-miss | memoized selector on same input, changed input, equal output | every selector hook | `internals/memoizedSelector.perf.ts` |
| internals/memoizedShallowEqual/cases | equal ref, equal content, different content, large objects | every hook result compare | `internals/memoizedShallowEqual.perf.ts` |
| internals/OnyxSnapshotCache/register-invalidate | register K consumers, invalidate a key, read | `useOnyx` (baseline only; candidate may not use it, record 0 if the module is absent and say so) | `internals/snapshotCache.perf.ts`, present in both arms, dead code on the candidate |
| internals/OnyxConnectionManager/connect-disconnect | 1000 connect/disconnect cycles, `refreshSessionID` with 1000 live | hooks churn, sign-out | `internals/connectionManager.perf.ts` |
| internals/OnyxSubscriptionManager/notify | `subscribe` M listeners, `notifyKey` and `notifyCollection` | the new store layer (PR #833) | `internals/subscriptionManager.perf.ts` |
| internals/StorageCircuitBreaker/pass-through | 10k operations through the breaker in the closed state | every storage call | `internals/circuitBreaker.perf.ts`, isAllowed plus recordWriteSuccess |

## suites/flows

End-to-end scenarios that stack several APIs the way the app does. Each has module listeners
and hooks mounted the way a loaded app has them (see `harness/onyx.ts` for a `mountLoadedApp`
helper: M `connectWithoutView` listeners over the keys with the most sites, K hooks on session,
personal details, policies, reports and the current report, plus the real `OnyxDerived` init).

| id | what is timed | real usage | status |
|---|---|---|---|
| flows/boot/hydrate-and-first-subscribers | `Onyx.init` on N stored keys, then M module listeners connect, until all have fired | app boot | `flows/boot.perf.ts`, no React tree, listeners attached through the fresh module |
| flows/boot/listeners-before-init | M module listeners connect on a fresh Onyx before `Onyx.init` over the stored account, until init resolved and every listener fired | `SessionUtils.ts:73`, `ApiUtils.ts:23` (import-time listeners), `src/setup/index.ts:45` | `flows/boot.perf.ts`, the order a real bundle evaluates in |
| flows/openapp/apply-response | `Onyx.update(openAppPayload)` with the loaded-app subscribers mounted | `SaveResponseInOnyx` after OpenApp | `flows/openApp.perf.ts`, no derived init, 24 to 30 samples per round |
| flows/reconnect/apply-delta | `Onyx.update` of a ReconnectApp-style delta (200 reports changed) | `ReconnectApp` | `flows/reconnect.perf.ts`, min(200, profile.reports) reports, no derived init |
| flows/pusher/burst | 30 Pusher-style updates applied sequentially (`applyPusherOnyxUpdates` shape) | `src/libs/actions/OnyxUpdates.ts:110` | `flows/pusher.perf.tsx`, one act per event, no derived init |
| flows/comment/send | optimistic update, success update for one comment with the report screen mounted | addComment | `flows/comment.perf.tsx`, one act per write |
| flows/report-screen/open | switch the current report hook set to a new report and merge its 50-action page | navigating to a report | `flows/reportScreen.perf.tsx`, rotates over ten reports instead of restoring one |
| flows/lhn/report-update | one report's `lastVisibleActionCreated` merge with K LHN rows mounted on member keys and the sidebar collection subscriber | LHN reorder | `flows/lhn.perf.tsx` |
| flows/search/snapshot-merge | merge into `COLLECTION.SNAPSHOT}${hash}` with `snapshotMergeKeys` and search hooks mounted | `src/libs/actions/Search.ts:562` | `flows/search.perf.tsx`, hooks on the snapshot member key, not the wrapper branch |
| flows/personal-details/one-user-changes | merge one user's display name into a list of N with K consumers | avatar/name update | `flows/personalDetails.perf.tsx` |
| flows/sign-out/clear | `Onyx.clear(KEYS_TO_PRESERVE_ON_SIGN_OUT)` with everything mounted | sign-out | `flows/signOut.perf.tsx`, 20 to 24 samples per round |
| flows/typing/indicator | 10 merges on `REPORT_USER_IS_TYPING` for the open report with its hook mounted | `Report/index.ts:654` | `flows/typing.perf.tsx`, one act per event, 24 to 30 samples per round |
| flows/draft/keystrokes | 30 `Onyx.merge` on `REPORT_DRAFT_COMMENT` for the open report | composer drafts | `flows/draft.perf.tsx`, one act per keystroke |
| flows/personal-details/batch-update | a 100-entry personal details merge with the loaded app mounted and the real derived values live | `OnyxUpdates.ts:66`, `reportAttributes.ts:219` | `flows/personalDetailsBatch.perf.tsx` |
| flows/offline-queue/enqueue | one `Onyx.set` of `PERSISTED_REQUESTS` with R requests already queued (R = 5 x `updateBatchKeys`), the queue's two module listeners, one hook and the loaded app mounted | `PersistedRequests.ts:88`, `SequentialQueue.ts:643` | `flows/offlineQueue.perf.tsx`, the reseed of the R-request queue is untimed in beforeEach |

## suites/storage

The web storage provider, `IDBKeyValProvider`, driven directly against `fake-indexeddb` (installed by
`repo/onyx-perf/package.json`, not by the app). The app's Jest setup mocks only the storage facade
(`react-native-onyx/dist/storage`), so the provider module underneath is the real one. `fake-indexeddb`
runs `structuredClone` on every put and get, which is the main-thread part of a browser IndexedDB
operation; the backend (LevelDB, IPC, disk) is not reproduced and the SQLite provider needs a native module,
so nothing here says anything about native. `multiMerge` and `mergeItem` cannot run on `fake-indexeddb`
(see HANDOFF.md), so the web merge path is `internals/OnyxMerge/apply-web` plus `storage/idb/setItem-*`.

| id | what is timed | real usage | status |
|---|---|---|---|
| storage/idb/multiSet-reports | `multiSet` of N report members in one transaction | `Onyx.multiSet`, `setCollection`, `App.ts:423` | `storage/idb.perf.ts` |
| storage/idb/setItem-personal-details | `setItem` of the whole personal details list with N entries, what every web merge of one person ends in | `PersonalDetails.ts:127` through the web `OnyxMerge` | `storage/idb.perf.ts` |
| storage/idb/getAll-boot | `getAll` over the whole stored account, the eager cache load at `Onyx.init` | `src/setup/index.ts:45` | `storage/idb.perf.ts` |
| storage/idb/multiGet-report-members | `multiGet` of min(100, N) report member keys | cold collection reads | `storage/idb.perf.ts` |
| storage/idb/removeItems-sign-out | `removeItems` of every stored key but the preserved ones | `SignInRedirect.ts:104` | `storage/idb.perf.ts`, the reseed in beforeEach is untimed and costs more than the removal |
| storage/instance-sync/raise-events | the web `InstanceSync` events of one write: `multiSet` of U member keys, one `setItem`, and `removeItems` of every stored key | `OnyxUpdates.ts:128`, `SignInRedirect.ts:104` | `storage/instanceSync.perf.ts`, jsdom's `localStorage`, read for the Onyx share |

## Coverage check

Every export of the public `Onyx` object (`connect`, `connectWithoutView`, `disconnect`, `set`,
`multiSet`, `merge`, `mergeCollection`, `setCollection`, `update`, `clear`, `init`), `useOnyx`, and
every internal module in `lib/` (`OnyxCache`, `OnyxKeys`, `OnyxUtils`, `utils`, `OnyxMerge`,
`createMemoizedSelector`, `memoizedShallowEqual`, `OnyxSnapshotCache`, `OnyxConnectionManager`,
`OnyxSubscriptionManager`, `StorageCircuitBreaker`) has at least one scenario above, and `OnyxMerge` has
both platform variants. Cross-tab sync has both sides: the receiving handler
(`subscriptions/instance-sync/apply-remote-batch`) and the web events every write raises
(`storage/instance-sync/raise-events`). `COVERAGE.md` maps every public option and internal path to its
rows. Of the storage providers, `IDBKeyValProvider` has the `suites/storage` rows on
`fake-indexeddb`; `SQLiteProvider` needs a native module and stays out of scope, as do `DevTools`, `Logger`,
`Str`, `StateMachine` and `CircuitBreaker`, which are not on a hot path.
