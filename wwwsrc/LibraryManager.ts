declare var GoldenLayout: any;

import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { server, post } from './CommunicationManager.js';

interface ScanResultItem {
    path: string;
    status: 'pending' | 'indexed';
}

export class LibraryManager {
    public libraryLayout: any;
    private scanResults: ScanResultItem[] = [];
    private infoCache: Res.LibraryInfoResponse | null = null;
    private isIndexing = false;

    constructor() {
        hub.sub('photo.imported', (data) => {
            const item = this.scanResults.find(r => data.path.endsWith(r.path));
            if (item) {
                item.status = 'indexed';
                this.renderFoundFiles();
                this.updateProgressBar();
            }
        });

        hub.sub('library.updated', () => {
            this.isIndexing = false;
            this.loadLibraryInfo();
            this.renderImportControls();
            document.title = 'Photo Library';
        });
    }

    public initLayout(containerId: string, triggerScanCallback: () => void) {
        const config = {
            settings: { showPopoutIcon: false },
            content: [{
                type: 'row',
                content: [
                    {
                        type: 'component',
                        componentName: 'stats',
                        title: 'Stats',
                        width: 25
                    },
                    {
                        type: 'column',
                        width: 75,
                        content: [
                            { type: 'component', componentName: 'scan', title: 'Scan for New Files', height: 40 },
                            { type: 'component', componentName: 'foundFiles', title: 'Found Files & Import' }
                        ]
                    }
                ]
            }]
        };
        
        const container = document.getElementById(containerId);
        if (!container) return;

        this.libraryLayout = new GoldenLayout(config, container);
        const self = this;
        
        this.libraryLayout.registerComponent('stats', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component lib-pane';
            el.style.padding = '1em';
            el.style.overflow = 'hidden';
            el.innerHTML = `
                <h3 style="margin-top:0">Library Statistics</h3>
                <div id="lib-stats-content">Loading...</div>
            `;
            container.getElement().append(el);
            setTimeout(() => { if (self.infoCache) self.renderStats(self.infoCache); }, 50);
        });

