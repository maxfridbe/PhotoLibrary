import { h, VNode } from '../../snabbdom-setup.js';

export interface FSNode {
    path: string;
    name: string;
    isExpanded: boolean;
    children?: FSNode[];
    isLoading?: boolean;
}

export interface FileSystemBrowserProps {
    roots: FSNode[];
    onToggle: (node: FSNode) => void;
    onSelect: (path: string) => void;
    selectedPath: string;
}

export function FileSystemBrowser(props: FileSystemBrowserProps): VNode {
    const renderNode = (node: FSNode, depth: number): VNode => {
        const indent = (depth * 1.5) + 'em';
        const isSelected = props.selectedPath === node.path;
        
        // Match the look of LibraryLocations.ts
        return h('div', [
            h('div.fs-row', {
                style: { 
                    padding: `0.4em 1em 0.4em ${indent}`, 
                    borderBottom: '1px solid var(--border-dim)', 
                    cursor: 'pointer', 
                    fontSize: '0.9em',
                    display: 'flex',
                    alignItems: 'center',
                    background: isSelected ? 'var(--highlight-color)' : 'transparent',
                    color: isSelected ? 'var(--text-bright)' : 'var(--text-main)'
                },
                on: { 
                    click: (e: MouseEvent) => { e.stopPropagation(); props.onSelect(node.path); }
                }
            }, [
                h('span', {
                    style: { width: '1em', textAlign: 'center', cursor: 'pointer', userSelect: 'none', marginRight: '0.5em', color: 'var(--text-muted)' },
                    on: { click: (e: MouseEvent) => { e.stopPropagation(); props.onToggle(node); } }
                }, node.isLoading ? '\u231B' : (node.children !== null ? (node.isExpanded ? '\u25BE' : '\u25B8') : '')),
                
                h('span', { style: { marginRight: '0.5em', color: isSelected ? 'var(--text-bright)' : 'var(--accent)' } }, '\uD83D\uDCC1'), // Folder Icon
                
                h('span', { style: { flex: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, node.name)
            ]),
            (node.isExpanded && node.children) ? h('div', node.children.map(c => renderNode(c, depth + 1))) : null
        ]);
    };

    return h('div.fs-browser', { 
        style: { 
            overflowY: 'auto', 
            height: '350px', 
            border: '1px solid var(--border-main)', 
            background: 'var(--bg-panel-alt)',
            borderRadius: '4px',
            fontFamily: 'Segoe UI, sans-serif'
        } 
    }, props.roots.map(r => renderNode(r, 1)));
}