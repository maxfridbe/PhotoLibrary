/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import { EyeIcon } from '../../icons.js';

export interface ImportStatus {
    status: 'pending' | 'success' | 'error';
    detailedStatus?: string;
    percent?: number;
    error?: string;
    targetPath?: string;
    fileEntryId?: string;
}

export interface ImportStatusTabProps {
    importList: string[];
    progress: Map<string, ImportStatus>;
    onAbort: () => void;
    onShowInGrid: (fileEntryId: string) => void;
    friendlyName: string;
    estimatedRemainingMs?: number;
}

export function ImportStatusTab(props: ImportStatusTabProps): VNode {
    const { importList, progress, onAbort, onShowInGrid, friendlyName, estimatedRemainingMs } = props;
    
    const formatTime = (ms: number) => {
        if (ms <= 0) return '';
        const seconds = Math.ceil(ms / 1000);
        if (seconds < 60) return `${seconds}s remaining`;
        const minutes = Math.floor(seconds / 60);
        const remSeconds = seconds % 60;
        return `${minutes}m ${remSeconds}s remaining`;
    };

    return (
        <div style={{ height: '100%', overflowY: 'overlay' as any, background: 'var(--bg-panel)', padding: '0', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 12px', background: 'var(--bg-header)', borderBottom: '1px solid var(--border-main)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1em' }}>
                        <span style={{ fontWeight: 'bold' }}>Import Progress</span>
                        {estimatedRemainingMs && estimatedRemainingMs > 0 ? (
                            <span style={{ fontSize: '0.85em', color: 'var(--accent)', fontWeight: 'bold' }}>{formatTime(estimatedRemainingMs)}</span>
                        ) : null}
                    </div>
                    <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>{friendlyName}</span>
                </div>
                <button 
                    style={{ padding: '4px 12px', background: '#8b0000', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em', fontWeight: 'bold' }}
                    on={{ click: onAbort }}
                >
                    ABORT IMPORT
                </button>
            </div>
            <div style={{ flex: '1', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em', fontFamily: 'monospace' }}>
                    <thead>
                        <tr style={{ background: 'var(--bg-header)', position: 'sticky', top: '0', zIndex: '1', textAlign: 'left' }}>
                            <th style={{ padding: '8px 12px' }}>Source File</th>
                            <th style={{ padding: '8px 12px' }}>Status / Destination</th>
                        </tr>
                    </thead>
                    <tbody>
                        {importList.map(file => {
                            const info = progress.get(file);
                            const status = info ? info.status : 'pending';
                            const color = status === 'success' ? '#4caf50' : (status === 'error' ? '#ff5555' : 'var(--text-muted)');
                            const fileName = file.split('/').pop() || file;
                            
                            return (
                                <tr key={file} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                                    <td style={{ padding: '6px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }} title={file}>
                                        {fileName}
                                    </td>
                                    <td style={{ padding: '6px 12px', color: color }}>
                                        {status === 'success' ? (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '400px', color: '#4caf50', fontSize: '0.9em' }} title={info?.targetPath}>
                                                    {info?.targetPath}
                                                </span>
                                                {info?.fileEntryId ? (
                                                    <button 
                                                        style={{ background: 'var(--bg-button)', border: '1px solid var(--border-main)', borderRadius: '3px', cursor: 'pointer', padding: '2px 6px', display: 'flex', alignItems: 'center', color: 'var(--text-main)' }}
                                                        attrs={{ title: 'Show in Grid' }}
                                                        on={{ click: () => onShowInGrid(info.fileEntryId!) }}
                                                    >
                                                        {EyeIcon}
                                                    </button>
                                                ) : null}
                                            </div>
                                        ) : (
                                            status === 'error' ? (info?.error || 'Error') : (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8em', color: 'var(--text-muted)' }}>
                                                        <span>{info?.detailedStatus ? `(${info.detailedStatus})` : status.toUpperCase()}</span>
                                                        {info?.percent ? <span>{info.percent}%</span> : null}
                                                    </div>
                                                    {status !== 'pending' || info?.percent ? (
                                                        <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                                                            <div style={{ width: `${info?.percent || 0}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s ease' }} />
                                                        </div>
                                                    ) : null}
                                                </div>
                                            )
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}