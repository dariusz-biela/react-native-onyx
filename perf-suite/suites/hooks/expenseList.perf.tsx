import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';
import type {Transaction} from '@app/types';

import type {OnyxCollection} from 'react-native-onyx';
import type {Collection} from 'react-native-onyx/dist/types';

import Onyx from 'react-native-onyx';
import {View} from 'react-native';
import type {ComponentType} from 'react';
import {memo} from 'react';
import createRandomTransaction from '@app/collections/transaction';

import type {RealUsageAnchor, Scenario} from '../../harness/scenario';
import type {RenderedTree} from '../../harness/react';
import type {ExpenseRowContentProps, RowWeight} from './expenseListRows';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {withDeterministicRandom} from '../../fixtures/random';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync, renderProbes, unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';
import {ROW_CONTENT} from './expenseListRows';

/**
 * One expense report showing its 100 expenses, built five ways over the same data:
 *
 * - `root-all`: the list root reads every expense of the report out of the transaction collection and hands each
 *   row its transaction object as a prop, the way MoneyRequestReportView passes `transactions` down;
 * - `root-ids`: the list root reads only the ordered transaction ids, and every row reads its own transaction
 *   member key, the way a TransactionPreview does;
 * - `root-all-memo` and `root-ids-memo`: the same two roots with the row wrapped in `memo`. Without it every row
 *   re-renders whenever the root does, whatever the row reads, so the plain and the memo variant of a pattern
 *   separate what the read shape costs from what the missing `memo` costs;
 * - `root-fresh-items`: `root-all`, except the root turns every transaction into a new item object on each change,
 *   the way getSections rebuilds every Search list item whenever the snapshot changes, so no row keeps its props.
 *
 * Both roots walk the whole transaction collection in their selector, N background transactions plus the 100 of
 * the list, so the scale moves N while the list stays at 100 rows. Every operation is timed until React has
 * settled, and `renders` says how many rows and list roots ran.
 *
 * Every pattern runs with a light row (`hooks/expense-list/*`), where a row render costs close to nothing, and a
 * heavy row shaped like TransactionItemRowWide (`hooks/expense-list-heavy-row/*`), where the rows a pattern
 * re-renders cost what they do in the app. See expenseListRows.tsx.
 */
type TransactionKey = `${typeof ONYXKEYS.COLLECTION.TRANSACTION}${string}`;

type ListPattern = 'root-all' | 'root-all-memo' | 'root-ids' | 'root-ids-memo' | 'root-fresh-items';

type ExpenseListFixture = {
    transactions: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION, Transaction>;
    keys: TransactionKey[];
};

type ListContext = {
    fixture: ExpenseListFixture;
    state: {revision: number; tree: RenderedTree | undefined};
};

const LIST_ROWS = 100;
const LIST_REPORT_ID = '900000';
const FIRST_LIST_TRANSACTION_ID = 900001;

/** Outside the list and outside the account's own ids, so adding it grows the list by one row. */
const ADDED_TRANSACTION_ID = String(FIRST_LIST_TRANSACTION_ID + LIST_ROWS);

/** A row in the middle of the list, so a removal shifts half of the rows. */
const REMOVED_ROW_INDEX = LIST_ROWS / 2;

const LIST_MEASURE = {timeBudgetMs: 1500, minIterations: 12, maxIterations: 60};

function toTransactionKey(transactionID: string): TransactionKey {
    return `${ONYXKEYS.COLLECTION.TRANSACTION}${transactionID}`;
}

/** Distinct and ordered by index, so the list order is fixed and a new expense sorts to the top. */
function createdAt(index: number): string {
    const hours = String(Math.floor(index / 60)).padStart(2, '0');
    const minutes = String(index % 60).padStart(2, '0');

    return `2026-09-01 ${hours}:${minutes}:00`;
}

function createListTransaction(index: number): Transaction {
    const transactionID = String(FIRST_LIST_TRANSACTION_ID + index);

    return {...createRandomTransaction(FIRST_LIST_TRANSACTION_ID + index), transactionID, reportID: LIST_REPORT_ID, created: createdAt(index)};
}

let fixture: ExpenseListFixture | undefined;

