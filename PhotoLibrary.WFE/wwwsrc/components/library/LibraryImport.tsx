/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import { FileSystemBrowser, FSNode } from '../import/FileSystemBrowser.js';

import { hub } from '../../PubSub.js';
import { constants } from '../../constants.js';
import * as Res from '../../Responses.generated.js';

const ps = constants.pubsub;

export interface ImportSettings {
    generatePreview: boolean;
    preventDuplicateName: boolean;
    preventDuplicateHash: boolean;
    directoryTemplate: string;
    useDirectoryTemplate: boolean;
    targetRootId: string;
}

export interface LibraryImportProps {
    fsRoots: FSNode[];
    onFsToggle: (node: FSNode) => void;
    onSelect: (path: string) => void;
    onScanPathChange: (path: string) => void;
    currentScanPath: string;
    onFindLocal: (path: string) => void;
    isScanning: boolean;
    isValidating: boolean;
    scanResults: Res.ScanFileResult[];
    selectedFiles: Set<string>;
    existingFiles: Set<string>;
    onToggleFile: (path: string) => void;
    onSelectAll: () => void;
    
    // Settings
    settings: ImportSettings;
    onSettingsChange: (s: ImportSettings) => void;
    
    // Destination Picker
    importLocationsExpanded: Set<string>;
    onToggleImportLocation: (id: string) => void;
    registeredRoots: Res.DirectoryNodeResponse[];
    
    // Import action
    onImport: () => void;
    isImporting: boolean;
}

