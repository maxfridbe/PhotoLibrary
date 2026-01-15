import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';

export interface LibraryScreenProps {
    containerId: string;
    info: Res.LibraryInfoResponse | null;
    scanResults: { path: string, status: 'pending' | 'indexed' }[];
    isIndexing: boolean;
    isScanning: boolean;
    isCancelling: boolean;
    currentScanPath: string;
    onFindNew: (path: string, limit: number) => void;
    onIndexFiles: (path: string, low: boolean, med: boolean) => void;
    onCancelImport: () => void;
    onPathChange: (path: string) => void;
}

export function LibraryScreen(props: LibraryScreenProps): VNode {
    try {
        const { containerId, info, scanResults, isIndexing, isScanning, isCancelling, currentScanPath, onFindNew, onIndexFiles, onCancelImport, onPathChange } = props;

        return h('div.library-screen-container', {
            attrs: { id: containerId },
            style: { display: 'flex', height: '100%', width: '100%', gap: '1.5em', padding: '1.5em', boxSizing: 'border-box', background: 'var(--bg-main)', overflow: 'hidden' }
        }, [
            // Left Column: Stats
            h('div.lib-pane', { 
                style: { flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: '1.5em', overflowY: 'auto', boxSizing: 'border-box', height: '100%' } 
            }, [
                h('h3', { style: { marginTop: '0', color: 'var(--text-bright)' } }, 'Library Statistics'),
                info ? renderStats(info) : h('div', 'Loading statistics...')
            ]),

            // Right Column: One big scrollable area
            h('div#lib-right-column', { 
                style: { flex: '1', display: 'flex', flexDirection: 'column', gap: '2em', minWidth: '0', boxSizing: 'border-box', overflowY: 'auto' } 
            }, [
                // Section 1: Find New Files
                h('div.lib-pane', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
                    h('h3', { style: { marginTop: '0', color: 'var(--text-bright)' } }, 'Find New Images'),
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1em' } }, [
                        h('div', { style: { display: 'flex', gap: '0.5em' } }, [
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
                                on: { input: (e: Event) => onPathChange((e.target as HTMLInputElement).value) }
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
                    ]),
                    
                    h('h4', { style: { margin: '1.5em 0 0.5em 0' } }, 'Quick Select: Registered Folders'),
                    h('div.folder-list-container', {
                        style: { 
                            border: '1px solid var(--border-main)', borderRadius: '4px', 
                            background: 'var(--bg-panel-alt)', minHeight: '150px', maxHeight: '350px', 
                            overflowY: 'auto'
                        }
                    }, info ? renderHierarchicalFolderList(info, onPathChange) : [])
                ]),

                // Section 2: Results
                h('div.lib-pane', { style: { display: 'flex', flexDirection: 'column', gap: '1em', paddingBottom: '4em' } }, [
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
            ])
        ]);
    } catch (e) {
        console.error('[LibraryScreen] Render Error', e);
        return h('div', { style: { color: 'red', padding: '1em' } }, 'Render Error (check console)');
    }
}

function renderHierarchicalFolderList(info: Res.LibraryInfoResponse, onPathChange: (path: string) => void) {
    const map = new Map<string, { node: Res.LibraryFolderResponse, children: any[] }>();
    info.folders.forEach(f => map.set(f.id, { node: f, children: [] }));
    const roots: any[] = [];
    info.folders.forEach(f => {
        if (f.parentId && map.has(f.parentId)) map.get(f.parentId)!.children.push(map.get(f.id)!);
        else roots.push(map.get(f.id)!);
    });

    const renderNode = (item: { node: Res.LibraryFolderResponse, children: any[] }, depth: number): VNode => {
        // Derive simple name from path if needed, or use path if it's root
        const name = item.node.path.split(/[/\\]/).pop() || item.node.path;
        const indent = depth * 1.5 + 'em';
        
        return h('div', [
            h('div.folder-row', {
                key: item.node.id,
                style: { 
                    padding: '0.4em 1em 0.4em ' + indent, 
                    borderBottom: '1px solid var(--border-dim)', 
                    cursor: 'pointer', 
                    fontSize: '0.9em',
                    display: 'flex',
                    alignItems: 'center'
                },
                on: { click: (e: MouseEvent) => { e.preventDefault(); onPathChange(item.node.path); } }
            }, [
                h('span', { style: { marginRight: '0.5em', color: 'var(--accent)' } }, '\uD83D\uDCC1'),
                h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, attrs: { title: item.node.path } }, name),
                h('span', { style: { color: 'var(--text-muted)', fontSize: '0.85em' } }, item.node.imageCount.toString())
            ]),
            ...item.children.map(c => renderNode(c, depth + 1))
        ]);
    };

    return h('div', roots.map(r => renderNode(r, 1)));
}

function renderStats(info: Res.LibraryInfoResponse) {
    const item = (label: string, val: string | number, sub?: string) => h('div', { style: { marginBottom: '1.2em' } }, [
        h('div', { style: { color: 'var(--text-muted)', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '0.3em' } }, label),
        h('div', { style: { wordBreak: 'break-all', fontSize: '0.95em', color: 'var(--text-bright)' } }, val.toString()),
        sub ? h('div', { style: { textAlign: 'right', color: 'var(--accent)', fontSize: '0.85em', marginTop: '0.3em', fontWeight: 'bold' } }, sub) : null
    ]);

    return h('div', [
        item('Metadata DB', info.dbPath, (info.dbSize / (1024 * 1024)).toFixed(2) + ' MB'),
        item('Preview DB', info.previewDbPath, (info.previewDbSize / (1024 * 1024)).toFixed(2) + ' MB'),
        item('Config', info.configPath),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '1em', borderTop: '1px solid var(--border-dim)', paddingTop: '1em', marginTop: '1.5em' } }, [
            h('div', { style: { color: 'var(--text-muted)' } }, 'Total Images:'),
            h('div', { style: { fontWeight: 'bold' } }, info.totalImages.toLocaleString())
        ]),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '1em' } }, [
            h('div', { style: { color: 'var(--text-muted)' } }, 'Thumbnailed:'),
            h('div', { style: { fontWeight: 'bold' } }, info.totalThumbnailedImages.toLocaleString())
        ])
    ]);
}

function renderScanTable(results: { path: string, status: string }[]) {
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

function renderImportControls(isIndexing: boolean, isCancelling: boolean, results: any[], currentPath: string, onIndex: (p: string, l: boolean, m: boolean) => void, onCancel: () => void) {
    if (isIndexing) {
        const indexed = results.filter(r => r.status === 'indexed').length;
        const total = results.length;
        const percent = total > 0 ? (indexed / total) * 100 : 0;

        return h('div', { style: { paddingTop: '2em', borderTop: '1px solid var(--border-main)' } }, [
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1em' } }, [
                h('span', isCancelling ? 'Cancelling...' : 'Indexing Photos...'),
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
            h('div', { style: { width: '100%', height: '1.5em', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-light)' } }, [
                h('div.barber-pole', { style: { width: `${percent}%`, height: '100%', backgroundColor: 'var(--accent)', transition: 'width 0.3s ease' } })
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