function getExpenseListFixture(): ExpenseListFixture {
    if (fixture) {
        return fixture;
    }

    const built = withDeterministicRandom(() => {
        const transactions: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION, Transaction> = {};
        const keys: TransactionKey[] = [];

        for (let index = 0; index < LIST_ROWS; index++) {
            const transaction = createListTransaction(index);
            const key = toTransactionKey(transaction.transactionID);
            transactions[key] = transaction;
            keys.push(key);
        }

        return {transactions, keys};
    });
    fixture = built;

    return built;
}

function byCreatedDescending(left: Transaction, right: Transaction): number {
    return right.created.localeCompare(left.created);
}

/** The report's expenses, newest first, as full objects. Members that did not change keep their reference. */
function listTransactionsSelector(transactions: OnyxCollection<Transaction>): Transaction[] {
    const listTransactions: Transaction[] = [];

    for (const transaction of Object.values(transactions ?? {})) {
        if (transaction?.reportID === LIST_REPORT_ID) {
            listTransactions.push(transaction);
        }
    }

    return listTransactions.sort(byCreatedDescending);
}

/** The same walk and order as `listTransactionsSelector`, reduced to the ids. */
function listTransactionIDsSelector(transactions: OnyxCollection<Transaction>): string[] {
    return listTransactionsSelector(transactions).map((transaction) => transaction.transactionID);
}

type RowContent = ComponentType<ExpenseRowContentProps>;

type ExpenseRowProps = {transaction: Transaction; Content: RowContent};

type ExpenseRowByIDProps = {transactionID: string; Content: RowContent};

function ExpenseRow({transaction, Content}: ExpenseRowProps) {
    countRender();
    return <Content transaction={transaction} />;
}

function ExpenseRowByID({transactionID, Content}: ExpenseRowByIDProps) {
    countRender();
    const [transaction] = useOnyx(toTransactionKey(transactionID));
    return <Content transaction={transaction} />;
}

const MemoExpenseRow = memo(ExpenseRow);
const MemoExpenseRowByID = memo(ExpenseRowByID);

function TransactionsList({Row, Content}: {Row: ComponentType<ExpenseRowProps>; Content: RowContent}) {
    countRender();
    const [transactions] = useOnyx(ONYXKEYS.COLLECTION.TRANSACTION, {selector: listTransactionsSelector});

    return (
        <View>
            {transactions?.map((transaction) => (
                <Row
                    key={transaction.transactionID}
                    transaction={transaction}
                    Content={Content}
                />
            ))}
        </View>
    );
}

function toListItem(transaction: Transaction): Transaction {
    return {...transaction};
}

function FreshItemsList({Content}: {Content: RowContent}) {
    countRender();
    const [transactions] = useOnyx(ONYXKEYS.COLLECTION.TRANSACTION, {selector: listTransactionsSelector});
    const items = transactions?.map(toListItem);

    return (
        <View>
            {items?.map((item) => (
                <ExpenseRow
                    key={item.transactionID}
                    transaction={item}
                    Content={Content}
                />
            ))}
        </View>
    );
}

function TransactionIDsList({Row, Content}: {Row: ComponentType<ExpenseRowByIDProps>; Content: RowContent}) {
    countRender();
    const [transactionIDs] = useOnyx(ONYXKEYS.COLLECTION.TRANSACTION, {selector: listTransactionIDsSelector});

    return (
        <View>
            {transactionIDs?.map((transactionID) => (
                <Row
                    key={transactionID}
                    transactionID={transactionID}
                    Content={Content}
                />
            ))}
        </View>
    );
}

function createListRoot(pattern: ListPattern, Content: RowContent): ComponentType<{index: number}> {
    switch (pattern) {
        case 'root-all':
            return function RootAllList() {
                return (
                    <TransactionsList
                        Row={ExpenseRow}
                        Content={Content}
                    />
                );
            };
        case 'root-all-memo':
            return function RootAllMemoList() {
                return (
                    <TransactionsList
                        Row={MemoExpenseRow}
                        Content={Content}
                    />
                );
            };
        case 'root-ids':
            return function RootIDsList() {
                return (
                    <TransactionIDsList
                        Row={ExpenseRowByID}
                        Content={Content}
                    />
                );
            };
        case 'root-ids-memo':
            return function RootIDsMemoList() {
                return (
                    <TransactionIDsList
                        Row={MemoExpenseRowByID}
                        Content={Content}
                    />
                );
            };
        case 'root-fresh-items':
            return function RootFreshItemsList() {
                return <FreshItemsList Content={Content} />;
            };
    }
}

