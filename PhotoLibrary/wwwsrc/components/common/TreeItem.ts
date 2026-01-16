import { h, VNode } from '../../snabbdom-setup.js';

export interface TreeItemProps {
    text: string;
    count?: number;
    isSelected: boolean;
    typeAttr: string;
    onClick: () => void;
    onContextMenu?: (e: MouseEvent) => void;
    icon?: string;
}

export function TreeItem(props: TreeItemProps): VNode {
    return h('div.tree-item', {
        class: { selected: props.isSelected },
        dataset: { type: props.typeAttr },
        on: {
            click: props.onClick,
            contextmenu: (e: MouseEvent) => {
                if (props.onContextMenu) {
                    props.onContextMenu(e);
                }
            }
        }
    }, [
        h('span', props.icon ? [h('span', props.icon + ' '), props.text] : props.text),
        props.count !== undefined && props.count > 0 
            ? h('span.count', props.count.toString()) 
            : null
    ]);
}
