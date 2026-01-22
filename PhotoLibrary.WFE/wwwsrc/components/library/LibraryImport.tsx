/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import { FileSystemBrowser, FSNode } from '../import/FileSystemBrowser.js';

export interface LibraryImportProps {
    fsRoots: FSNode[];
    onFsToggle: (node: FSNode) => void;
    onSelect: (path: string) => void;
    currentScanPath: string;
    onFindLocal: (path: string) => void;
    isScanning: boolean;
    scanResults: string[];
    selectedFiles: Set<string>;
    onToggleFile: (path: string) => void;
    onSelectAll: () => void;
}

export function LibraryImport(props: LibraryImportProps): VNode {
    const { fsRoots, onFsToggle, onSelect, currentScanPath, onFindLocal, isScanning, scanResults, selectedFiles, onToggleFile, onSelectAll } = props;

    const allSelected = scanResults.length > 0 && selectedFiles.size === scanResults.length;

    return (
        <div 
            class={{ 'lib-pane': true }}
            style={{ display: 'flex', flexDirection: 'column', gap: '1.5em', height: '100%', overflowY: 'auto', padding: '1em' }}
        >
            <h3 style={{ marginTop: '0', color: 'var(--text-bright)' }}>Local Directory Browser</h3>
            
            <FileSystemBrowser
                roots={fsRoots}
                onToggle={onFsToggle}
                onSelect={onSelect}
                selectedPath={currentScanPath}
            />

            <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center' }}>
                <input
                    attrs={{ type: 'text' }}
                    props={{ readonly: true, value: currentScanPath, placeholder: 'Select a directory...' }}
                    style={{ flex: '1', background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.6em', borderRadius: '4px', fontSize: '0.9em' }}
                />
                <button
                    style={{ padding: '0.6em 1.5em', background: 'var(--bg-active)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                    on={{ click: () => onFindLocal(currentScanPath) }}
                >
                    SCAN FOR PHOTOS
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em', minHeight: '0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: '0', color: 'var(--text-bright)' }}>Copyable Files</h3>
                    {scanResults.length > 0 ? (
                        <button
                            style={{ padding: '4px 12px', background: 'var(--bg-panel)', color: 'var(--text-main)', border: '1px solid var(--border-light)', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em' }}
                            on={{ click: onSelectAll }}
                        >
                            {allSelected ? 'Deselect All' : 'Select All'}
                        </button>
                    ) : null}
                </div>
                <div
                    style={{ 
                        border: '1px solid var(--border-main)', borderRadius: '4px', 
                        background: 'var(--bg-panel-alt)', height: '20em', 
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
                    {scanResults.length === 0 ? (
                        <div style={{ padding: '2em', color: 'var(--text-muted)', textAlign: 'center' }}>No files found or directory not scanned.</div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em', fontFamily: 'monospace' }}>
                            <tbody>
                                {scanResults.map((f, i) => {
                                    const isSelected = selectedFiles.has(f);
                                    return (
                                        <tr 
                                            key={'local-' + i}
                                            style={{ 
                                                borderBottom: '1px solid var(--border-dim)', 
                                                cursor: 'pointer',
                                                background: isSelected ? 'var(--highlight-color)' : 'transparent',
                                                color: isSelected ? 'var(--text-bright)' : 'inherit'
                                            }}
                                            on={{ click: () => onToggleFile(f) }}
                                        >
                                            <td style={{ padding: '0.4em 0.8em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
                {selectedFiles.size > 0 ? (
                    <div style={{ fontSize: '0.85em', color: 'var(--text-muted)', textAlign: 'right', marginTop: '0.5em' }}>
                        {`${selectedFiles.size} files selected`}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
