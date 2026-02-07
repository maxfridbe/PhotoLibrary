/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';

export function LibraryStatistics(info: Res.LibraryInfoResponse | null, isBackingUp: boolean = false, onBackup?: () => void): VNode {
    return (
        <div 
            class={{ 'lib-pane': true }}
            style={{ display: 'flex', flexDirection: 'column', gap: '1.5em', overflowY: 'overlay' as any, boxSizing: 'border-box', height: '100%', padding: '1em' }}
        >
            {info ? renderStats(info, isBackingUp, onBackup) : <div>Loading statistics...</div>}
        </div>
    );
}

function renderStats(info: Res.LibraryInfoResponse, isBackingUp: boolean, onBackup?: () => void) {
    const item = (label: string, val: string | number, sub?: string) => (
        <div style={{ marginBottom: '1.2em' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '0.3em' }}>{label}</div>
            <div style={{ wordBreak: 'break-all', fontSize: '0.95em', color: 'var(--text-bright)' }}>{val.toString()}</div>
            {sub ? <div style={{ textAlign: 'right', color: 'var(--accent)', fontSize: '0.85em', marginTop: '0.3em', fontWeight: 'bold' }}>{sub}</div> : null}
        </div>
    );

    const backups = info.backups && info.backups.length > 0 ? (
        <div>
            <h4 style={{ marginTop: '1.5em', marginBottom: '0.5em', color: 'var(--text-header)', fontSize: '0.9em' }}>Recent Backups</h4>
            <div style={{ fontSize: '0.85em', background: 'var(--bg-panel-alt)', borderRadius: '4px', border: '1px solid var(--border-dim)', overflow: 'hidden' }}>
                {info.backups.map((b, i) => (
                    <div 
                        key={'backup-' + i}
                        style={{ padding: '0.5em 0.8em', borderBottom: i < info.backups.length - 1 ? '1px solid var(--border-dim)' : 'none', display: 'flex', justifyContent: 'space-between' }} 
                    >
                        <div>
                            <div style={{ color: 'var(--text-bright)', fontWeight: 'bold' }}>{b.name}</div>
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>{new Date(b.date).toLocaleString()}</div>
                        </div>
                        <div style={{ color: 'var(--accent)', alignSelf: 'center', fontWeight: 'bold' }}>{(b.size / (1024 * 1024)).toFixed(2)} MB</div>
                    </div>
                ))}
            </div>
        </div>
    ) : null;

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
            {backups}
            <div style={{ marginTop: '2em', borderTop: '1px solid var(--border-dim)', paddingTop: '1em' }}>
                {isBackingUp ? (
                    <div>
                        <div style={{ marginBottom: '0.5em', fontSize: '0.9em', color: 'var(--text-muted)' }}>Exporting to ~/.config/PhotoLibrary/backup/...</div>
                        <div style={{ width: '100%', height: '1.5em', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-light)' }}>
                            <div class={{ 'barber-pole': true }} style={{ width: '100%', height: '100%', backgroundColor: 'var(--accent)' }} />
                        </div>
                    </div>
                ) : (
                    <button
                        style={{ width: '100%', padding: '0.65em', cursor: 'pointer', background: 'var(--bg-panel-alt)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', fontWeight: '600' }}
                        on={{ click: onBackup || (() => {}) }}
                    >
                        Backup Databases
                    </button>
                )}
            </div>
        </div>
    );
}
