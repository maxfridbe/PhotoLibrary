import { h } from '../../snabbdom-setup.js';
export function LibraryStatistics(info) {
    return h('div.lib-pane', {
        style: { display: 'flex', flexDirection: 'column', gap: '1.5em', overflowY: 'auto', boxSizing: 'border-box', height: '100%', padding: '1em' }
    }, [
        h('h3', { style: { marginTop: '0', color: 'var(--text-bright)' } }, 'Library Statistics'),
        info ? renderStats(info) : h('div', 'Loading statistics...')
    ]);
}
function renderStats(info) {
    const item = (label, val, sub) => h('div', { style: { marginBottom: '1.2em' } }, [
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
