/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import { themes } from '../../themes.js';
import { APP_VERSION, BUILD_DATE } from '../../version.js';

export interface SettingsModalProps {
    isVisible: boolean;
    currentTheme: string;
    overlayFormat: string;
    appName: string;
    onClose: () => void;
    onThemeChange: (theme: string) => void;
    onOverlayFormatChange: (format: string) => void;
    onAppNameChange: (name: string) => void;
    onResetLayout: () => void;
}

export function SettingsModal(props: SettingsModalProps): VNode {
    const { isVisible, currentTheme, overlayFormat, appName, onClose, onThemeChange, onOverlayFormatChange, onAppNameChange, onResetLayout } = props;

    return (
        <div 
            class={{ 'modal-overlay': true, active: isVisible }}
            on={{ click: onClose }}
        >
            <div 
                class={{ 'shortcuts-dialog': true }}
                on={{ click: (e: MouseEvent) => e.stopPropagation() }}
            >
                <h2>Application Settings</h2>
                <div class={{ 'shortcut-row': true }}>
                    <span class={{ 'shortcut-desc': true }}>Version</span>
                    <span style={{ marginLeft: '1em', color: 'var(--text-muted)' }}>{APP_VERSION}</span>
                </div>
                <div class={{ 'shortcut-row': true }}>
                    <span class={{ 'shortcut-desc': true }}>Build Date</span>
                    <span style={{ marginLeft: '1em', color: 'var(--text-muted)' }}>{BUILD_DATE}</span>
                </div>
                <div class={{ 'shortcut-row': true }}>
                    <span class={{ 'shortcut-desc': true }}>Application Name</span>
                    <input
                        type="text"
                        props={{ value: appName }}
                        style={{ background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px', flex: '1', marginLeft: '1em' }}
                        on={{ change: (e: Event) => onAppNameChange((e.target as HTMLInputElement).value) }}
                    />
                </div>
                <div class={{ 'shortcut-row': true }}>
                    <span class={{ 'shortcut-desc': true }}>UI Theme</span>
                    <select
                        style={{ background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px' }}
                        on={{ change: (e: Event) => onThemeChange((e.target as HTMLSelectElement).value) }}
                    >
                        {Object.keys(themes).map(name => (
                            <option
                                value={name}
                                props={{ selected: currentTheme === name }}
                            >
                                {name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                            </option>
                        ))}
                    </select>
                </div>
                <div class={{ 'shortcut-row': true }}>
                    <span class={{ 'shortcut-desc': true }}>Loupe Overlay Format</span>
                    <input
                        type="text"
                        props={{ value: overlayFormat }}
                        style={{ background: 'var(--bg-input)', color: 'var(--text-input)', border: '1px solid var(--border-light)', padding: '0.2em 0.5em', borderRadius: '4px', flex: '1', marginLeft: '1em' }}
                        on={{ change: (e: Event) => onOverlayFormatChange((e.target as HTMLInputElement).value) }}
                    />
                </div>
                <div style={{ marginTop: '1em', fontSize: '0.75em', color: 'var(--text-muted)' }}>
                    Variables: {'{Filename}'}, {'{Takendate}'}, {'{Takentime}'}, {'{MD:Any Metadata Tag}'}
                </div>
                <div style={{ borderTop: '1px solid var(--border-light)', margin: '1em 0', paddingTop: '1em' }}>
                    <button
                        style={{ width: '100%', padding: '8px', cursor: 'pointer', background: '#8b0000', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
                        on={{ click: () => { if (confirm('Are you sure you want to reset the layout to default?')) onResetLayout(); } }}
                    >
                        Reset Layout
                    </button>
                </div>
                <div style={{ marginTop: '20px', textAlign: 'right' }}>
                    <button
                        style={{ padding: '5px 15px', cursor: 'pointer', background: 'var(--border-light)', color: 'var(--text-bright)', border: 'none', borderRadius: '4px' }}
                        on={{ click: onClose }}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