export function LibraryImport(props: LibraryImportProps): VNode {
    const { 
        fsRoots, onFsToggle, onSelect, onScanPathChange, currentScanPath, onFindLocal, isScanning, isValidating, 
        scanResults, selectedFiles, existingFiles, onToggleFile, onSelectAll, 
        settings, onSettingsChange, 
        importLocationsExpanded, onToggleImportLocation, registeredRoots,
        onImport, isImporting 
    } = props;

    const allSelected = scanResults.length > 0 && selectedFiles.size === scanResults.length;

    const findNodeById = (nodes: Res.DirectoryNodeResponse[], targetId: string): Res.DirectoryNodeResponse | null => {
        for (const node of nodes) {
            if (node.directoryId === targetId) return node;
            if (node.children) {
                const found = findNodeById(node.children, targetId);
                if (found) return found;
            }
        }
        return null;
    };

    const targetRoot = registeredRoots ? findNodeById(registeredRoots, settings.targetRootId) : null;
    const targetPath = targetRoot ? targetRoot.path : 'None Selected';

    const getPreviewPath = (fileName: string, dateTaken?: string | Date) => {
        if (!settings.useDirectoryTemplate) {
            const rootPart = targetPath === 'None Selected' ? '?' : targetPath;
            return rootPart + '/' + fileName;
        }

        // Use file date or fallback to today
        const sampleDate = dateTaken ? new Date(dateTaken) : new Date();
        const yyyy = sampleDate.getFullYear().toString();
        const mm = (sampleDate.getMonth() + 1).toString().padStart(2, '0');
        const dd = sampleDate.getDate().toString().padStart(2, '0');
        
        let subDir = settings.directoryTemplate
            .replace(/{YYYY}/g, yyyy)
            .replace(/{MM}/g, mm)
            .replace(/{DD}/g, dd)
            .replace(/{Date}/g, `${yyyy}-${mm}-${dd}`);
            
        // Ensure no double slashes and no leading/trailing slashes for subdir
        subDir = subDir.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
            
        const rootPart = targetPath === 'None Selected' ? '?' : targetPath;
        const subPart = subDir ? '/' + subDir : '';
        return rootPart + subPart + '/' + fileName;
    };

    const summary = `I will import ${selectedFiles.size} photos from ${currentScanPath}. ` +
                    `I will copy them into ${targetPath} ` + 
                    (settings.useDirectoryTemplate ? `using the naming scheme "${settings.directoryTemplate || 'Flat'}"` : `directly (no subfolders)`) +
                    ` (e.g. ${getPreviewPath('photo.jpg')}). ` +
                    (settings.preventDuplicateName ? "I will skip files with duplicate names. " : "") +
                    (settings.preventDuplicateHash ? "I will skip files with duplicate content hashes. " : "") +
                    (settings.generatePreview ? "I will generate previews immediately after copy." : "");

    return (
        <div 
            class={{ 'lib-pane': true }}
            style={{ display: 'flex', flexDirection: 'column', gap: '1.5em', height: '100%', overflowY: 'overlay' as any, padding: '1em 1em 3em 1em' }}
        >
            <div style={{ display: 'flex', gap: '1.5em', flex: '1', minHeight: '0' }}>
                {/* Left: Source Selection */}
                <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '1em', minWidth: '0' }}>
                    <h3 style={{ marginTop: '0', color: 'var(--text-bright)' }}>Source: Local Directory</h3>
                    
                    <div style={{ maxHeight: '250px', display: 'flex', flexDirection: 'column', border: '1px solid var(--border-main)', borderRadius: '4px', background: 'var(--bg-panel-alt)' }}>
                        <FileSystemBrowser
                            roots={fsRoots}
                            onToggle={onFsToggle}
                            onSelect={onSelect}
                            selectedPath={currentScanPath}
                        />
                    </div>

                    <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center' }}>
                        <input
                            attrs={{ type: 'text' }}
                            props={{ value: currentScanPath, placeholder: 'Select a directory...' }}
                            style={{ flex: '1', background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.6em', borderRadius: '4px', fontSize: '0.9em' }}
                            on={{ input: (e: any) => onScanPathChange(e.target.value) }}
                        />
                        <button
                            style={{ padding: '0.6em 1.5em', background: 'var(--bg-active)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                            on={{ click: () => onFindLocal(currentScanPath) }}
                        >
                            SCAN
                        </button>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em', flex: '1', minHeight: '0' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: '0', color: 'var(--text-bright)' }}>Copyable Files ({scanResults.length})</h3>
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
                                background: 'var(--bg-panel-alt)', flex: '1', 
                                overflowY: 'overlay' as any, position: 'relative' 
                            }}
                        >
                            {(isScanning || isValidating) ? (
                                <div 
                                    style={{ 
                                        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', 
                                        background: 'rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                        zIndex: '10'
                                    }}
                                >
                                    <div class={{ spinner: true }} style={{ width: '2em', height: '2em', border: '3px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', marginBottom: '10px' }} />
                                    <span style={{ color: 'white', fontWeight: 'bold' }}>{isScanning ? 'Scanning...' : 'Validating...'}</span>
                                </div>
                            ) : null}
                            {scanResults.length === 0 ? (
                                <div style={{ padding: '2em', color: 'var(--text-muted)', textAlign: 'center' }}>No files found or directory not scanned.</div>
                            ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em', fontFamily: 'monospace' }}>
                                    <thead style={{ position: 'sticky', top: '0', background: 'var(--bg-input)', zIndex: '5' }}>
                                        <tr>
                                            <th style={{ textAlign: 'left', padding: '0.5em 1em' }}>Original</th>
                                            <th style={{ textAlign: 'left', padding: '0.5em 1em' }}>Date Taken</th>
                                            <th style={{ textAlign: 'left', padding: '0.5em 1em' }}>Destination Preview</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {scanResults.map((f: Res.ScanFileResult, i: number) => {
                                            const path = f.path;
                                            const dateTaken = f.dateTaken;
                                            const isSelected = selectedFiles.has(path);
                                            const exists = existingFiles.has(path);
                                            const fileName = path.split('/').pop() || path;
                                            
                                            // Format date
                                            let dateStr = '-';
                                            if (dateTaken) {
                                                try { dateStr = new Date(dateTaken).toLocaleDateString(); } catch(e) {}
                                            }

                                            return (
                                                <tr 
                                                    key={'local-' + i}
                                                    style={{ 
                                                        borderBottom: '1px solid var(--border-dim)', 
                                                        cursor: exists ? 'default' : 'pointer',
                                                        background: isSelected ? 'var(--highlight-color)' : 'transparent',
                                                        color: isSelected ? 'var(--text-bright)' : 'inherit',
                                                        opacity: exists ? '0.6' : '1'
                                                    }}
                                                    on={{ click: () => !exists && onToggleFile(path) }}
                                                >
                                                    <td style={{ padding: '0.4em 1em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }} attrs={{ title: path }}>
                                                        {exists ? <span title="File exists in destination" style={{ marginRight: '5px' }}>⚠️</span> : null}
                                                        <span style={{ textDecoration: exists ? 'line-through' : 'none' }}>{fileName}</span>
                                                    </td>
                                                    <td style={{ padding: '0.4em 1em', color: 'var(--text-muted)', fontSize: '0.9em' }}>{dateStr}</td>
                                                    <td style={{ padding: '0.4em 1em', color: isSelected ? 'var(--text-bright)' : 'var(--text-muted)', fontSize: '0.8em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '300px' }}>{isSelected ? getPreviewPath(fileName, dateTaken) : ''}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                </div>

                {/* Right: Settings Pane */}
                <div style={{ width: '350px', display: 'flex', flexDirection: 'column', gap: '1.5em', borderLeft: '1px solid var(--border-main)', paddingLeft: '1.5em', overflowY: 'auto' }}>
                    <h3 style={{ marginTop: '0', color: 'var(--text-bright)' }}>Import Settings</h3>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8em' }}>
                        <label class={{ 'custom-checkbox': true }}>
                            <input 
                                attrs={{ type: 'checkbox' }}
                                props={{ checked: settings.generatePreview }}
                                on={{ change: (e: any) => onSettingsChange({ ...settings, generatePreview: e.target.checked }) }}
                            />
                            <span class={{ 'checkmark': true }}></span>
                            <span>Generate Previews On Import</span>
                        </label>
                        <label class={{ 'custom-checkbox': true }}>
                            <input 
                                attrs={{ type: 'checkbox' }}
                                props={{ checked: settings.preventDuplicateName }}
                                on={{ change: (e: any) => onSettingsChange({ ...settings, preventDuplicateName: e.target.checked }) }}
                            />
                            <span class={{ 'checkmark': true }}></span>
                            <span>Prevent Copy if Duplicate Name</span>
                        </label>
                        <label class={{ 'custom-checkbox': true }}>
                            <input 
                                attrs={{ type: 'checkbox' }}
                                props={{ checked: settings.preventDuplicateHash }}
                                on={{ change: (e: any) => onSettingsChange({ ...settings, preventDuplicateHash: e.target.checked }) }}
                            />
                            <span class={{ 'checkmark': true }}></span>
                            <span>Prevent Copy if Duplicate Hash</span>
                        </label>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em', flex: '1', minHeight: '200px' }}>
                        <label style={{ fontSize: '0.85em', color: 'var(--text-label)', fontWeight: 'bold' }}>Destination Location</label>
                        <div 
                            class={{ 'folder-list-container': true }}
                            style={{ 
                                border: '1px solid var(--border-main)', borderRadius: '4px', 
                                background: 'var(--bg-panel-alt)', flex: '1', 
                                overflowY: 'overlay' as any
                            }}
                        >
                            {registeredRoots && registeredRoots.length > 0 ? renderDestinationPicker(registeredRoots, settings.targetRootId, importLocationsExpanded, (id) => onSettingsChange({ ...settings, targetRootId: id }), onToggleImportLocation) : []}
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <label style={{ fontSize: '0.85em', color: 'var(--text-label)', fontWeight: 'bold' }}>Directory Template</label>
                            <label class={{ 'custom-checkbox': true }} style={{ fontSize: '0.8em' }}>
                                <input 
                                    attrs={{ type: 'checkbox' }}
                                    props={{ checked: settings.useDirectoryTemplate }}
                                    on={{ change: (e: any) => onSettingsChange({ ...settings, useDirectoryTemplate: e.target.checked }) }}
                                />
                                <span class={{ 'checkmark': true }}></span>
                                <span>Enable</span>
                            </label>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5em', opacity: settings.useDirectoryTemplate ? '1' : '0.5', pointerEvents: settings.useDirectoryTemplate ? 'auto' : 'none' }}>
                            <input
                                attrs={{ type: 'text', placeholder: 'e.g. {YYYY}/{MM}/{DD}' }}
                                props={{ value: settings.directoryTemplate }}
                                style={{ flex: '1', background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.6em', borderRadius: '4px', fontSize: '0.9em' }}
                                on={{ input: (e: any) => onSettingsChange({ ...settings, directoryTemplate: e.target.value }) }}
                            />
                            <button
                                style={{ padding: '0 0.8em', background: 'var(--bg-active)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', cursor: 'pointer' }}
                                on={{ click: (e: any) => {
                                    const rect = e.target.getBoundingClientRect();
                                    hub.pub(ps.UI_SHOW_POPOVER, { 
                                        type: 'directory-template', 
                                        x: rect.right - 220, y: rect.bottom + 5,
                                        current: settings.directoryTemplate,
                                        onSelect: (t: string) => onSettingsChange({ ...settings, directoryTemplate: t })
                                    });
                                }}}
                            >
                                &#9998;
                            </button>
                        </div>
                        <div style={{ fontSize: '0.75em', color: 'var(--text-muted)' }}>
                            Preview: {getPreviewPath('sample.jpg')}
                        </div>
                    </div>

                    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '1em' }}>
                        <div style={{ 
                            background: 'var(--bg-panel-alt)', border: '1px solid var(--border-dim)', 
                            padding: '1em', borderRadius: '4px', fontSize: '0.85em', color: 'var(--text-muted)',
                            lineHeight: '1.4', fontStyle: 'italic'
                        }}>
                            {summary}
                        </div>
                        <button
                            style={{ 
                                padding: '1em', background: (selectedFiles.size > 0 && settings.targetRootId) ? 'var(--accent)' : '#555', 
                                color: 'var(--text-bright)', border: 'none', borderRadius: '4px', 
                                cursor: (selectedFiles.size > 0 && settings.targetRootId) ? 'pointer' : 'not-allowed', 
                                fontWeight: 'bold', fontSize: '1.1em' 
                            }}
                            attrs={{ disabled: selectedFiles.size === 0 || !settings.targetRootId || isImporting }}
                            on={{ click: onImport }}
                        >
                            {isImporting ? 'IMPORTING...' : `IMPORT ${selectedFiles.size} PHOTOS`}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function renderDestinationPicker(
    roots: Res.DirectoryNodeResponse[], 
    selectedId: string, 
    expanded: Set<string>, 
    onSelect: (id: string) => void,
    onToggle: (id: string) => void
) {
    const renderNode = (node: Res.DirectoryNodeResponse, depth: number): VNode => {
        const indent = depth * 1.5 + 'em';
        const isSelected = node.directoryId === selectedId;
        const isExpanded = expanded.has(node.directoryId);
        const hasChildren = node.children && node.children.length > 0;
        
        return (
            <div>
                <div 
                    class={{ 'folder-row': true, 'selected': isSelected }}
                    key={node.directoryId}
                    attrs={{ 'data-id': node.directoryId }}
                    style={{ 
                        padding: '0.4em 1em 0.4em ' + indent, 
                        borderBottom: '1px solid var(--border-dim)', 
                        cursor: 'pointer', 
                        fontSize: '0.9em',
                        display: 'flex',
                        alignItems: 'center',
                        background: isSelected ? 'var(--highlight-color)' : 'transparent',
                        color: isSelected ? 'var(--text-bright)' : 'inherit'
                    }}
                    on={{ click: (e: MouseEvent) => { e.preventDefault(); onSelect(node.directoryId); } }}
                >
                    <span 
                        style={{ width: '1em', display: 'inline-block', textAlign: 'center', cursor: 'pointer', color: 'var(--text-muted)', marginRight: '0.3em' }}
                        on={{ click: (e: MouseEvent) => { e.stopPropagation(); onToggle(node.directoryId); } }}
                    >
                        {hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : ''}
                    </span>
                    <span style={{ marginRight: '0.5em', color: isSelected ? 'var(--text-bright)' : 'var(--accent)' }}>{'\uD83D\uDCC1'}</span>
                    <span style={{ flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} attrs={{ title: node.name }}>{node.name}</span>
                </div>
                <div style={{ display: isExpanded ? 'block' : 'none' }}>
                    {hasChildren ? node.children.map((c: any) => renderNode(c, depth + 1)) : []}
                </div>
            </div>
        );
    };

    return <div>{roots.map(r => renderNode(r, 1))}</div>;
}