import { h, VNode } from '../../snabbdom-setup.js';

export interface SettingsModalProps {
    isVisible: boolean;
    currentTheme: string;
    overlayFormat: string;
    onClose: () => void;
    onThemeChange: (theme: string) => void;
    onOverlayFormatChange: (format: string) => void;
    onResetLayout: () => void;
}

export function SettingsModal(props: SettingsModalProps): VNode {
    const { isVisible, currentTheme, overlayFormat, onClose, onThemeChange, onOverlayFormatChange, onResetLayout } = props;

    return h('div.modal-overlay', {
        class: { active: isVisible },
        on: { click: onClose }
    }, [
        h('div.shortcuts-dialog', { // reusing style
            on: { click: (e: MouseEvent) => e.stopPropagation() }
        }, [
            h('h2', 'Application Settings'),
            h('div.shortcut-row', [
                h('span.shortcut-desc', 'UI Theme'),
                h('select', {
                    style: { background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px' },
                    on: { change: (e: Event) => onThemeChange((e.target as HTMLSelectElement).value) }
                }, [
                    h('option', { attrs: { value: 'dark', selected: currentTheme === 'dark' } }, 'Dark (Default)'),
                    h('option', { attrs: { value: 'light', selected: currentTheme === 'light' } }, 'Light'),
                    h('option', { attrs: { value: 'oled', selected: currentTheme === 'oled' } }, 'True Black (OLED)')
                ])
            ]),
            h('div.shortcut-row', [
                h('span.shortcut-desc', 'Loupe Overlay Format'),
                h('input', {
                    attrs: { type: 'text', value: overlayFormat },
                    style: { background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px', flex: '1', marginLeft: '1em' },
                    on: { change: (e: Event) => onOverlayFormatChange((e.target as HTMLInputElement).value) }
                })
            ]),
            h('div', { style: { marginTop: '1em', fontSize: '0.75em', color: 'var(--text-muted)' } }, 
                'Variables: {Filename}, {Takendate}, {Takentime}, {MD:Any Metadata Tag}'
            ),
            h('div', { style: { borderTop: '1px solid var(--border-light)', margin: '1em 0', paddingTop: '1em' } }, [
                h('button', {
                    style: { width: '100%', padding: '8px', cursor: 'pointer', background: '#8b0000', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' },
                    on: { click: () => { if (confirm('Are you sure you want to reset the layout to default?')) onResetLayout(); } }
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
