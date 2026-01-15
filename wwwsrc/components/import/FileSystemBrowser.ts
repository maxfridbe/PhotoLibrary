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
        const indent = (depth * 1.2) + 'em';
        const isSelected = props.selectedPath === node.path;
        
        return h('div', [
            h('div.fs-row', {
                style: { 
                    padding: `0.2em 0.5em 0.2em ${indent}`, 
                    cursor: 'pointer', 
                    display: 'flex', 
                    alignItems: 'center', 
                    background: isSelected ? 'var(--accent)' : 'transparent', 
                    color: isSelected ? 'var(--text-bright)' : 'var(--text-main)' 
                },
                on: { 
                    click: (e: MouseEvent) => { e.stopPropagation(); props.onSelect(node.path); }
                }
            }, [
                h('span', {
                    style: { width: '1.2em', textAlign: 'center', cursor: 'pointer', userSelect: 'none', marginRight: '0.2em' },
                    on: { click: (e: MouseEvent) => { e.stopPropagation(); props.onToggle(node); } }
                }, node.isLoading ? '\u231B' : (node.children ? (node.isExpanded ? '\u25BE' : '\u25B8') : '\u2022')), // Hourglass, Down, Right, Bullet
                h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, node.name)
            ]),
            (node.isExpanded && node.children) ? h('div', node.children.map(c => renderNode(c, depth + 1))) : null
        ]);
    };

    return h('div.fs-browser', { 
        style: { 
            overflowY: 'auto', 
            height: '300px', 
            border: '1px solid var(--border-main)', 
            background: 'var(--bg-panel-alt)',
            borderRadius: '4px',
            padding: '0.5em',
            fontFamily: 'Segoe UI, sans-serif',
            fontSize: '0.9em'
        } 
    }, props.roots.map(r => renderNode(r, 0)));
}