const ROOT_ALL_USAGE: RealUsageAnchor = {
    file: 'src/components/MoneyRequestReportView/MoneyRequestReportView.tsx',
    line: 134,
    note: 'the report view reads its transactions once and passes the objects down to the list',
};

const ROOT_IDS_USAGE: RealUsageAnchor = {file: 'src/components/ReportActionItem/TransactionPreview/index.tsx', line: 52, note: 'a row that reads its own transaction member key by id'};

const ROOT_FRESH_ITEMS_USAGE: RealUsageAnchor = {
    file: 'src/components/Search/hooks/useSearchSnapshot.ts',
    line: 188,
    note: 'getSections rebuilds every Search list item from the snapshot whenever it changes',
};

const PATTERN_USAGE: Record<ListPattern, RealUsageAnchor> = {
    'root-all': ROOT_ALL_USAGE,
    'root-all-memo': ROOT_ALL_USAGE,
    'root-ids': ROOT_IDS_USAGE,
    'root-ids-memo': ROOT_IDS_USAGE,
    'root-fresh-items': ROOT_FRESH_ITEMS_USAGE,
};

async function seedList(): Promise<ExpenseListFixture> {
    const listFixture = getExpenseListFixture();
    await seedOnyxWithAccount(getHeavyAccount());
    await Onyx.multiSet(listFixture.transactions);
    await waitForOnyx();

    return listFixture;
}

async function mountList(Root: ComponentType<{index: number}>): Promise<RenderedTree> {
    return renderProbes(1, Root);
}

async function writeAndSettle(write: () => Promise<void>): Promise<void> {
    await actAsync(async () => {
        await write();
        await waitForOnyx();
    });
}

async function unmountList(context: ListContext): Promise<void> {
    if (!context.state.tree) {
        return;
    }
    await unmountTree(context.state.tree);
    context.state.tree = undefined;
}

async function setupMountedList(Root: ComponentType<{index: number}>): Promise<ListContext> {
    const listFixture = await seedList();

    return {fixture: listFixture, state: {revision: 0, tree: await mountList(Root)}};
}

async function bumpRevision(context: ListContext): Promise<void> {
    context.state.revision++;
    resetRenderCount();
}

function listScale(profile: {transactions: number}) {
    return {listRows: LIST_ROWS, transactions: profile.transactions};
}

type Operation = {
    name: string;
    title: string;
    usage: RealUsageAnchor;
    define: (Root: ComponentType<{index: number}>, id: string, title: string, realUsage: RealUsageAnchor[]) => Scenario;
};

