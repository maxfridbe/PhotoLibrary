import { h } from '../../snabbdom-setup.js';
export function TreeItem(props) {
    return h('div.tree-item', {
        class: { selected: props.isSelected },
        dataset: { type: props.typeAttr },
        on: {
            click: props.onClick,
            contextmenu: (e) => {
                if (props.onContextMenu) {
                    props.onContextMenu(e);
                }
            }
        }
    }, [
        h('span', props.icon ? [typeof props.icon === 'string' ? h('span', props.icon + ' ') : props.icon, props.text] : props.text),
        props.count !== undefined && props.count > 0
            ? h('span.count', props.count.toString())
            : null
    ]);
}
