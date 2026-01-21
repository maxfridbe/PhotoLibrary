/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';
import { FileSystemBrowser, FSNode } from '../import/FileSystemBrowser.js';

export interface LibraryScreenProps {
    containerId: string;
    info: Res.LibraryInfoResponse | null;
    scanResults: { path: string, status: 'pending' | 'indexed' }[];
    isIndexing: boolean;
    isScanning: boolean;
    isCancelling: boolean;
    currentScanPath: string;
    fsRoots: FSNode[];
    quickSelectRoots: Res.DirectoryNodeResponse[];
    onFsToggle: (node: FSNode) => void;
    onFindNew: (path: string, limit: number) => void;
    onIndexFiles: (path: string, low: boolean, med: boolean) => void;
    onCancelImport: () => void;
    onPathChange: (path: string) => void;
}

export function LibraryScreen(props: LibraryScreenProps): VNode {
    try {
        const { containerId, info, scanResults, isIndexing, isScanning, isCancelling, currentScanPath, fsRoots, quickSelectRoots, onFsToggle, onFindNew, onIndexFiles, onCancelImport, onPathChange } = props;

        return (
            <div 
                class={{ 'library-screen-container': true }}
                attrs={{ id: containerId }}
                style={{ display: 'flex', height: '100%', width: '100%', gap: '1.5em', padding: '1.5em', boxSizing: 'border-box', background: 'var(--bg-main)', overflow: 'hidden' }}
            >
                {/* Left Column: Stats */}
                <div 
                    class={{ 'lib-pane': true }}
                    style={{ flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: '1.5em', overflowY: 'auto', boxSizing: 'border-box', height: '100%' }}
                >
                    {info ? renderStats(info) : <div>Loading statistics...</div>}
                </div>

                {/* Right Column: One big scrollable area */}
                <div 
                    id="lib-right-column"
                    style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2em', minWidth: '0', boxSizing: 'border-box', overflowY: 'auto' }}
                >
                    {/* Section 1: Find New Files */}
                    <div class={{ 'lib-pane': true }} style={{ display: 'flex', flexDirection: 'column', gap: '1em' }}>
                        <h3 style={{ marginTop: '0', color: 'var(--text-bright)' }}>Find New Images</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1em' }}>
                            <div style={{ display: 'flex', gap: '0.5em' }}>
                                <input
                                    id="scan-path-input"
                                    key="scan-input"
                                    type="text"
                                    attrs={{ placeholder: 'Path to scan...' }}
                                    props={{ value: currentScanPath }}
                                    hook={{
                                        insert: (vnode) => { 
                                            (vnode.elm as HTMLInputElement).value = currentScanPath; 
                                        },
                                        update: (old, vnode) => { 
                                            const $el = vnode.elm as HTMLInputElement;
                                            if ($el.value !== currentScanPath) {
                                                $el.value = currentScanPath;
                                            }
                                        }
                                    }}
                                    style={{ flex: '1', background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.8em', borderRadius: '4px', minWidth: '0' }}
                                    on={{ input: (e: Event) => onPathChange((e.target as HTMLInputElement).value) }}
                                />
                                <button
                                    style={{ padding: '0 2.5em', background: 'var(--bg-active)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                    on={{ click: () => onFindNew(currentScanPath, 1000) }}
                                >
                                    FIND NEW
                                </button>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '1em', fontSize: '0.95em', color: 'var(--text-muted)' }}>
                                <span>Limit:</span>
                                <select 
                                    id="scan-limit-select"
                                    style={{ background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '4px 8px', borderRadius: '4px' }}
                                >
                                    <option attrs={{ value: '100' }}>100</option>
                                    <option attrs={{ value: '500' }}>500</option>
                                    <option attrs={{ value: '1000', selected: true }}>1000</option>
                                    <option attrs={{ value: '5000' }}>5000</option>
                                </select>
                            </div>
                        </div>
                        
                        <h4 style={{ margin: '1.5em 0 0.5em 0' }}>Local Directory Browser</h4>
                        <FileSystemBrowser
                            roots={fsRoots}
                            onToggle={onFsToggle}
                            onSelect={onPathChange}
                            selectedPath={currentScanPath}
                        />

                        <h4 style={{ margin: '1.5em 0 0.5em 0' }}>Quick Select: Registered Folders</h4>
                        <div 
                            class={{ 'folder-list-container': true }}
                            style={{ 
                                border: '1px solid var(--border-main)', borderRadius: '4px', 
                                background: 'var(--bg-panel-alt)', minHeight: '150px', maxHeight: '350px', 
                                overflowY: 'auto'
                            }}
                        >
                            {quickSelectRoots && quickSelectRoots.length > 0 ? renderHierarchicalFolderList(quickSelectRoots, onPathChange) : []}
                        </div>
                    </div>

                    {/* Section 2: Results */}
                    <div class={{ 'lib-pane': true }} style={{ display: 'flex', flexDirection: 'column', gap: '1em', paddingBottom: '4em' }}>
                        <h3 style={{ marginTop: '0', color: 'var(--text-bright)' }}>Found Unindexed Images</h3>
                        <div
                            style={{ 
                                border: '1px solid var(--border-main)', borderRadius: '4px', 
                                background: 'var(--bg-panel-alt)', minHeight: '100px', maxHeight: '10em', 
                                overflowY: 'auto', position: 'relative' 
                            }}
                        >
                            {isScanning ? (
                                <div 
                                    style={{ 
                                        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', 
                                        background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        zIndex: '10'
                                    }}
                                >
                                    <div class={{ spinner: true }} style={{ width: '2em', height: '2em', border: '3px solid rgba(255,255,255,0.3)', borderTopColor: '#fff' }} />
                                </div>
                            ) : null}
                            {scanResults.length === 0 
                                ? <div style={{ padding: '3em', color: 'var(--text-muted)', textAlign: 'center' }}>No new files found.</div>
                                : renderScanTable(scanResults)}
                        </div>
                        {renderImportControls(isIndexing, isCancelling, scanResults, currentScanPath, onIndexFiles, onCancelImport)}
                    </div>
                </div>
            </div>
        );
    } catch (e) {
        console.error('[LibraryScreen] Render Error', e);
        return <div style={{ color: 'red', padding: '1em' }}>Render Error (check console)</div>;
    }
}

function renderHierarchicalFolderList(roots: Res.DirectoryNodeResponse[], onPathChange: (path: string) => void) {
    const renderNode = (node: Res.DirectoryNodeResponse, depth: number): VNode => {
        const indent = depth * 1.5 + 'em';
        
        return (
            <div>
                <div 
                    class={{ 'folder-row': true }}
                    key={node.directoryId}
                    style={{ 
                        padding: '0.4em 1em 0.4em ' + indent, 
                        borderBottom: '1px solid var(--border-dim)', 
                        cursor: 'pointer', 
                        fontSize: '0.9em',
                        display: 'flex',
                        alignItems: 'center'
                    }}
                    on={{ click: (e: MouseEvent) => { e.preventDefault(); onPathChange(node.path); } }}
                >
                    <span style={{ marginRight: '0.5em', color: 'var(--accent)' }}>{'\uD83D\uDCC1'}</span>
                    <span style={{ flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} attrs={{ title: node.name }}>{node.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>{node.imageCount.toString()}</span>
                </div>
                {node.children.map((c: any) => renderNode(c, depth + 1))}
            </div>
        );
    };

    return <div>{roots.map(r => renderNode(r, 1))}</div>;
}

function renderStats(info: Res.LibraryInfoResponse) {
    const item = (label: string, val: string | number, sub?: string) => (
        <div style={{ marginBottom: '1.2em' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '0.3em' }}>{label}</div>
            <div style={{ wordBreak: 'break-all', fontSize: '0.95em', color: 'var(--text-bright)' }}>{val.toString()}</div>
            {sub ? <div style={{ textAlign: 'right', color: 'var(--accent)', fontSize: '0.85em', marginTop: '0.3em', fontWeight: 'bold' }}>{sub}</div> : null}
        </div>
    );

    return (
        <div>
            {item('Metadata DB', info.dbPath, (info.dbSize / (1024 * 1024)).toFixed(2) + ' MB')}
            {item('Preview DB', info.previewDbPath, (info.previewDbSize / (1024 * 1024)).toFixed(2) + ' MB')}
            {item('Config', info.configPath)}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1em', borderTop: '1px solid var(--border-dim)', paddingTop: '1em', marginTop: '1.5em' }}>
                <div style={{ color: 'var(--text-muted)' }}>Total Images:</div>
                <div style={{ fontWeight: 'bold' }}>{info.totalImages.toLocaleString()}</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1em' }}>
                <div style={{ color: 'var(--text-muted)' }}>Thumbnailed:</div>
                <div style={{ fontWeight: 'bold' }}>{info.totalThumbnailedImages.toLocaleString()}</div>
            </div>
        </div>
    );
}

function renderScanTable(results: { path: string, status: string }[]) {
    return (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: '0.9em', fontFamily: 'monospace' }}>
            <thead style={{ position: 'sticky', top: '0', background: 'var(--bg-input)', color: 'var(--text-bright)', zIndex: '1' }}>
                <tr>
                    <th style={{ textAlign: 'left', padding: '1em' }}>File Path</th>
                    <th style={{ textAlign: 'right', padding: '1em', width: '100px' }}>Status</th>
                </tr>
            </thead>
            <tbody>
                {results.map((r, i) => (
                    <tr key={'scan-' + i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                        <td style={{ padding: '0.5em 1em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} attrs={{ title: r.path }}>{r.path}</td>
                        <td style={{ padding: '0.5em 1em', textAlign: 'right', color: r.status === 'indexed' ? 'var(--accent)' : 'var(--text-muted)' }}>{r.status.toUpperCase()}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function renderImportControls(isIndexing: boolean, isCancelling: boolean, results: any[], currentPath: string, onIndex: (p: string, l: boolean, m: boolean) => void, onCancel: () => void) {
    if (isIndexing) {
        const indexed = results.filter(r => r.status === 'indexed').length;
        const total = results.length;
        const percent = total > 0 ? (indexed / total) * 100 : 0;

        return (
            <div style={{ paddingTop: '2em', borderTop: '1px solid var(--border-main)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1em' }}>
                    <span>{isCancelling ? 'Cancelling...' : 'Indexing Photos...'}</span>
                    <div>
                        <span>{`${indexed} / ${total}`}</span>
                        <button
                            style={{ marginLeft: '1em', padding: '2px 10px', background: isCancelling ? '#555' : '#8b0000', color: 'white', border: 'none', borderRadius: '4px', cursor: isCancelling ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                            on={{ click: isCancelling ? (() => {}) : onCancel }}
                            attrs={{ disabled: isCancelling }}
                        >
                            {isCancelling ? <span class={{ spinner: true }} style={{ width: '0.8em', height: '0.8em', borderWidth: '2px' }} /> : null}
                            CANCEL
                        </button>
                    </div>
                </div>
                <div style={{ width: '100%', height: '1.5em', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-light)' }}>
                    <div class={{ 'barber-pole': true }} style={{ width: `${percent}%`, height: '100%', backgroundColor: 'var(--accent)', transition: 'width 0.3s ease' }} />
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '2em', paddingTop: '2em', borderTop: '1px solid var(--border-main)', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '1.5em' }}>
                <label>
                    <input id="gen-low-check" type="checkbox" props={{ checked: true }} />
                    {' Low Previews'}
                </label>
                <label>
                    <input id="gen-med-check" type="checkbox" props={{ checked: true }} />
                    {' Medium Previews'}
                </label>
            </div>
            <button
                style={{ flex: '1', padding: '1em', background: 'var(--accent)', color: 'var(--text-bright)', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                on={{ click: () => {
                    const low = (document.getElementById('gen-low-check') as HTMLInputElement).checked;
                    const med = (document.getElementById('gen-med-check') as HTMLInputElement).checked;
                    onIndex(currentPath, low, med);
                } }}
            >
                INDEX FOUND FILES
            </button>
        </div>
    );
}
