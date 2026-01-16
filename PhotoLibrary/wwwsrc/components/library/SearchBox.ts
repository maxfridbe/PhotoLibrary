import { h, VNode } from '../../snabbdom-setup.js';

export interface SearchBoxProps {
    query: string;
    onSearch: (query: string) => void;
    onInputClick: () => void;
    showQueryBuilder: boolean;
}

export function SearchBox(props: SearchBoxProps): VNode {
    return h('div.search-box', { style: { position: 'relative' } }, [
        h('input.search-input', {
            attrs: { type: 'text', placeholder: 'Search (path:xxx, tag:xxx, size>2mb)...' },
            props: { value: props.query },
            on: {
                keydown: (e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                        props.onSearch((e.target as HTMLInputElement).value);
                    }
                },
                click: (e: MouseEvent) => {
                    e.stopPropagation();
                    props.onInputClick();
                }
            }
        }),
        props.query ? h('span.search-clear', {
            style: {
                position: 'absolute', right: '25px', top: '50%', transform: 'translateY(-50%)',
                cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.2em'
            },
            on: { click: (e: MouseEvent) => { 
                e.stopPropagation(); 
                props.onSearch(''); 
            } }
        }, '\u00D7') : null,
        h('div.search-loading'),
        h('div.query-builder', { class: { active: props.showQueryBuilder } }, [
            h('div.query-row', [
                h('span', 'Path:'),
                h('input', { attrs: { type: 'text', id: 'qb-path', placeholder: 'segment...' } }),
                h('span.query-add-btn', { on: { click: () => {
                    const val = (document.getElementById('qb-path') as HTMLInputElement).value;
                    if (val) props.onSearch(appendSegment(props.query, `path:${val}`));
                } } }, '+')
            ]),
            h('div.query-row', [
                h('span', 'Tag:'),
                h('input', { attrs: { type: 'text', id: 'qb-tag', placeholder: 'Name [= Value]' } }),
                h('span.query-add-btn', { on: { click: () => {
                    const val = (document.getElementById('qb-tag') as HTMLInputElement).value;
                    if (val) props.onSearch(appendSegment(props.query, `tag:${val}`));
                } } }, '+')
            ]),
            h('div.query-row', [
                h('span', 'Size:'),
                h('select', { attrs: { id: 'qb-size-op' } }, [h('option', '>'), h('option', '<')]),
                h('input', { attrs: { type: 'text', id: 'qb-size-val', placeholder: '2mb' } }),
                h('span.query-add-btn', { on: { click: () => {
                    const op = (document.getElementById('qb-size-op') as HTMLSelectElement).value;
                    const val = (document.getElementById('qb-size-val') as HTMLInputElement).value;
                    if (val) props.onSearch(appendSegment(props.query, `size ${op} ${val}`));
                } } }, '+')
            ]),
            h('div.query-help', 'Click + to add to search. Press Enter to search.')
        ])
    ]);
}

function appendSegment(current: string, segment: string): string {
    const trimmed = current.trim();
    return trimmed ? `${trimmed} ${segment}` : segment;
}
