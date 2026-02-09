/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';

export interface ShortcutsDialogProps {
    isVisible: boolean;
    onClose: () => void;
}

export function ShortcutsDialog(props: ShortcutsDialogProps): VNode {
    const { isVisible, onClose } = props;

    return (
        <div 
            class={{ 'modal-overlay': true, active: isVisible }}
            on={{ click: onClose }}
        >
            <div 
                class={{ 'shortcuts-dialog': true }}
                on={{ click: (e: MouseEvent) => e.stopPropagation() }}
            >
                <h2>Keyboard Shortcuts</h2>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Grid View</span><span class={{ 'shortcut-key': true }}>G</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Timeline View</span><span class={{ 'shortcut-key': true }}>T</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Loupe (Preview) View</span><span class={{ 'shortcut-key': true }}>L</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Toggle Pick Flag</span><span class={{ 'shortcut-key': true }}>P</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Set Rating</span><span class={{ 'shortcut-key': true }}>1-5</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Clear Rating</span><span class={{ 'shortcut-key': true }}>0</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Rotate Left</span><span class={{ 'shortcut-key': true }}>[</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Rotate Right</span><span class={{ 'shortcut-key': true }}>]</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Reset Loupe Zoom</span><span class={{ 'shortcut-key': true }}>Z</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Toggle Metadata</span><span class={{ 'shortcut-key': true }}>M</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Toggle Library</span><span class={{ 'shortcut-key': true }}>B</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Navigate Photos</span><span class={{ 'shortcut-key': true }}>Arrows</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Navigate Folders</span><span class={{ 'shortcut-key': true }}>PgUp/PgDn</span></div>
                <div class={{ 'shortcut-row': true }}><span class={{ 'shortcut-desc': true }}>Show Shortcuts</span><span class={{ 'shortcut-key': true }}>?</span></div>
                <div style={{ marginTop: '20px', textAlign: 'right' }}>
                    <button
                        style={{ padding: '5px 15px', cursor: 'pointer', background: '#444', color: '#fff', border: 'none', borderRadius: '4px' }}
                        on={{ click: onClose }}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
