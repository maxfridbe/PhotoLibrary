/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';

export interface SearchBoxProps {
    query: string;
    isPinned: boolean;
    onSearch: (query: string) => void;
    onTogglePin: () => void;
    onInputClick: () => void;
    showQueryBuilder: boolean;
}

export function SearchBox(props: SearchBoxProps): VNode {
    return (
        <div class={{ 'search-box': true }} style={{ position: 'relative' }}>
            <input 
                class={{ 'search-input': true }}
                attrs={{ type: 'text', placeholder: 'Search (path:xxx, tag:xxx, size>2mb)...' }}
                props={{ value: props.query }}
                on={{
                    keydown: (e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                            props.onSearch((e.target as HTMLInputElement).value);
                        }
                    },
                    click: (e: MouseEvent) => {
                        e.stopPropagation();
                        props.onInputClick();
                    }
                }}
            />
            <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                {props.query ? (
                    <span 
                        class={{ 'search-pin': true }}
                        style={{
                            cursor: 'pointer', color: props.isPinned ? 'var(--accent)' : 'var(--text-muted)', fontSize: '1.1em'
                        }}
                        attrs={{ title: props.isPinned ? 'Unpin search' : 'Pin search' }}
                        on={{ click: (e: MouseEvent) => { 
                            e.stopPropagation(); 
                            props.onTogglePin(); 
                        } }}
                    >
                        {props.isPinned ? '\uD83D\uDCCC' : '\uD83D\uDCCD'}
                    </span>
                ) : null}
                {props.query ? (
                    <span 
                        class={{ 'search-clear': true }}
                        style={{
                            cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.2em'
                        }}
                        on={{ click: (e: MouseEvent) => { 
                            e.stopPropagation(); 
                            props.onSearch(''); 
                        } }}
                    >
                        {'\u00D7'}
                    </span>
                ) : null}
            </div>
            <div class={{ 'search-loading': true }} />
            <div class={{ 'query-builder': true, active: props.showQueryBuilder }}>
                <div class={{ 'query-row': true }}>
                    <span>Path:</span>
                    <input attrs={{ type: 'text', id: 'qb-path', placeholder: 'segment...' }} />
                    <span 
                        class={{ 'query-add-btn': true }}
                        on={{ click: () => {
                            const $el = (document.getElementById('qb-path') as HTMLInputElement);
                            if ($el.value) {
                                props.onSearch(appendSegment(props.query, `path:${$el.value}`));
                                $el.value = '';
                            }
                        } }}
                    >
                        +
                    </span>
                </div>
                <div class={{ 'query-row': true }}>
                    <span>Tag:</span>
                    <input attrs={{ type: 'text', id: 'qb-tag', placeholder: 'Name [= Value]' }} />
                    <span 
                        class={{ 'query-add-btn': true }}
                        on={{ click: () => {
                            const $el = (document.getElementById('qb-tag') as HTMLInputElement);
                            if ($el.value) {
                                props.onSearch(appendSegment(props.query, `tag:${$el.value}`));
                                $el.value = '';
                            }
                        } }}
                    >
                        +
                    </span>
                </div>
                <div class={{ 'query-row': true }}>
                    <span>Size:</span>
                    <select attrs={{ id: 'qb-size-op' }}>
                        <option>{'>'}</option>
                        <option>{'<'}</option>
                    </select>
                    <input attrs={{ type: 'text', id: 'qb-size-val', placeholder: '2mb' }} />
                    <span 
                        class={{ 'query-add-btn': true }}
                        on={{ click: () => {
                            const op = (document.getElementById('qb-size-op') as HTMLSelectElement).value;
                            const $el = (document.getElementById('qb-size-val') as HTMLInputElement);
                            if ($el.value) {
                                props.onSearch(appendSegment(props.query, `size ${op} ${$el.value}`));
                                $el.value = '';
                            }
                        } }}
                    >
                        +
                    </span>
                </div>
                <div class={{ 'query-help': true }}>Click + to add to search. Press Enter to search.</div>
            </div>
        </div>
    );
}

function appendSegment(current: string, segment: string): string {
    const trimmed = current.trim();
    return trimmed ? `${trimmed} ${segment}` : segment;
}
