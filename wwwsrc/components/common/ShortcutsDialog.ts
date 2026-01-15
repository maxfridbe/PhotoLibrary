import { h, VNode } from '../../snabbdom-setup.js';

export interface ShortcutsDialogProps {
    isVisible: boolean;
    onClose: () => void;
}

export function ShortcutsDialog(props: ShortcutsDialogProps): VNode {
    const { isVisible, onClose } = props;

    return h('div.modal-overlay', {
        class: { active: isVisible },
        on: { click: onClose }
    }, [
        h('div.shortcuts-dialog', {
            on: { click: (e: MouseEvent) => e.stopPropagation() }
        }, [
            h('h2', 'Keyboard Shortcuts'),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Grid View'), h('span.shortcut-key', 'G')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Loupe (Preview) View'), h('span.shortcut-key', 'L')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Toggle Pick Flag'), h('span.shortcut-key', 'P')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Set Rating'), h('span.shortcut-key', '1-5')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Clear Rating'), h('span.shortcut-key', '0')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Rotate Left'), h('span.shortcut-key', '[')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Rotate Right'), h('span.shortcut-key', ']')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Toggle Metadata'), h('span.shortcut-key', 'M')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Toggle Library'), h('span.shortcut-key', 'B')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Navigate Photos'), h('span.shortcut-key', 'Arrows')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Navigate Folders'), h('span.shortcut-key', 'PgUp/PgDn')]),
            h('div.shortcut-row', [h('span.shortcut-desc', 'Show Shortcuts'), h('span.shortcut-key', '?')]),
            h('div', { style: { marginTop: '20px', textAlign: 'right' } }, [
                h('button', {
                    style: { padding: '5px 15px', cursor: 'pointer', background: '#444', color: '#fff', border: 'none', borderRadius: '4px' },
                    on: { click: onClose }
                }, 'Close')
            ])
        ])
    ]);
}