        this.libraryLayout.registerComponent('scan', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component lib-pane';
            el.style.padding = '1em';
            el.style.overflowY = 'auto';
            el.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 1em; width: 100%; box-sizing: border-box;">
                    <h3 style="margin-top:0">Find New Images</h3>
                    <div style="display: flex; gap: 0.5em; width: 100%;">
                        <input type="text" id="scan-path-input" placeholder="Path to scan..." style="flex: 1; background: var(--bg-input); color: var(--text-input); border: 1px solid var(--border-light); padding: 0.5em; border-radius: 4px; min-width: 0;">
                        <button id="find-files-btn" style="padding: 0.5em 1em; background: var(--bg-active); color: var(--text-bright); border: 1px solid var(--border-light); border-radius: 4px; cursor: pointer; white-space: nowrap;">FIND NEW</button>
                    </div>
                    <div style="flex: 1; min-height: 0; display: flex; flex-direction: column;">
                        <h4 style="margin: 0.5em 0">Quick Select: Registered Folders</h4>
                        <div id="folders-content" style="flex: 1; overflow-y: auto; border: 1px solid var(--border-main); padding: 0.5em; border-radius: 4px; background: var(--bg-input); min-height: 100px;"></div>
                    </div>
                </div>
            `;
            container.getElement().append(el);
            
            el.querySelector('#find-files-btn')!.addEventListener('click', () => self.findNewFiles());
            
            setTimeout(() => { 
                if (self.infoCache) {
                    self.renderFolders(self.infoCache);
                    const input = document.getElementById('scan-path-input') as HTMLInputElement;
                    if (input && !input.value && self.infoCache.folders.length > 0) {
                        input.value = self.infoCache.folders[0].path;
                    }
                }
            }, 50);
        });

        this.libraryLayout.registerComponent('foundFiles', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component lib-pane';
            el.style.padding = '1em';
            el.style.display = 'flex';
            el.style.flexDirection = 'column';
            el.style.gap = '1em';
            el.innerHTML = `
                <div style="flex: 1; min-height: 0; display: flex; flex-direction: column;">
                    <h3 style="margin-top:0">New Files Ready for Import</h3>
                    <div id="found-files-content" style="flex: 1; overflow-y: auto; font-family: monospace; font-size: 0.85em; color: var(--text-muted); border: 1px solid var(--border-main); padding: 0.5em; border-radius: 4px; background: var(--bg-input);"></div>
                </div>
                <div id="import-controls-container" style="flex-shrink: 0; padding-top: 1em; border-top: 1px solid var(--border-main);">
                    <!-- Content injected by renderImportControls -->
                </div>
            `;
            container.getElement().append(el);
            setTimeout(() => self.renderImportControls(triggerScanCallback), 50);
        });

        this.libraryLayout.init();
        setTimeout(() => { if (this.libraryLayout) this.libraryLayout.updateSize(); }, 100);
    }

    private renderImportControls(callback?: () => void) {
        const container = document.getElementById('import-controls-container');
        if (!container) return;

        if (this.isIndexing) {
            const indexedCount = this.scanResults.filter(r => r.status === 'indexed').length;
            const total = this.scanResults.length;
            const percent = total > 0 ? (indexedCount / total) * 100 : 0;

            container.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 0.5em;">
                    <div style="display: flex; justify-content: space-between; font-size: 0.9em;">
                        <span>Indexing Photos...</span>
                        <span>${indexedCount} / ${total}</span>
                    </div>
                    <div style="width: 100%; height: 1.5em; background: var(--bg-input); border-radius: 4px; overflow: hidden; border: 1px solid var(--border-light);">
                        <div id="import-progress-bar" style="width: ${percent}%; height: 100%; background: var(--accent); transition: width 0.3s ease;"></div>
                    </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="display: flex; align-items: center; gap: 2em; flex-wrap: wrap;">
                    <div style="display: flex; gap: 1.5em; align-items: center;">
                        <label style="display: flex; align-items: center; gap: 0.5em; cursor: pointer; font-size: 0.9em; white-space: nowrap;">
                            <input type="checkbox" id="gen-low-check" checked> Low Previews (300px)
                        </label>
                        <label style="display: flex; align-items: center; gap: 0.5em; cursor: pointer; font-size: 0.9em; white-space: nowrap;">
                            <input type="checkbox" id="gen-med-check" checked> Medium Previews (1024px)
                        </label>
                    </div>
                    <button id="start-scan-btn" style="flex: 1; padding: 0.8em; background: var(--accent); color: var(--text-bright); border: none; border-radius: 4px; cursor: pointer; font-weight: bold; min-width: 200px;">
                        INDEX EXISTING FILES
                    </button>
                </div>
            `;
            if (callback) {
                container.querySelector('#start-scan-btn')!.addEventListener('click', callback);
            }
        }
    }

    private updateProgressBar() {
        const bar = document.getElementById('import-progress-bar');
        const indexedCount = this.scanResults.filter(r => r.status === 'indexed').length;
        const total = this.scanResults.length;
        if (bar) {
            const percent = total > 0 ? (indexedCount / total) * 100 : 0;
            bar.style.width = percent + '%';
            document.title = `[${Math.round(percent)}%] Indexing - Photo Library`;
        }
        // Update text too if we find it
        const container = document.getElementById('import-controls-container');
        if (container && this.isIndexing) {
            const span = container.querySelector('span:last-child');
            if (span) span.textContent = `${indexedCount} / ${total}`;
        }
    }

    private async findNewFiles() {
        const pathInput = document.getElementById('scan-path-input') as HTMLInputElement;
        if (!pathInput) return;
        const path = pathInput.value;
        if (!path) return;
        
        const content = document.getElementById('found-files-content');
        if (content) content.innerHTML = 'Searching for files not in database...';

        try {
            const res = await post('/api/library/find-new-files', { name: path });
            if (res && res.files) {
                this.scanResults = res.files.map((f: string) => ({ path: f, status: 'pending' as const }));
                this.renderFoundFiles();
            }
        } catch (e) {
            if (content) content.innerHTML = 'Error searching path.';
        }
    }

    private renderFoundFiles() {
        const content = document.getElementById('found-files-content');
        if (!content) return;
        
        if (this.scanResults.length === 0) {
            content.innerHTML = 'No new files found (all files in this path are already indexed).';
            return;
        }

        content.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">
                <thead style="position: sticky; top: 0; background: var(--bg-input); color: var(--text-bright);">
                    <tr>
                        <th style="text-align: left; padding: 0.5em;">File Path</th>
                        <th style="text-align: right; padding: 0.5em; width: 100px;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.scanResults.map(f => `
                        <tr style="border-bottom: 1px solid var(--border-dim)">
                            <td style="padding: 0.2em 0.5em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${f.path}">${f.path}</td>
                            <td style="padding: 0.2em 0.5em; text-align: right; color: ${f.status === 'indexed' ? 'var(--accent)' : 'var(--text-muted)'}">${f.status.toUpperCase()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    public async loadLibraryInfo() {
        try {
            const info = await post('/api/library/info', {});
            if (!info) return;
            this.infoCache = info;

            this.renderStats(info);
            this.renderFolders(info);

            const input = document.getElementById('scan-path-input') as HTMLInputElement;
            if (input && !input.value && info.folders.length > 0) {
                input.value = info.folders[0].path;
            }
        } catch (e) { console.error("Failed to load library info", e); }
    }

    private renderStats(info: Res.LibraryInfoResponse) {
        const statsContent = document.getElementById('lib-stats-content');
        if (statsContent) {
            statsContent.innerHTML = `
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.5em 1em; font-size: 0.9em; width: 100%; box-sizing: border-box;">
                    <div style="color: var(--text-muted); white-space: nowrap;">Total Images:</div><div style="text-align: right; font-weight: bold; color: var(--text-bright)">${info.totalImages.toLocaleString()}</div>
                    <div style="color: var(--text-muted); white-space: nowrap;">Metadata DB:</div><div style="text-align: right; font-weight: bold; color: var(--text-bright)">${(info.dbSize / (1024 * 1024)).toFixed(2)} MB</div>
                    <div style="color: var(--text-muted); white-space: nowrap;">Preview DB:</div><div style="text-align: right; font-weight: bold; color: var(--text-bright)">${(info.previewDbSize / (1024 * 1024)).toFixed(2)} MB</div>
                </div>
            `;
        }
    }

    private renderFolders(info: Res.LibraryInfoResponse) {
        const foldersContent = document.getElementById('folders-content');
        if (!foldersContent) return;
        foldersContent.innerHTML = '';

        // Build tree
        const map = new Map<string, { node: Res.LibraryFolderResponse, children: any[] }>();
        info.folders.forEach(f => map.set(f.id, { node: f, children: [] }));
        
        const roots: any[] = [];
        info.folders.forEach(f => {
            if (f.parentId && map.has(f.parentId)) {
                map.get(f.parentId)!.children.push(map.get(f.id));
            } else {
                roots.push(map.get(f.id));
            }
        });

        const renderNode = (item: any, container: HTMLElement) => {
            const row = document.createElement('div');
            row.style.paddingTop = '0.2em';
            row.style.paddingBottom = '0.2em';
            row.style.borderBottom = '1px solid var(--border-dim)';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.cursor = 'pointer';
            row.className = 'folder-tree-row';

            const toggle = document.createElement('span');
            toggle.style.width = '1.5em';
            toggle.style.display = 'inline-block';
            toggle.style.textAlign = 'center';
            toggle.innerHTML = item.children.length > 0 ? '&#9662;' : '&nbsp;'; // Down arrow
            
            const name = document.createElement('span');
            name.style.flex = '1';
            name.style.overflow = 'hidden';
            name.style.textOverflow = 'ellipsis';
            name.style.whiteSpace = 'nowrap';
            name.textContent = item.node.path;
            name.title = item.node.path;

            const count = document.createElement('span');
            count.style.color = 'var(--text-muted)';
            count.style.fontSize = '0.85em';
            count.textContent = item.node.imageCount.toString();

            row.appendChild(toggle);
            row.appendChild(name);
            row.appendChild(count);

            container.appendChild(row);

            const childrenContainer = document.createElement('div');
            childrenContainer.style.paddingLeft = '1.2em';
            childrenContainer.style.display = 'block';
            container.appendChild(childrenContainer);

            row.onclick = (e) => {
                e.stopPropagation();
                const input = document.getElementById('scan-path-input') as HTMLInputElement;
                if (input) input.value = item.node.path;
            };

            if (item.children.length > 0) {
                toggle.onclick = (e) => {
                    e.stopPropagation();
                    if (childrenContainer.style.display === 'none') {
                        childrenContainer.style.display = 'block';
                        toggle.innerHTML = '&#9662;';
                    } else {
                        childrenContainer.style.display = 'none';
                        toggle.innerHTML = '&#9656;'; // Right arrow
                    }
                };

                item.children.forEach((c: any) => renderNode(c, childrenContainer));
            }
        };

        roots.forEach(r => renderNode(r, foldersContent));
    }

    public async triggerScan(showNotification: (msg: string, type: any) => void) {
        const pathInput = document.getElementById('scan-path-input') as HTMLInputElement;
        if (!pathInput) return;
        const path = pathInput.value;
        const low = (document.getElementById('gen-low-check') as HTMLInputElement).checked;
        const med = (document.getElementById('gen-med-check') as HTMLInputElement).checked;

        if (!path) {
            showNotification("Please provide a path to scan", "error");
            return;
        }

        if (this.scanResults.length === 0) {
            showNotification("No new files found to index. Click FIND NEW first.", "info");
            return;
        }

        this.isIndexing = true;
        this.renderImportControls();

        const res = await post('/api/library/import-batch', { 
            rootPath: path, 
            relativePaths: this.scanResults.map(r => r.path),
            generateLow: low, 
            generateMedium: med
        });
        if (res) {
            showNotification("Batch indexing started in background", "success");
        }
    }
}