const OPERATIONS: Operation[] = [
    {
        name: 'mount',
        title: 'mount the 100-row expense list from a warm cache',
        usage: {file: 'src/components/MoneyRequestReportView/MoneyRequestReportTransactionList.tsx', line: 172, note: 'the expense list rendering one row per transaction of the report'},
        define: (Root, id, title, realUsage) =>
            defineScenario({
                id,
                title,
                realUsage,
                scale: listScale,
                measure: LIST_MEASURE,
                setup: async (): Promise<ListContext> => {
                    const listFixture = await seedList();
                    await unmountTree(await mountList(Root));

                    return {fixture: listFixture, state: {revision: 0, tree: undefined}};
                },
                beforeEach: async () => {
                    resetRenderCount();
                },
                run: async (context) => {
                    context.state.tree = await mountList(Root);

                    return {renders: getRenderCount()};
                },
                afterEach: unmountList,
            }),
    },
    {
        name: 'edit-one',
        title: 'one listed expense gets a new merchant',
        usage: {file: 'src/libs/actions/IOU/UpdateMoneyRequest.ts', line: 518, note: 'updateMoneyRequestMerchant merges the new merchant into one transaction'},
        define: (Root, id, title, realUsage) =>
            defineScenario({
                id,
                title,
                realUsage,
                scale: listScale,
                measure: LIST_MEASURE,
                setup: () => setupMountedList(Root),
                beforeEach: bumpRevision,
                run: async (context) => {
                    const [firstKey] = context.fixture.keys;
                    await writeAndSettle(() => Onyx.merge(firstKey, {merchant: `merchant ${context.state.revision}`}));

                    return {renders: getRenderCount()};
                },
                teardown: unmountList,
            }),
    },
    {
        name: 'edit-all',
        title: 'one mergeCollection gives all 100 listed expenses a new merchant',
        usage: {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'a server response batch, whose collection entries are routed into mergeCollection'},
        define: (Root, id, title, realUsage) =>
            defineScenario({
                id,
                title,
                realUsage,
                scale: listScale,
                measure: LIST_MEASURE,
                setup: () => setupMountedList(Root),
                beforeEach: bumpRevision,
                run: async (context) => {
                    const changes: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION, Partial<Transaction>> = {};
                    for (const key of context.fixture.keys) {
                        changes[key] = {merchant: `merchant ${context.state.revision}`};
                    }
                    await writeAndSettle(() => Onyx.mergeCollection(ONYXKEYS.COLLECTION.TRANSACTION, changes));

                    return {renders: getRenderCount()};
                },
                teardown: unmountList,
            }),
    },
    {
        name: 'unrelated-member',
        title: 'an expense of another report gets a new merchant, so the list shows nothing new',
        usage: {file: 'src/libs/actions/IOU/UpdateMoneyRequest.ts', line: 518, note: 'the same merchant edit, on an expense outside this report'},
        define: (Root, id, title, realUsage) =>
            defineScenario({
                id,
                title,
                realUsage,
                scale: listScale,
                measure: LIST_MEASURE,
                setup: () => setupMountedList(Root),
                beforeEach: bumpRevision,
                run: async (context) => {
                    await writeAndSettle(() => Onyx.merge(toTransactionKey('1'), {merchant: `merchant ${context.state.revision}`}));

                    return {renders: getRenderCount()};
                },
                teardown: unmountList,
            }),
    },
    {
        name: 'add',
        title: 'a new expense lands on top of the list',
        usage: {file: 'src/libs/actions/IOU/TrackExpense.ts', line: 1667, note: 'requestMoney writes the optimistic transaction of a new expense'},
        define: (Root, id, title, realUsage) =>
            defineScenario({
                id,
                title,
                realUsage,
                scale: listScale,
                measure: LIST_MEASURE,
                setup: () => setupMountedList(Root),
                beforeEach: bumpRevision,
                run: async () => {
                    const added: Transaction = {...createListTransaction(LIST_ROWS), transactionID: ADDED_TRANSACTION_ID};
                    await writeAndSettle(() => Onyx.set(toTransactionKey(ADDED_TRANSACTION_ID), added));

                    return {renders: getRenderCount()};
                },
                afterEach: async () => {
                    await writeAndSettle(() => Onyx.set(toTransactionKey(ADDED_TRANSACTION_ID), null));
                },
                teardown: unmountList,
            }),
    },
    {
        name: 'remove',
        title: 'the expense in the middle of the list is deleted',
        usage: {file: 'src/libs/actions/IOU/DeleteMoneyRequest.ts', line: 775, note: 'deleteMoneyRequest removes the transaction key of a deleted expense'},
        define: (Root, id, title, realUsage) =>
            defineScenario({
                id,
                title,
                realUsage,
                scale: listScale,
                measure: LIST_MEASURE,
                setup: () => setupMountedList(Root),
                beforeEach: bumpRevision,
                run: async (context) => {
                    await writeAndSettle(() => Onyx.set(context.fixture.keys[REMOVED_ROW_INDEX], null));

                    return {renders: getRenderCount()};
                },
                afterEach: async (context) => {
                    const key = context.fixture.keys[REMOVED_ROW_INDEX];
                    await writeAndSettle(() => Onyx.set(key, context.fixture.transactions[key] ?? null));
                },
                teardown: unmountList,
            }),
    },
];

const PATTERNS: ListPattern[] = ['root-all', 'root-all-memo', 'root-ids', 'root-ids-memo', 'root-fresh-items'];

const ROW_WEIGHTS: RowWeight[] = ['light', 'heavy'];

const GROUP_BY_WEIGHT: Record<RowWeight, string> = {light: 'expense-list', heavy: 'expense-list-heavy-row'};

const scenarios = ROW_WEIGHTS.flatMap((weight) =>
    OPERATIONS.flatMap((operation) =>
        PATTERNS.map((pattern) =>
            operation.define(
                createListRoot(pattern, ROW_CONTENT[weight]),
                `hooks/${GROUP_BY_WEIGHT[weight]}/${pattern}/${operation.name}`,
                `${operation.title}, with the ${pattern} list of ${weight} rows over N background transactions`,
                [PATTERN_USAGE[pattern], operation.usage],
            ),
        ),
    ),
);

runScenarios(scenarios);
