import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';
import { AppVNodeData } from '../../types.js';

export interface FolderTreeProps {
    roots: Res.DirectoryNodeResponse[];
    selectedRootId: string | null;
    expandedFolders: Set<string>;
    folderProgress: Map<string, { processed: number, total: number, thumbnailed?: number }>;
    onFolderClick: (rootId: string) => void;
    onFolderToggle: (rootId: string, expanded: boolean) => void;
    onFolderContextMenu: (e: MouseEvent, rootId: string) => void;
    onAnnotationSave: (rootId: string, annotation: string, color?: string) => void;
    onCancelTask: (rootId: string) => void;
}

export function FolderTree(props: FolderTreeProps): VNode {
    const { roots, selectedRootId, expandedFolders, folderProgress } = props;

    const renderNode = (node: Res.DirectoryNodeResponse): VNode => {
        const isExpanded = expandedFolders.has(node.id);
        const isSelected = selectedRootId === node.id;
        const prog = folderProgress.get(node.id);

        const contrastColor = (hexcolor: string) => {
            const hex = hexcolor.replace('#', '');
            const r = parseInt(hex.substr(0, 2), 16);
            const g = parseInt(hex.substr(2, 2), 16);
            const b = parseInt(hex.substr(4, 2), 16);
            const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
            return (yiq >= 128) ? '#000000' : '#ffffff';
        };

        const renderCountOrProgress = () => {
            const prog = folderProgress.get(node.id);
            let total = node.imageCount;
            let thumbnailed = node.thumbnailedCount;
            let isActive = false;

            if (prog) {
                total = prog.total;
                thumbnailed = prog.thumbnailed !== undefined ? prog.thumbnailed : prog.processed;
                isActive = thumbnailed < total;
            }
            
            if (total <= 0) return h('span.count', { style: { marginLeft: 'auto' } }, '');

            // If fully thumbnailed, show just the count (standard text), "way it was last commit"
            if (thumbnailed >= total) {
                return h('span.count', { 
                    style: { marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.85em' },
                    attrs: { title: `Total Images: ${total}` }
                }, total.toString());
            }

            const percent = Math.min(100, Math.max(0, (thumbnailed / total) * 100));
            
            return h('div', { style: { display: 'flex', alignItems: 'center', marginLeft: 'auto' } }, [
                isActive ? h('span.cancel-task', { 
                    style: { cursor: 'pointer', padding: '0 4px', color: 'var(--text-muted)', fontSize: '1.2em', lineHeight: '1', marginRight: '4px' },
                    attrs: { title: 'Cancel Thumbnail Generation' },
                    on: { click: (e: MouseEvent) => { e.stopPropagation(); props.onCancelTask(node.id); } }
                }, '\u00D7') : null,
                h('div.count-pill', {
                    style: {
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minWidth: '2.5em',
                        padding: '1px 8px',
                        borderRadius: '10px',
                        background: 'var(--bg-input)', 
                        overflow: 'hidden',
                        fontSize: '0.85em',
                        border: '1px solid var(--border-light)',
                        color: 'var(--text-main)',
                        height: '1.4em'
                    },
                    attrs: { title: `Thumbnailed: ${thumbnailed} / ${total}` }
                }, [
                    h('div', {
                        style: {
                            position: 'absolute',
                            left: '0', top: '0', bottom: '0',
                            width: `${percent}%`,
                            background: 'var(--accent, #4caf50)',
                            opacity: '0.3', 
                            transition: 'width 0.3s ease',
                            pointerEvents: 'none'
                        }
                    }),
                    h('span', { style: { position: 'relative', zIndex: '1', lineHeight: '1.2' } }, total.toString())
                ])
            ]);
        };

        return h('div.folder-group', { key: node.id }, [
            h('div.tree-item', {
                attrs: { id: `folder-item-${node.id}` },
                class: { selected: isSelected },
                hook: {
                    insert: (vnode) => {
                        if (isSelected) (vnode.elm as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    },
                    update: (old, vnode) => {
                        const wasSelected = (old.data as AppVNodeData | undefined)?.class?.selected;
                        if (isSelected && !wasSelected) {
                            (vnode.elm as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    }
                },
                on: {
                    click: () => props.onFolderClick(node.id),
                    contextmenu: (e: MouseEvent) => { e.preventDefault(); props.onFolderContextMenu(e, node.id); }
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
                        class: { 'has-content': !!node.annotation },
                        style: node.color ? { backgroundColor: node.color, color: contrastColor(node.color) } : {},
                        attrs: { contenteditable: 'true' },
                        props: { textContent: node.annotation || '' },
                        on: {
                            blur: (e: any) => {
                                const val = e.target.textContent.trim().split(/\s+/).slice(0, 3).join(' ');
                                props.onAnnotationSave(node.id, val);
                            },
                            keydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } },
                            click: (e: MouseEvent) => e.stopPropagation(),
                            contextmenu: (e: MouseEvent) => {
                                e.preventDefault(); e.stopPropagation();
                                const input = document.createElement('input');
                                input.type = 'color';
                                input.value = node.color || '#00bcd4';
                                input.onchange = () => props.onAnnotationSave(node.id, node.annotation || '', input.value);
                                input.click();
                            }
                        }
                    }),
                    h('span', {
                        style: { width: '1.2em', display: 'inline-block', textAlign: 'center', cursor: 'pointer', fontSize: '1.3em' },
                        on: { click: (e: MouseEvent) => { e.stopPropagation(); props.onFolderToggle(node.id, !isExpanded); } }
                    }, node.children && node.children.length > 0 ? (isExpanded ? '\u25BE' : '\u25B8') : '\u00A0'),
                ]),
                h('span.tree-name', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' }, attrs: { title: node.path } }, node.name!),
                renderCountOrProgress()
            ]),
            h('div.tree-children', {
                style: { paddingLeft: '1em', display: isExpanded ? 'block' : 'none' }
            }, node.children ? node.children.map(renderNode) : [])
        ]);
    };

    return h('div.tree-folder-root', roots.map(renderNode));
}
