import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';

export interface FolderTreeProps {
    roots: Res.RootPathResponse[];
    selectedRootId: string | null;
    expandedFolders: Set<string>;
    folderProgress: Map<string, { processed: number, total: number, thumbnailed?: number }>;
    onFolderClick: (rootId: string) => void;
    onFolderToggle: (rootId: string, expanded: boolean) => void;
    onFolderContextMenu: (e: MouseEvent, rootId: string) => void;
    onAnnotationSave: (rootId: string, annotation: string, color?: string) => void;
    onCancelTask: (rootId: string) => void;
}

interface FolderTreeNode {
    node: Res.RootPathResponse;
    children: FolderTreeNode[];
}

export function FolderTree(props: FolderTreeProps): VNode {
    const { roots, selectedRootId, expandedFolders, folderProgress } = props;

    // Build tree
    const map = new Map<string, FolderTreeNode>();
    roots.forEach(r => map.set(r.id, { node: r, children: [] }));
    
    const rootNodes: FolderTreeNode[] = [];
    roots.forEach(r => { 
        if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(map.get(r.id)!); 
        else rootNodes.push(map.get(r.id)!); 
    });

    const renderNode = (item: FolderTreeNode): VNode => {
        const isExpanded = expandedFolders.has(item.node.id);
        const isSelected = selectedRootId === item.node.id;
        const prog = folderProgress.get(item.node.id);

        const renderProgress = () => {
            if (!prog || prog.total === 0) return null;
            const thumbnailed = prog.thumbnailed !== undefined ? prog.thumbnailed : prog.processed;
            if (thumbnailed >= prog.total) return null;

            const notThumbnailed = prog.total - thumbnailed;
            const rawPercent = ((thumbnailed - notThumbnailed) / prog.total) * 100;
            const displayPercent = Math.max(0, Math.round(rawPercent));

            return h('div', { style: { display: 'flex', alignItems: 'center' } }, [
                h('div', { 
                    style: { width: '60px', height: '8px', background: 'var(--bg-input)', border: '1px solid var(--border-light)', borderRadius: '4px', overflow: 'hidden', margin: '0 0.5em', position: 'relative' },
                    attrs: { title: `Thumbnailed: ${thumbnailed}, Remaining: ${notThumbnailed}, Total: ${prog.total}` }
                }, [
                    h('div', { style: { width: `${displayPercent}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s ease' } })
                ]),
                h('span.cancel-task', { 
                    style: { cursor: 'pointer', padding: '0 4px', color: 'var(--text-muted)', fontSize: '1.2em', lineHeight: '1' },
                    attrs: { title: 'Cancel' },
                    on: { click: (e: MouseEvent) => { e.stopPropagation(); props.onCancelTask(item.node.id); } }
                }, '\u00D7')
            ]);
        };

        const contrastColor = (hexcolor: string) => {
            const hex = hexcolor.replace('#', '');
            const r = parseInt(hex.substr(0, 2), 16);
            const g = parseInt(hex.substr(2, 2), 16);
            const b = parseInt(hex.substr(4, 2), 16);
            const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
            return (yiq >= 128) ? '#000000' : '#ffffff';
        };

        return h('div.folder-group', { key: item.node.id }, [
            h('div.tree-item', {
                class: { selected: isSelected },
                on: {
                    click: () => props.onFolderClick(item.node.id),
                    contextmenu: (e: MouseEvent) => { e.preventDefault(); props.onFolderContextMenu(e, item.node.id); }
                }
            }, [
                h('span.tree-item-prefix', [
                    h('span.annotation-icon', {
                        props: { innerHTML: '&#128172;' },
                        on: { click: (e: MouseEvent) => { 
                            e.stopPropagation(); 
                            const pill = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement;
                            if (pill) {
                                pill.classList.add('has-content');
                                pill.focus();
                            }
                        } }
                    }),
                    h('span.annotation-pill', {
                        class: { 'has-content': !!item.node.annotation },
                        style: item.node.color ? { backgroundColor: item.node.color, color: contrastColor(item.node.color) } : {},
                        attrs: { contenteditable: 'true' },
                        props: { textContent: item.node.annotation || '' },
                        on: {
                            blur: (e: any) => {
                                const val = e.target.textContent.trim().split(/\s+/).slice(0, 3).join(' ');
                                props.onAnnotationSave(item.node.id, val);
                            },
                            keydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } },
                            click: (e: MouseEvent) => e.stopPropagation(),
                            contextmenu: (e: MouseEvent) => {
                                e.preventDefault(); e.stopPropagation();
                                const input = document.createElement('input');
                                input.type = 'color';
                                input.value = item.node.color || '#00bcd4';
                                input.onchange = () => props.onAnnotationSave(item.node.id, item.node.annotation || '', input.value);
                                input.click();
                            }
                        }
                    }),
                    h('span', {
                        style: { width: '1.2em', display: 'inline-block', textAlign: 'center', cursor: 'pointer' },
                        on: { click: (e: MouseEvent) => { e.stopPropagation(); props.onFolderToggle(item.node.id, !isExpanded); } }
                    }, item.children.length > 0 ? (isExpanded ? '\u25BE' : '\u25B8') : '\u00A0'),
                ]),
                h('span.tree-name', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' } }, item.node.name!),
                renderProgress(),
                h('span.count', item.node.imageCount > 0 ? item.node.imageCount.toString() : '')
            ]),
            h('div.tree-children', {
                style: { paddingLeft: '1em', display: isExpanded ? 'block' : 'none' }
            }, item.children.map(renderNode))
        ]);
    };

    return h('div.tree-folder-root', rootNodes.map(renderNode));
}
