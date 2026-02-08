/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';

export interface TemplateEditorModalProps {
    isVisible: boolean;
    currentTemplate: string;
    onClose: () => void;
    onSave: (template: string) => void;
}

export function TemplateEditorModal(props: TemplateEditorModalProps): VNode {
    const { isVisible, currentTemplate, onClose, onSave } = props;

    const templates = [
        { name: 'YYYY/MM/DD', val: '{YYYY}/{MM}/{DD}' },
        { name: 'YYYY/YYYY-MM-DD', val: '{YYYY}/{YYYY}-{MM}-{DD}' },
        { name: 'YYYY-MM-DD', val: '{YYYY}-{MM}-{DD}' },
        { name: 'One Folder (Flat)', val: '' },
        { name: 'Imports/YYYY-MM-DD', val: 'Imports/{YYYY}-{MM}-{DD}' }
    ];

    return (
        <div 
            class={{ 'modal-overlay': true, active: isVisible }}
            style={{ zIndex: '100000' }}
            on={{ click: onClose }}
        >
            <div 
                class={{ 'shortcuts-dialog': true }}
                style={{ maxWidth: '500px', width: '90%' }}
                on={{ click: (e: MouseEvent) => e.stopPropagation() }}
            >
                <h2 style={{ marginTop: '0' }}>Directory Template Editor</h2>
                
                <div style={{ marginBottom: '1.5em' }}>
                    <label style={{ display: 'block', marginBottom: '0.5em', color: 'var(--text-muted)', fontSize: '0.9em' }}>Template String</label>
                    <input
                        attrs={{ type: 'text', id: 'template-editor-input', placeholder: 'e.g. {YYYY}/{MM}' }}
                        props={{ value: currentTemplate }}
                        style={{ 
                            width: '100%', background: 'var(--bg-input)', color: 'var(--text-input)', 
                            border: '1px solid var(--border-light)', padding: '0.8em', borderRadius: '4px',
                            fontSize: '1.1em', fontFamily: 'monospace'
                        }}
                        on={{ input: (e: any) => onSave(e.target.value) }} 
                    />
                    <div style={{ fontSize: '0.8em', color: 'var(--text-muted)', marginTop: '0.5em' }}>
                        Available tags: {'{YYYY}'}, {'{MM}'}, {'{DD}'}, {'{Date}'}
                    </div>
                </div>

                <div style={{ marginBottom: '1.5em' }}>
                    <label style={{ display: 'block', marginBottom: '0.5em', color: 'var(--text-muted)', fontSize: '0.9em' }}>Common Presets</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {templates.map(t => (
                            <button
                                style={{ 
                                    padding: '10px', background: 'var(--bg-panel)', border: '1px solid var(--border-light)', 
                                    color: 'var(--text-main)', textAlign: 'left', cursor: 'pointer', borderRadius: '4px',
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                                }}
                                on={{ click: () => onSave(t.val) }}
                            >
                                <span style={{ fontWeight: 'bold' }}>{t.name}</span>
                                <code style={{ color: 'var(--accent)', background: 'rgba(0,0,0,0.2)', padding: '2px 5px', borderRadius: '3px' }}>{t.val || '(Empty)'}</code>
                            </button>
                        ))}
                    </div>
                </div>

                <div style={{ textAlign: 'right', borderTop: '1px solid var(--border-dim)', paddingTop: '1em' }}>
                    <button
                        style={{ padding: '10px 25px', cursor: 'pointer', background: 'var(--accent)', color: 'var(--text-bright)', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
                        on={{ click: onClose }}
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}