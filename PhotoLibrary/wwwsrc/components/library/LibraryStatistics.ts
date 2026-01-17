import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';

export function LibraryStatistics(info: Res.LibraryInfoResponse | null, isBackingUp: boolean = false, onBackup?: () => void): VNode {
    return h('div.lib-pane', { 
        style: { display: 'flex', flexDirection: 'column', gap: '1.5em', overflowY: 'auto', boxSizing: 'border-box', height: '100%', padding: '1em' } 
    }, [
        info ? renderStats(info, isBackingUp, onBackup) : h('div', 'Loading statistics...')
    ]);
}

function renderStats(info: Res.LibraryInfoResponse, isBackingUp: boolean, onBackup?: () => void) {
    const item = (label: string, val: string | number, sub?: string) => h('div', { style: { marginBottom: '1.2em' } }, [
        h('div', { style: { color: 'var(--text-muted)', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '0.3em' } }, label),
        h('div', { style: { wordBreak: 'break-all', fontSize: '0.95em', color: 'var(--text-bright)' } }, val.toString()),
        sub ? h('div', { style: { textAlign: 'right', color: 'var(--accent)', fontSize: '0.85em', marginTop: '0.3em', fontWeight: 'bold' } }, sub) : null
    ]);

    const backupList = info.backups && info.backups.length > 0 ? [
        h('h4', { style: { marginTop: '1.5em', marginBottom: '0.5em', color: 'var(--text-header)', fontSize: '0.9em' } }, 'Recent Backups'),
        h('div', { style: { fontSize: '0.85em', background: 'var(--bg-panel-alt)', borderRadius: '4px', border: '1px solid var(--border-dim)', overflow: 'hidden' } }, 
            info.backups.map((b, i) => h('div', { 
                key: 'backup-' + i,
                style: { padding: '0.5em 0.8em', borderBottom: i < info.backups.length - 1 ? '1px solid var(--border-dim)' : 'none', display: 'flex', justifyContent: 'space-between' } 
            }, [
                h('div', [
                    h('div', { style: { color: 'var(--text-bright)', fontWeight: 'bold' } }, b.name),
                    h('div', { style: { color: 'var(--text-muted)', fontSize: '0.85em' } }, new Date(b.date).toLocaleString())
                ]),
                h('div', { style: { color: 'var(--accent)', alignSelf: 'center', fontWeight: 'bold' } }, (b.size / (1024 * 1024)).toFixed(2) + ' MB')
            ]))
        )
    ] : [];

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
        ]),
        ...backupList,
        h('div', { style: { marginTop: '2em', borderTop: '1px solid var(--border-dim)', paddingTop: '1em' } }, [
            isBackingUp ? h('div', [
                h('div', { style: { marginBottom: '0.5em', fontSize: '0.9em', color: 'var(--text-muted)' } }, 'Exporting to ~/.config/PhotoLibrary/backup/...'),
                h('div', { style: { width: '100%', height: '1.5em', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-light)' } }, [
                    h('div.barber-pole', { style: { width: '100%', height: '100%', backgroundColor: 'var(--accent)' } })
                ])
            ]) : h('button', {
                style: { width: '100%', padding: '0.65em', cursor: 'pointer', background: 'var(--bg-panel-alt)', color: 'var(--text-bright)', border: '1px solid var(--border-light)', borderRadius: '4px', fontWeight: '600' },
                on: { click: onBackup || (() => {}) }
            }, 'Backup Databases')
        ])
    ]);
}