import { h } from '../../snabbdom-setup.js';
export function LibraryLocations(props) {
    const { roots, expandedFolders, onPathChange, onToggle, onFolderContextMenu, onAnnotationSave, onCancelTask, scanResults, isIndexing, isScanning, isCancelling, currentScanPath, onFindNew, onIndexFiles, onCancelImport, onScanPathChange } = props;
    return h('div.lib-pane', {
        style: { display: 'flex', flexDirection: 'column', gap: '2em', height: '100%', overflowY: 'auto', padding: '1em' }
    }, [
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
            h('h3', { style: { marginTop: '0', color: 'var(--text-bright)' } }, 'Index Locations'),
            h('div.folder-list-container', {
                style: {
                    border: '1px solid var(--border-main)', borderRadius: '4px',
                    background: 'var(--bg-panel-alt)', maxHeight: '300px', minHeight: '100px',
                    overflowY: 'auto'
                }
            }, roots && roots.length > 0 ? renderHierarchicalFolderList(roots, expandedFolders, onPathChange, onToggle, onFolderContextMenu, onAnnotationSave, onCancelTask) : [])
        ]),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
            h('h3', { style: { marginTop: '0', color: 'var(--text-bright)' } }, 'Find New Images'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
                h('div', { style: { display: 'flex', gap: '0.5em' } }, [
                    h('input#scan-path-input', {
                        key: 'scan-input',
                        attrs: { type: 'text', placeholder: 'Path to scan...', value: currentScanPath },
                        props: { value: currentScanPath },
                        hook: {
                            insert: (vnode) => {
                                vnode.elm.value = currentScanPath;
                            },
                            update: (old, vnode) => {
                                const $el = vnode.elm;
                                if ($el.value !== currentScanPath) {
                                    $el.value = currentScanPath;
                                }
                            }
                        },
                        style: { flex: '1', background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.8em', borderRadius: '4px', minWidth: '0' },
                        on: { input: (e) => onScanPathChange(e.target.value) }
                    }),
                    h('button', {
                        style: { padding: '0 2.5em', background: 'var(--bg-active)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' },
                        on: { click: () => onFindNew(currentScanPath, 1000) }
                    }, 'FIND NEW')
                ]),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '1em', fontSize: '0.95em', color: 'var(--text-muted)' } }, [
                    h('span', 'Limit:'),
                    h('select#scan-limit-select', {
                        style: { background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '4px 8px', borderRadius: '4px' }
                    }, [
                        h('option', { attrs: { value: '100' } }, '100'),
                        h('option', { attrs: { value: '500' } }, '500'),
                        h('option', { attrs: { value: '1000', selected: true } }, '1000'),
                        h('option', { attrs: { value: '5000' } }, '5000')
                    ])
                ])
            ])
        ]),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
            h('h3', { style: { marginTop: '0', color: 'var(--text-bright)' } }, 'Found Unindexed Images'),
            h('div', {
                style: {
                    border: '1px solid var(--border-main)', borderRadius: '4px',
                    background: 'var(--bg-panel-alt)', minHeight: '100px', maxHeight: '10em',
                    overflowY: 'auto', position: 'relative'
                }
            }, [
                isScanning ? h('div', {
                    style: {
                        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
                        background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        zIndex: '10'
                    }
                }, [
                    h('div.spinner', { style: { width: '2em', height: '2em', border: '3px solid rgba(255,255,255,0.3)', borderTopColor: '#fff' } })
                ]) : null,
                scanResults.length === 0
                    ? h('div', { style: { padding: '3em', color: 'var(--text-muted)', textAlign: 'center' } }, 'No new files found.')
                    : renderScanTable(scanResults)
            ]),
            renderImportControls(isIndexing, isCancelling, scanResults, currentScanPath, onIndexFiles, onCancelImport)
        ])
    ]);
}
function renderHierarchicalFolderList(roots, expanded, onPathChange, onToggle, onFolderContextMenu, onAnnotationSave, onCancelTask) {
    const contrastColor = (hexcolor) => {
        const hex = hexcolor.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        return (yiq >= 128) ? '#000000' : '#ffffff';
    };
    const renderNode = (node, depth) => {
        const indent = depth * 1.5 + 'em';
        const isExpanded = expanded.has(node.id);
        const hasChildren = node.children && node.children.length > 0;
        return h('div', [
            h('div.folder-row', {
                key: node.id,
                style: {
                    padding: `0.4em 1em 0.4em ${indent}`,
                    borderBottom: '1px solid var(--border-dim)',
                    cursor: 'pointer',
                    fontSize: '0.9em',
                    display: 'flex',
                    alignItems: 'center',
                    position: 'relative'
                },
                on: {
                    click: () => onPathChange(node.path),
                    contextmenu: (e) => { e.preventDefault(); onFolderContextMenu(e, node.id); }
                }
            }, [
                h('span.tree-item-prefix', { style: { position: 'static', width: 'auto', marginRight: '0.5em', display: 'flex', alignItems: 'center' } }, [
                    h('span.annotation-icon', {
                        style: { position: 'static', transform: 'none', marginRight: '0.3em' },
                        props: { innerHTML: '&#128172;' },
                        on: { click: (e) => {
                                e.stopPropagation();
                                const pill = e.currentTarget.nextElementSibling;
                                if (pill) {
                                    pill.classList.add('has-content');
                                    pill.focus();
                                }
                            } }
                    }),
                    h('span.annotation-pill', {
                        class: { 'has-content': !!node.annotation },
                        style: node.color ? { backgroundColor: node.color, color: contrastColor(node.color), position: 'static', transform: 'none', marginRight: '0.5em' } : { position: 'static', transform: 'none', marginRight: '0.5em' },
                        attrs: { contenteditable: 'true' },
                        props: { textContent: node.annotation || '' },
                        on: {
                            blur: (e) => {
                                const val = e.target.textContent.trim().split(/\s+/).slice(0, 3).join(' ');
                                onAnnotationSave(node.id, val);
                            },
                            keydown: (e) => { if (e.key === 'Enter') {
                                e.preventDefault();
                                e.target.blur();
                            } },
                            click: (e) => e.stopPropagation(),
                            contextmenu: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const input = document.createElement('input');
                                input.type = 'color';
                                input.value = node.color || '#00bcd4';
                                input.onchange = () => onAnnotationSave(node.id, node.annotation || '', input.value);
                                input.click();
                            }
                        }
                    }),
                    h('span', {
                        style: { width: '1em', display: 'inline-block', textAlign: 'center', cursor: 'pointer', color: 'var(--text-muted)' },
                        on: { click: (e) => { e.stopPropagation(); onToggle(node.id); } }
                    }, hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : ''),
                ]),
                h('span', { style: { marginRight: '0.5em', color: 'var(--accent)' } }, '\uD83D\uDCC1'),
                h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, attrs: { title: node.name } }, node.name),
                h('span', { style: { color: 'var(--text-muted)', fontSize: '0.85em' } }, node.imageCount.toString())
            ]),
            h('div', { style: { display: isExpanded ? 'block' : 'none' } }, hasChildren ? node.children.map((c) => renderNode(c, depth + 1)) : [])
        ]);
    };
    return h('div', roots.map(r => renderNode(r, 1)));
}
function renderScanTable(results) {
    return h('table', { style: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: '0.9em', fontFamily: 'monospace' } }, [
        h('thead', { style: { position: 'sticky', top: '0', background: 'var(--bg-input)', color: 'var(--text-bright)', zIndex: '1' } }, [
            h('tr', [
                h('th', { style: { textAlign: 'left', padding: '1em' } }, 'File Path'),
                h('th', { style: { textAlign: 'right', padding: '1em', width: '100px' } }, 'Status')
            ])
        ]),
        h('tbody', results.map((r, i) => h('tr', { key: 'scan-' + i, style: { borderBottom: '1px solid var(--border-dim)' } }, [
            h('td', { style: { padding: '0.5em 1em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, attrs: { title: r.path } }, r.path),
            h('td', { style: { padding: '0.5em 1em', textAlign: 'right', color: r.status === 'indexed' ? 'var(--accent)' : 'var(--text-muted)' } }, r.status.toUpperCase())
        ])))
    ]);
}
function renderImportControls(isIndexing, isCancelling, results, currentPath, onIndex, onCancel) {
    if (isIndexing) {
        const indexed = results.filter((r) => r.status === 'indexed').length;
        const total = results.length;
        const percent = total > 0 ? (indexed / total) * 100 : 0;
        return h('div', { style: { paddingTop: '2em', borderTop: '1px solid var(--border-main)' } }, [
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1em' } }, [
                h('span', isCancelling ? 'Cancelling...' : 'Indexing Photos...'),
                h('div', [
                    h('span', `${indexed} / ${total}`),
                    h('button', {
                        style: { marginLeft: '1em', padding: '2px 10px', background: isCancelling ? '#555' : '#8b0000', color: 'white', border: 'none', borderRadius: '4px', cursor: isCancelling ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px' },
                        on: { click: isCancelling ? (() => { }) : onCancel },
                        attrs: { disabled: isCancelling }
                    }, [
                        isCancelling ? h('span.spinner', { style: { width: '0.8em', height: '0.8em', borderWidth: '2px' } }) : null,
                        'CANCEL'
                    ])
                ])
            ]),
            h('div', { style: { width: '100%', height: '1.5em', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-light)' } }, [
                h('div.barber-pole', { style: { width: `${percent}%`, height: '100%', backgroundColor: 'var(--accent)', transition: 'width 0.3s ease' } })
            ])
        ]);
    }
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '2em', paddingTop: '2em', borderTop: '1px solid var(--border-main)', flexWrap: 'wrap' } }, [
        h('div', { style: { display: 'flex', gap: '1.5em' } }, [
            h('label', [h('input#gen-low-check', { attrs: { type: 'checkbox' }, props: { checked: true } }), ' Low Previews']),
            h('label', [h('input#gen-med-check', { attrs: { type: 'checkbox' }, props: { checked: true } }), ' Medium Previews'])
        ]),
        h('button', {
            style: { flex: '1', padding: '1em', background: 'var(--accent)', color: 'var(--text-bright)', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' },
            on: { click: () => {
                    const low = document.getElementById('gen-low-check').checked;
                    const med = document.getElementById('gen-med-check').checked;
                    onIndex(currentPath, low, med);
                } }
        }, 'INDEX FOUND FILES')
    ]);
}
