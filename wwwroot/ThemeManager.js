import { themes } from './themes.js';
import { post } from './CommunicationManager.js';
export class ThemeManager {
    constructor() {
        this.currentTheme = 'dark';
        this.overlayFormat = '{Filename}\n{Takendate}\n{Takentime}';
        this.loadSettings();
    }
    async loadSettings() {
        try {
            const resTheme = await post('/api/settings/get', { key: 'ui-theme' });
            if (resTheme && resTheme.value && themes[resTheme.value]) {
                this.currentTheme = resTheme.value;
                this.applyTheme();
                this.populateThemesDropdown();
            }
            const resOverlay = await post('/api/settings/get', { key: 'loupe-overlay-format' });
            if (resOverlay && resOverlay.value) {
                this.overlayFormat = resOverlay.value;
                const input = document.getElementById('overlay-format-input');
                if (input)
                    input.value = this.overlayFormat;
            }
        }
        catch (e) {
            console.error("Failed to load settings", e);
        }
    }
    async setTheme(themeName) {
        if (!themes[themeName])
            return;
        this.currentTheme = themeName;
        this.applyTheme();
        try {
            await post('/api/settings/set', { key: 'ui-theme', value: themeName });
        }
        catch (e) {
            console.error("Failed to save theme setting", e);
        }
    }
    async setOverlayFormat(format) {
        this.overlayFormat = format;
        try {
            await post('/api/settings/set', { key: 'loupe-overlay-format', value: format });
        }
        catch (e) {
            console.error("Failed to save overlay format", e);
        }
    }
    applyTheme() {
        const root = document.documentElement;
        const theme = themes[this.currentTheme] || themes['dark'];
        Object.entries(theme).forEach(([key, value]) => {
            root.style.setProperty(`--${key}`, value);
        });
    }
    populateThemesDropdown() {
        const select = document.getElementById('theme-select');
        if (!select)
            return;
        select.innerHTML = '';
        Object.keys(themes).forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            if (name === this.currentTheme)
                opt.selected = true;
            select.appendChild(opt);
        });
    }
    getCurrentTheme() { return this.currentTheme; }
    getOverlayFormat() { return this.overlayFormat; }
}
