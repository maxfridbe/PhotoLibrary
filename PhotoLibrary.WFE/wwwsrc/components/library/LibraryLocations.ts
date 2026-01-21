import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';

export interface LibraryLocationsProps {
    roots: Res.DirectoryNodeResponse[];
    expandedFolders: Set<string>;
    onPathChange: (path: string) => void;
    onToggle: (id: string) => void;
    onFolderContextMenu: (e: MouseEvent, id: string) => void;
    onAnnotationSave: (id: string, annotation: string, color?: string) => void;
    onCancelTask: (id: string) => void;
    
    // Find & Index Props
    scanResults: { path: string, status: 'pending' | 'indexed', duration?: number }[];
    isIndexing: boolean;
    lastItemDuration: number;
    estimatedRemainingTime: number;
    isScanning: boolean;
    isCancelling: boolean;
    currentScanPath: string;
    onFindNew: (path: string, limit: number) => void;
    onIndexFiles: (path: string, low: boolean, med: boolean) => void;
    onClearResults: () => void;
    onCancelImport: () => void;
    onScanPathChange: (path: string) => void;
}

export function LibraryLocations(props: LibraryLocationsProps): VNode {
    const { roots, expandedFolders, onPathChange, onToggle, onFolderContextMenu, onAnnotationSave, onCancelTask, scanResults, isIndexing, lastItemDuration, estimatedRemainingTime, isScanning, isCancelling, currentScanPath, onFindNew, onIndexFiles, onClearResults, onCancelImport, onScanPathChange } = props;

    return h('div.lib-pane', { 
        style: { display: 'flex', flexDirection: 'column', gap: '2em', height: '100%', overflowY: 'auto', padding: '1em' } 
    }, [
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
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
            h('div', { style: { display: 'flex', gap: '0.5em', alignItems: 'center' } }, [
                h('input#scan-path-input', {
                    key: 'scan-input',
                    attrs: { type: 'text', placeholder: 'Path to scan...', value: currentScanPath },
                    props: { value: currentScanPath },
                    hook: {
                        insert: (vnode) => { 
                            (vnode.elm as HTMLInputElement).value = currentScanPath; 
                        },
                        update: (old, vnode) => { 
                            const $el = vnode.elm as HTMLInputElement;
                            if ($el.value !== currentScanPath) {
                                $el.value = currentScanPath;
                            }
                        }
                    },
                    style: { flex: '1', background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.8em', borderRadius: '4px', minWidth: '0' },
                    on: { input: (e: Event) => onScanPathChange((e.target as HTMLInputElement).value) }
                }),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.9em', color: 'var(--text-muted)', whiteSpace: 'nowrap' } }, [
                    h('span', 'Limit:'),
                    h('select#scan-limit-select', {
                        style: { background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '4px 8px', borderRadius: '4px' }
                    }, [
                        h('option', { attrs: { value: '100' } }, '100'),
                        h('option', { attrs: { value: '500' } }, '500'),
                        h('option', { attrs: { value: '1000', selected: true } }, '1000'),
                        h('option', { attrs: { value: '5000' } }, '5000')
                    ])
                ]),
                h('button', {
                    style: { padding: '0 2.5em', background: isScanning ? '#555' : 'var(--bg-active)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', cursor: isScanning ? 'default' : 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' },
                    attrs: { disabled: isScanning },
                    on: { click: () => !isScanning && onFindNew(currentScanPath, 1000) }
                }, [
                    isScanning ? h('div.spinner', { style: { width: '1em', height: '1em', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff' } }) : null,
                    'FIND NEW'
                ])
            ])
        ]),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
                h('h3', { style: { marginTop: '0', color: 'var(--text-bright)' } }, 'Found Unindexed Images'),
                (scanResults.length > 0 && !isIndexing) ? h('button', {
                    style: { padding: '4px 12px', fontSize: '0.85em', background: 'transparent', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', borderRadius: '4px', cursor: 'pointer' },
                    on: { click: onClearResults }
                }, 'Clear') : null
            ]),
            h('div.scan-results-scroll-container', {
                key: 'scan-results-list',
                style: { 
                    border: '1px solid var(--border-main)', borderRadius: '4px', 
                    background: 'var(--bg-panel-alt)', height: '15em', 
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
                    : renderScanTable(scanResults, isIndexing)
            ]),
            renderImportControls(isIndexing, isCancelling, scanResults, currentScanPath, onIndexFiles, onCancelImport, lastItemDuration, estimatedRemainingTime)
        ])
    ]);
}

