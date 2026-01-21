import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';
import { SearchBox } from './SearchBox.js';
import { TreeItem } from '../common/TreeItem.js';
import { FolderTree } from './FolderTree.js';
import { CollectionIcon } from '../../icons.js';
import { SavedSearch } from '../../app.js';

export interface LibrarySidebarProps {
    stats: Res.StatsResponse;
    roots: Res.DirectoryNodeResponse[];
    userCollections: Res.CollectionResponse[];
    savedSearches: SavedSearch[];
    
    filterType: 'all' | 'picked' | 'rating' | 'search' | 'collection';
    filterRating: number;
    selectedRootId: string | null;
    selectedCollectionId: string | null;
    selectedSavedSearchId: string | null;
    searchTitle: string;
    searchResultCount: number;
    
    expandedFolders: Set<string>;
    folderProgress: Map<string, { processed: number, total: number, thumbnailed?: number }>;
    showQueryBuilder: boolean;
    isSearchPinned: boolean;

    onFilterChange: (type: any, rating?: number, rootId?: string | null) => void;
    onCollectionFilterChange: (c: Res.CollectionResponse) => void;
    onSavedSearchFilterChange: (s: SavedSearch) => void;
    onSearch: (query: string) => void;
    onTogglePinSearch: () => void;
    onInputClick: () => void;
    
    onFolderToggle: (rootId: string, expanded: boolean) => void;
    onFolderContextMenu: (e: MouseEvent, rootId: string) => void;
    onPhotoContextMenu: (e: MouseEvent, p: any) => void; // not used here but maybe
    onPickedContextMenu: (e: MouseEvent) => void;
    onCollectionContextMenu: (e: MouseEvent, c: Res.CollectionResponse) => void;
    onSavedSearchContextMenu: (e: MouseEvent, s: SavedSearch) => void;
    onAnnotationSave: (rootId: string, annotation: string, color?: string) => void;
    onCancelTask: (rootId: string) => void;
}

export function LibrarySidebar(props: LibrarySidebarProps): VNode {
    const createSection = (title: string) => h('div.tree-section-header', title);

    const collectionItems = props.userCollections.map(c => TreeItem({
        text: c.name,
        count: c.count,
        isSelected: props.selectedCollectionId === c.collectionId,
        typeAttr: 'collection-' + c.collectionId,
        onClick: () => props.onCollectionFilterChange(c),
        onContextMenu: (e) => props.onCollectionContextMenu(e, c),
        icon: CollectionIcon
    }));

    const savedSearchItems = props.savedSearches.map(s => TreeItem({
        text: s.title,
        isSelected: props.selectedSavedSearchId === s.savedSearchId,
        typeAttr: 'saved-search-' + s.savedSearchId,
        onClick: () => props.onSavedSearchFilterChange(s),
        onContextMenu: (e) => props.onSavedSearchContextMenu(e, s),
        icon: '\uD83D\uDCCD'
    }));

    const ratingItems = [];
    for (let i = 5; i >= 1; i--) {
        ratingItems.push(TreeItem({
            text: '\u2605'.repeat(i),
            count: props.stats.ratingCounts[i-1],
            isSelected: props.filterType === 'rating' && props.filterRating === i,
            typeAttr: 'rating-' + i,
            onClick: () => props.onFilterChange('rating', i)
        }));
    }

    return h('div.tree-view', [
        createSection('Search'),
        SearchBox({
            query: props.filterType === 'search' ? (props.searchTitle.startsWith('Query: ') ? props.searchTitle.substring(7) : props.searchTitle) : '',
            isPinned: props.isSearchPinned,
            onSearch: props.onSearch,
            onTogglePin: props.onTogglePinSearch,
            onInputClick: props.onInputClick,
            showQueryBuilder: props.showQueryBuilder
        }),
        props.filterType === 'search' ? TreeItem({
            text: props.searchTitle,
            count: props.searchResultCount,
            isSelected: !props.selectedSavedSearchId,
            typeAttr: 'search',
            onClick: () => props.onFilterChange('search')
        }) : null,
        
        props.savedSearches.length > 0 ? createSection('Saved Searches') : null,
        ...savedSearchItems,

        createSection('Collections'),
        TreeItem({
            text: 'All Photos',
            count: props.stats.totalCount,
            isSelected: props.filterType === 'all' && !props.selectedRootId,
            typeAttr: 'all',
            onClick: () => props.onFilterChange('all')
        }),
        TreeItem({
            text: 'Picked',
            count: props.stats.pickedCount,
            isSelected: props.filterType === 'picked',
            typeAttr: 'picked',
            onClick: () => props.onFilterChange('picked'),
            onContextMenu: (e) => props.onPickedContextMenu(e),
            icon: '\u2691'
        }),
        ...collectionItems,
        ...ratingItems,

        createSection('Folders'),
        FolderTree({
            roots: props.roots,
            selectedRootId: props.selectedRootId,
            expandedFolders: props.expandedFolders,
            folderProgress: props.folderProgress,
            onFolderClick: (id) => props.onFilterChange('all', 0, id),
            onFolderToggle: props.onFolderToggle,
            onFolderContextMenu: props.onFolderContextMenu,
            onAnnotationSave: props.onAnnotationSave,
            onCancelTask: props.onCancelTask
        })
    ]);
}
