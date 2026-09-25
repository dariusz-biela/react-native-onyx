import type {Transaction} from '@app/types';

import {Text, View} from 'react-native';
import type {ComponentType} from 'react';
import {createContext, useContext} from 'react';

/**
 * The content one expense row renders, in two weights. `light` is three texts, so a row render costs close to
 * nothing and the list rows measure what Onyx and React bookkeeping cost. `heavy` follows the cells of
 * TransactionItemRowWide (receipt, type, date, merchant, category, tag, total, comments): each cell is its own
 * component, reads a styles context the way `useThemeStyles` does and derives its text (formatted date and amount),
 * so a row render costs about what a real row pays for its own tree.
 */
type ExpenseRowContentProps = {transaction: Transaction | undefined};

type RowWeight = 'light' | 'heavy';

type RowStyles = {cell: {padding: number}; label: {fontSize: number}; mutedLabel: {fontSize: number; opacity: number}};

const RowStylesContext = createContext<RowStyles>({cell: {padding: 8}, label: {fontSize: 13}, mutedLabel: {fontSize: 11, opacity: 0.6}});

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', year: 'numeric'});

const amountFormats = new Map<string, Intl.NumberFormat>();

function formatAmount(amountInCents: number, currency: string): string {
    let format = amountFormats.get(currency);
    if (!format) {
        format = new Intl.NumberFormat('en-US', {style: 'currency', currency});
        amountFormats.set(currency, format);
    }

    return format.format(Math.abs(amountInCents) / 100);
}

function formatCreated(created: string): string {
    return DATE_FORMAT.format(new Date(created.replace(' ', 'T')));
}

function Cell({label, detail}: {label: string; detail?: string}) {
    const styles = useContext(RowStylesContext);

    return (
        <View style={styles.cell}>
            <Text style={styles.label}>{label}</Text>
            {!!detail && <Text style={styles.mutedLabel}>{detail}</Text>}
        </View>
    );
}

function ReceiptCell({transaction}: ExpenseRowContentProps) {
    const styles = useContext(RowStylesContext);
    const filename = transaction?.receipt?.filename;

    return (
        <View style={styles.cell}>
            <View style={styles.cell} />
            <Text style={styles.mutedLabel}>{filename ? `Receipt ${filename}` : 'No receipt'}</Text>
        </View>
    );
}

function TypeCell({transaction}: ExpenseRowContentProps) {
    return <Cell label={transaction?.cardName ? 'Card' : 'Cash'} />;
}

function DateCell({transaction}: ExpenseRowContentProps) {
    return <Cell label={transaction?.created ? formatCreated(transaction.created) : ''} />;
}

function MerchantCell({transaction}: ExpenseRowContentProps) {
    return (
        <Cell
            label={transaction?.merchant ?? ''}
            detail={transaction?.comment?.comment?.trim()}
        />
    );
}

function CategoryCell({transaction}: ExpenseRowContentProps) {
    return <Cell label={transaction?.category ?? 'Uncategorized'} />;
}

function TagCell({transaction}: ExpenseRowContentProps) {
    return <Cell label={transaction?.tag?.split(':').join(', ') ?? ''} />;
}

function TotalCell({transaction}: ExpenseRowContentProps) {
    const currency = transaction?.currency ?? 'USD';

    return (
        <Cell
            label={formatAmount(transaction?.amount ?? 0, currency)}
            detail={currency}
        />
    );
}

function CommentsCell({transaction}: ExpenseRowContentProps) {
    const styles = useContext(RowStylesContext);

    return (
        <View style={styles.cell}>
            <View style={styles.cell} />
            <Text style={styles.mutedLabel}>{transaction?.transactionID}</Text>
        </View>
    );
}

function LightExpenseRowContent({transaction}: ExpenseRowContentProps) {
    return (
        <View>
            <Text>{transaction?.merchant}</Text>
            <Text>{transaction?.amount}</Text>
            <Text>{transaction?.created}</Text>
        </View>
    );
}

function HeavyExpenseRowContent({transaction}: ExpenseRowContentProps) {
    const styles = useContext(RowStylesContext);

    return (
        <View style={styles.cell}>
            <View style={styles.cell} />
            <ReceiptCell transaction={transaction} />
            <TypeCell transaction={transaction} />
            <DateCell transaction={transaction} />
            <MerchantCell transaction={transaction} />
            <CategoryCell transaction={transaction} />
            <TagCell transaction={transaction} />
            <TotalCell transaction={transaction} />
            <CommentsCell transaction={transaction} />
        </View>
    );
}

const ROW_CONTENT: Record<RowWeight, ComponentType<ExpenseRowContentProps>> = {light: LightExpenseRowContent, heavy: HeavyExpenseRowContent};

export {ROW_CONTENT};
export type {ExpenseRowContentProps, RowWeight};
