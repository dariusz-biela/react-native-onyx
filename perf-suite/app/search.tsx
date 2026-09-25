/**
 * The three search contexts the App's `useOnyx` wrapper reads (`src/components/Search/SearchContextDefinitions.ts`
 * and `SearchScopeProvider.tsx`), reduced to the fields the wrapper looks at and the App's default values.
 */
import type {ReactNode} from 'react';

import React, {createContext, useContext} from 'react';

type SearchQueryContextValue = {
    currentSearchHash: number;
};

type SearchResultsContextValue = {
    shouldUseLiveData: boolean;
};

type SearchScopeContextValue = {
    isOnSearch: boolean;
};

const SearchQueryContext = createContext<SearchQueryContextValue>({currentSearchHash: -1});

const SearchResultsContext = createContext<SearchResultsContextValue>({shouldUseLiveData: false});

const SearchScopeContext = createContext<SearchScopeContextValue>({isOnSearch: false});

type SearchScopeProviderProps = {
    children: ReactNode;
    isOnSearch?: boolean;
};

function SearchScopeProvider({children, isOnSearch = true}: SearchScopeProviderProps) {
    const searchContext = {isOnSearch};

    return <SearchScopeContext.Provider value={searchContext}>{children}</SearchScopeContext.Provider>;
}

function useIsOnSearch(): boolean {
    const {isOnSearch} = useContext(SearchScopeContext);
    return isOnSearch;
}

export {SearchQueryContext, SearchResultsContext, SearchScopeProvider, useIsOnSearch};
export type {SearchQueryContextValue, SearchResultsContextValue};