function renderHierarchicalFolderList(roots: Res.DirectoryNodeResponse[], expanded: Set<string>, onPathChange: (path: string) => void, onToggle: (id: string) => void, onFolderContextMenu: (e: MouseEvent, id: string) => void, onAnnotationSave: (id: string, annotation: string, color?: string) => void, onCancelTask: (id: string) => void) {
    const contrastColor = (hexcolor: string) => {
        const hex = hexcolor.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        return (yiq >= 128) ? '#000000' : '#ffffff';
    };

    const renderNode = (node: Res.DirectoryNodeResponse, depth: number): VNode => {
        const indent = depth * 1.5 + 'em';
        const isExpanded = expanded.has(node.directoryId);
        const hasChildren = node.children && node.children.length > 0;

        return h('div', [
            h('div.folder-row', {
                key: node.directoryId,
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
                    contextmenu: (e: MouseEvent) => { e.preventDefault(); onFolderContextMenu(e, node.directoryId); }
                }
            }, [
                h('span.tree-item-prefix', { style: { position: 'static', width: 'auto', marginRight: '0.5em', display: 'flex', alignItems: 'center' } }, [
                    h('span.annotation-icon', {
                        style: { position: 'static', transform: 'none', marginRight: '0.3em' },
                        props: { innerHTML: '&#128172;' },
                        on: { click: (e: MouseEvent) => { 
                            e.stopPropagation(); 
                            const pill = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement;
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
                            blur: (e: any) => {
                                const val = e.target.textContent.trim().split(/\s+/).slice(0, 3).join(' ');
                                onAnnotationSave(node.directoryId, val);
                            },
                            keydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } },
                            click: (e: MouseEvent) => e.stopPropagation(),
                            contextmenu: (e: MouseEvent) => {
                                e.preventDefault(); e.stopPropagation();
                                const input = document.createElement('input');
                                input.type = 'color';
                                input.value = node.color || '#00bcd4';
                                input.onchange = () => onAnnotationSave(node.directoryId, node.annotation || '', input.value);
                                input.click();
                            }
                        }
                    }),
                    h('span', {
                        style: { width: '1em', display: 'inline-block', textAlign: 'center', cursor: 'pointer', color: 'var(--text-muted)' },
                        on: { click: (e: MouseEvent) => { e.stopPropagation(); onToggle(node.directoryId); } }
                    }, hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : ''),
                ]),
                h('span', { style: { marginRight: '0.5em', color: 'var(--accent)' } }, '\uD83D\uDCC1'),
                h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, attrs: { title: node.name } }, node.name),
                h('span', { style: { color: 'var(--text-muted)', fontSize: '0.85em' } }, node.imageCount.toString())
            ]),
            h('div', { style: { display: isExpanded ? 'block' : 'none' } }, 
                hasChildren ? node.children.map((c: any) => renderNode(c, depth + 1)) : []
            )
        ]);
    };

    return h('div', roots.map(r => renderNode(r, 1)));
}

