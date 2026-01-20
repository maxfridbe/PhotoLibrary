import { h, VNode } from './snabbdom-setup.js';

export const CollectionIcon: VNode = h('svg', { 
    attrs: { 
        width: 16, 
        height: 16, 
        viewBox: "0 0 64 64", 
        fill: "currentColor" 
    },
    style: {
        display: 'inline-block',
        verticalAlign: 'middle',
        marginRight: '6px',
        color: 'var(--accent)'
    }
}, [
	h('rect', { attrs: { x: 10, y: 10, width: 20, height: 20, rx: 3 } }),
	h('rect', { attrs: { x: 34, y: 10, width: 20, height: 20, rx: 3, opacity: 0.8 } }),
	h('rect', { attrs: { x: 10, y: 34, width: 20, height: 20, rx: 3, opacity: 0.8 } }),
	h('rect', { attrs: { x: 34, y: 34, width: 20, height: 20, rx: 3, opacity: 0.6 } })
]);

export const AppIcon: VNode = h('svg', {
    attrs: {
        width: 64,
        height: 64,
        viewBox: "0 0 64 64",
        fill: "none"
    },
    style: {
        display: 'inline-block',
        verticalAlign: 'middle',
    }
}, [
    h('circle', { attrs: { cx: 32, cy: 32, r: 28, fill: 'var(--accent)' } }),
    h('circle', { attrs: { cx: 32, cy: 32, r: 12, stroke: 'white', 'stroke-width': 4 } }),
    h('path', { attrs: { d: "M32 10 L32 20 M32 44 L32 54 M10 32 L20 32 M44 32 L54 32", stroke: 'white', 'stroke-width': 4, 'stroke-linecap': 'round' } })
]);
