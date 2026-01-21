/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';

export interface TreeItemProps {
    text: string;
    count?: number;
    isSelected: boolean;
    typeAttr: string;
    onClick: () => void;
    onContextMenu?: (e: MouseEvent) => void;
    icon?: string | VNode;
}

export function TreeItem(props: TreeItemProps): VNode {
    return (
        <div 
            class={{ 'tree-item': true, selected: props.isSelected }}
            dataset={{ type: props.typeAttr }}
            on={{
                click: props.onClick,
                contextmenu: (e: MouseEvent) => {
                    if (props.onContextMenu) {
                        e.preventDefault();
                        props.onContextMenu(e);
                    }
                }
            }}
        >
            <span>
                {props.icon ? (
                    typeof props.icon === 'string' ? (
                        <span>{props.icon} </span>
                    ) : (
                        props.icon
                    )
                ) : null}
                {props.text}
            </span>
            {props.count !== undefined && props.count > 0 ? (
                <span class={{ count: true }}>{props.count.toString()}</span>
            ) : null}
        </div>
    );
}
