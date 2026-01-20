import { themes } from './themes.js';
import { post } from './CommunicationManager.js';
import * as Api from './Functions.generated.js';

export class ThemeManager {
    private currentTheme = 'dark';
    private overlayFormat = '{Filename}\n{Takendate}\n{Takentime}';
    private appName = 'Photo Library';

    constructor() {
        this.loadSettings();
    }

    async loadSettings() {
        try {
            const resTheme = await Api.api_settings_get({ name: 'ui-theme' });
            if (resTheme && resTheme.value && themes[resTheme.value]) {
                this.currentTheme = resTheme.value;
                this.applyTheme();
                this.populateThemesDropdown();
            }

            const resOverlay = await Api.api_settings_get({ name: 'loupe-overlay-format' });
            if (resOverlay && resOverlay.value) {
                this.overlayFormat = resOverlay.value;
                const input = document.getElementById('overlay-format-input') as HTMLInputElement;
                if (input) input.value = this.overlayFormat;
            }

            const resAppName = await Api.api_settings_get({ name: 'app-name' });
            if (resAppName && resAppName.value) {
                this.appName = resAppName.value;
                this.updateAppTitle();
            }
        } catch (e) { console.error("Failed to load settings", e); }
    }

    // REQ-WFE-00003
    async setTheme(themeName: string) {
        if (!themes[themeName]) return;
        this.currentTheme = themeName;
        this.applyTheme();
        try {
            await Api.api_settings_set({ key: 'ui-theme', value: themeName });
        } catch (e) { console.error("Failed to save theme setting", e); }
    }

    async setOverlayFormat(format: string) {
        this.overlayFormat = format;
        try {
            await Api.api_settings_set({ key: 'loupe-overlay-format', value: format });
        } catch (e) { console.error("Failed to save overlay format", e); }
    }

    async setAppName(name: string) {
        this.appName = name;
        this.updateAppTitle();
        try {
            await Api.api_settings_set({ key: 'app-name', value: name });
        } catch (e) { console.error("Failed to save app name", e); }
    }

    public updateAppTitle() {
        const logo = document.querySelector('.lr-logo') as HTMLElement;
        if (logo) {
            // Keep the SVG and settings trigger, update text
            const svg = logo.querySelector('svg');
            const trigger = logo.querySelector('.settings-trigger');
            
            // Re-apply logo container styles
            logo.style.position = 'relative';
            logo.style.zIndex = '1000';

            // Re-apply SVG styles
            if (svg) {
                svg.setAttribute('width', '48');
                svg.setAttribute('height', '48');
                svg.style.position = 'absolute';
                svg.style.top = '-10px';
                svg.style.left = '0';
                svg.style.marginRight = '0.5em';
            }

            // Clear and rebuild to be safe
            logo.innerHTML = '';
            if (svg) logo.appendChild(svg);
            
            const textSpan = document.createElement('span');
            textSpan.style.marginLeft = '56px';

            // Check if name has 'Library' to bold it, just a nice touch, or just plain text
            if (this.appName.toLowerCase().includes('library')) {
                const parts = this.appName.split(/(library)/i);
                parts.forEach(p => {
                    if (p.toLowerCase() === 'library') {
                        const b = document.createElement('b');
                        b.textContent = p;
                        textSpan.appendChild(b);
                    } else {
                        textSpan.appendChild(document.createTextNode(p));
                    }
                });
            } else {
                textSpan.appendChild(document.createTextNode(this.appName));
            }
            
            logo.appendChild(textSpan);
            if (trigger) logo.appendChild(trigger);
        }
        document.title = this.appName;
    }

    public applyTheme() {
        const root = document.documentElement;
        const theme = themes[this.currentTheme] || themes['dark'];
        Object.entries(theme).forEach(([key, value]) => {
            root.style.setProperty(`--${key}`, value as string);
        });
    }

    public populateThemesDropdown() {
        const select = document.getElementById('theme-select') as HTMLSelectElement;
        if (!select) return;
        select.innerHTML = '';
        Object.keys(themes).forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            if (name === this.currentTheme) opt.selected = true;
            select.appendChild(opt);
        });
    }

    public getCurrentTheme() { return this.currentTheme; }
    public getOverlayFormat() { return this.overlayFormat; }
    public getAppName() { return this.appName; }
}