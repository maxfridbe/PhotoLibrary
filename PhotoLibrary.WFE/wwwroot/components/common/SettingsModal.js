import { h } from '../../snabbdom-setup.js';
import { themes } from '../../themes.js';
import { APP_VERSION, BUILD_DATE } from '../../version.js';
export function SettingsModal(props) {
    const { isVisible, currentTheme, overlayFormat, appName, onClose, onThemeChange, onOverlayFormatChange, onAppNameChange, onResetLayout } = props;
    return h('div.modal-overlay', {
        class: { active: isVisible },
        on: { click: onClose }
    }, [
        h('div.shortcuts-dialog', {
            on: { click: (e) => e.stopPropagation() }
        }, [
            h('h2', 'Application Settings'),
            h('div.shortcut-row', [
                h('span.shortcut-desc', 'Version'),
                h('span', { style: { marginLeft: '1em', color: 'var(--text-muted)' } }, APP_VERSION)
            ]),
            h('div.shortcut-row', [
                h('span.shortcut-desc', 'Build Date'),
                h('span', { style: { marginLeft: '1em', color: 'var(--text-muted)' } }, BUILD_DATE)
            ]),
            h('div.shortcut-row', [
                h('span.shortcut-desc', 'Application Name'),
                h('input', {
                    attrs: { type: 'text', value: appName },
                    style: { background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px', flex: '1', marginLeft: '1em' },
                    on: { change: (e) => onAppNameChange(e.target.value) }
                })
            ]),
            h('div.shortcut-row', [
                h('span.shortcut-desc', 'UI Theme'),
                h('select', {
                    style: { background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px' },
                    on: { change: (e) => onThemeChange(e.target.value) }
                }, Object.keys(themes).map(name => h('option', { attrs: { value: name, selected: currentTheme === name } }, name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))))
            ]),
            h('div.shortcut-row', [
                h('span.shortcut-desc', 'Loupe Overlay Format'),
                h('input', {
                    attrs: { type: 'text', value: overlayFormat },
                    style: { background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px', flex: '1', marginLeft: '1em' },
                    on: { change: (e) => onOverlayFormatChange(e.target.value) }
                })
            ]),
            h('div', { style: { marginTop: '1em', fontSize: '0.75em', color: 'var(--text-muted)' } }, 'Variables: {Filename}, {Takendate}, {Takentime}, {MD:Any Metadata Tag}'),
            h('div', { style: { borderTop: '1px solid var(--border-light)', margin: '1em 0', paddingTop: '1em' } }, [
                h('button', {
                    style: { width: '100%', padding: '8px', cursor: 'pointer', background: '#8b0000', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' },
                    on: { click: () => { if (confirm('Are you sure you want to reset the layout to default?'))
                            onResetLayout(); } }
                }, 'Reset Layout')
            ]),
            h('div', { style: { marginTop: '20px', textAlign: 'right' } }, [
                h('button', {
                    style: { padding: '5px 15px', cursor: 'pointer', background: 'var(--border-light)', color: 'var(--text-bright)', border: 'none', borderRadius: '4px' },
                    on: { click: onClose }
                }, 'Close')
            ])
        ])
    ]);
}
