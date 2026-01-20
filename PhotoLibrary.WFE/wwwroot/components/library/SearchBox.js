import { h } from '../../snabbdom-setup.js';
export function SearchBox(props) {
    return h('div.search-box', { style: { position: 'relative' } }, [
        h('input.search-input', {
            attrs: { type: 'text', placeholder: 'Search (path:xxx, tag:xxx, size>2mb)...' },
            props: { value: props.query },
            on: {
                keydown: (e) => {
                    if (e.key === 'Enter') {
                        props.onSearch(e.target.value);
                    }
                },
                click: (e) => {
                    e.stopPropagation();
                    props.onInputClick();
                }
            }
        }),
        h('div', { style: { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: '8px', alignItems: 'center' } }, [
            props.query ? h('span.search-pin', {
                style: {
                    cursor: 'pointer', color: props.isPinned ? 'var(--accent)' : 'var(--text-muted)', fontSize: '1.1em'
                },
                attrs: { title: props.isPinned ? 'Unpin search' : 'Pin search' },
                on: { click: (e) => {
                        e.stopPropagation();
                        props.onTogglePin();
                    } }
            }, props.isPinned ? '\uD83D\uDCCC' : '\uD83D\uDCCD') : null,
            props.query ? h('span.search-clear', {
                style: {
                    cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.2em'
                },
                on: { click: (e) => {
                        e.stopPropagation();
                        props.onSearch('');
                    } }
            }, '\u00D7') : null,
        ]),
        h('div.search-loading'),
        h('div.query-builder', { class: { active: props.showQueryBuilder } }, [
            h('div.query-row', [
                h('span', 'Path:'),
                h('input', { attrs: { type: 'text', id: 'qb-path', placeholder: 'segment...' } }),
                h('span.query-add-btn', { on: { click: () => {
                            const val = document.getElementById('qb-path').value;
                            if (val)
                                props.onSearch(appendSegment(props.query, `path:${val}`));
                        } } }, '+')
            ]),
            h('div.query-row', [
                h('span', 'Tag:'),
                h('input', { attrs: { type: 'text', id: 'qb-tag', placeholder: 'Name [= Value]' } }),
                h('span.query-add-btn', { on: { click: () => {
                            const val = document.getElementById('qb-tag').value;
                            if (val)
                                props.onSearch(appendSegment(props.query, `tag:${val}`));
                        } } }, '+')
            ]),
            h('div.query-row', [
                h('span', 'Size:'),
                h('select', { attrs: { id: 'qb-size-op' } }, [h('option', '>'), h('option', '<')]),
                h('input', { attrs: { type: 'text', id: 'qb-size-val', placeholder: '2mb' } }),
                h('span.query-add-btn', { on: { click: () => {
                            const op = document.getElementById('qb-size-op').value;
                            const val = document.getElementById('qb-size-val').value;
                            if (val)
                                props.onSearch(appendSegment(props.query, `size ${op} ${val}`));
                        } } }, '+')
            ]),
            h('div.query-help', 'Click + to add to search. Press Enter to search.')
        ])
    ]);
}
function appendSegment(current, segment) {
    const trimmed = current.trim();
    return trimmed ? `${trimmed} ${segment}` : segment;
}