function renderScanTable(results: { path: string, status: string, duration?: number }[], isIndexing: boolean) {
    let activeIndex = -1;
    if (isIndexing) {
        for (let i = results.length - 1; i >= 0; i--) {
            if (results[i].status === 'indexed') {
                activeIndex = i;
                break;
            }
        }
        if (activeIndex === -1 && results.length > 0) activeIndex = 0;
    }

    return h('table', { style: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: '0.9em', fontFamily: 'monospace' } }, [
        h('thead', { style: { position: 'sticky', top: '0', background: 'var(--bg-input)', color: 'var(--text-bright)', zIndex: '1' } }, [
            h('tr', [
                h('th', { style: { textAlign: 'left', padding: '1em' } }, 'File Path'),
                h('th', { style: { textAlign: 'right', padding: '1em', width: '80px' } }, 'Duration'),
                h('th', { style: { textAlign: 'right', padding: '1em', width: '100px' } }, 'Status')
            ])
        ]),
        h('tbody', results.map((r, i) => {
            const isActive = i === activeIndex;
            return h('tr', { 
                key: 'scan-' + i, 
                style: { 
                    borderBottom: '1px solid var(--border-dim)',
                    background: isActive ? 'rgba(255, 255, 255, 0.1)' : 'transparent' 
                }
            }, [
                h('td', { style: { padding: '0.5em 1em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isActive ? 'bold' : 'normal' }, attrs: { title: r.path } }, r.path),
                h('td', { style: { padding: '0.5em 1em', textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.9em' } }, r.duration ? (r.duration / 1000).toFixed(2) + 's' : '-'),
                h('td', { style: { padding: '0.5em 1em', textAlign: 'right', color: r.status === 'indexed' ? 'var(--accent)' : 'var(--text-muted)', fontWeight: isActive ? 'bold' : 'normal' } }, r.status.toUpperCase())
            ]);
        }))
    ]);
}

function renderImportControls(isIndexing: boolean, isCancelling: boolean, results: any[], currentPath: string, onIndex: (p: string, l: boolean, m: boolean) => void, onCancel: () => void, lastDuration: number = 0, estimatedTime: number = 0) {
    if (isIndexing) {
        const indexed = results.filter((r: any) => r.status === 'indexed').length;
        const total = results.length;
        const percent = total > 0 ? (indexed / total) * 100 : 0;
        
        const nextItem = results.find((r: any) => r.status === 'pending');
        const nextPath = nextItem ? nextItem.path : '';
        const durText = lastDuration > 0 ? ` (${(lastDuration / 1000).toFixed(1)}s)` : '';
        const estText = estimatedTime > 0 
            ? (estimatedTime > 60000 
                ? ` (${Math.ceil(estimatedTime / 60000)}m est remaining)` 
                : ` (${Math.ceil(estimatedTime / 1000)}s est remaining)`)
            : '';

        return h('div', { style: { paddingTop: '2em', borderTop: '1px solid var(--border-main)' } }, [
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1em' } }, [
                h('span', isCancelling ? 'Cancelling...' : `Indexing Photos...${durText}${estText}`),
                h('div', [
                    h('span', `${indexed} / ${total}`),
                    h('button', {
                        style: { marginLeft: '1em', padding: '2px 10px', background: isCancelling ? '#555' : '#8b0000', color: 'white', border: 'none', borderRadius: '4px', cursor: isCancelling ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px' },
                        on: { click: isCancelling ? (() => {}) : onCancel },
                        attrs: { disabled: isCancelling }
                    }, [
                        isCancelling ? h('span.spinner', { style: { width: '0.8em', height: '0.8em', borderWidth: '2px' } }) : null,
                        'CANCEL'
                    ])
                ])
            ]),
            h('div', { style: { width: '100%', height: '1.5em', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-light)', position: 'relative' } }, [
                h('div.barber-pole', { style: { width: `${percent}%`, height: '100%', backgroundColor: 'var(--accent)', transition: 'width 0.3s ease' } }),
                nextPath ? h('div', { 
                    style: { 
                        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', 
                        display: 'flex', alignItems: 'center', justifyContent: 'center', 
                        color: '#fff', fontSize: '0.85em', textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 5px'
                    } 
                }, `Indexing ${nextPath}`) : null
            ])
        ]);
    }

    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '2em', paddingTop: '2em', borderTop: '1px solid var(--border-main)', flexWrap: 'wrap' } }, [
        h('div', { style: { display: 'flex', gap: '1.5em' } }, [
            h('label', [ h('input#gen-low-check', { attrs: { type: 'checkbox' }, props: { checked: true } }), ' Low Previews' ]),
            h('label', [ h('input#gen-med-check', { attrs: { type: 'checkbox' }, props: { checked: true } }), ' Medium Previews' ])
        ]),
        h('button', {
            style: { flex: '1', padding: '1em', background: 'var(--accent)', color: 'var(--text-bright)', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' },
            on: { click: () => {
                const low = (document.getElementById('gen-low-check') as HTMLInputElement).checked;
                const med = (document.getElementById('gen-med-check') as HTMLInputElement).checked;
                onIndex(currentPath, low, med);
            } }
        }, 'INDEX FOUND FILES')
    ]);
}