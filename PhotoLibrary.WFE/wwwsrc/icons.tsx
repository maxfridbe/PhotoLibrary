/** @jsx jsx */
import { jsx, VNode } from './snabbdom-setup.js';

export const CollectionIcon: VNode = (
    <svg 
        attrs={{ 
            width: 16, 
            height: 16, 
            viewBox: "0 0 64 64", 
            fill: "currentColor" 
        }}
        style={{
            display: 'inline-block',
            verticalAlign: 'middle',
            marginRight: '6px',
            color: 'var(--accent)'
        }}
    >
        <rect attrs={{ x: 10, y: 10, width: 20, height: 20, rx: 3 }} />
        <rect attrs={{ x: 34, y: 10, width: 20, height: 20, rx: 3, opacity: 0.8 }} />
        <rect attrs={{ x: 10, y: 34, width: 20, height: 20, rx: 3, opacity: 0.8 }} />
        <rect attrs={{ x: 34, y: 34, width: 20, height: 20, rx: 3, opacity: 0.6 }} />
    </svg>
);

export const AppIcon: VNode = (
    <svg
        attrs={{
            width: 64,
            height: 64,
            viewBox: "0 0 64 64",
            fill: "none"
        }}
        style={{
            display: 'inline-block',
            verticalAlign: 'middle',
        }}
    >
        <circle attrs={{ cx: 32, cy: 32, r: 28, fill: 'var(--accent)' }} />
        <circle attrs={{ cx: 32, cy: 32, r: 12, stroke: 'white', 'stroke-width': 4 }} />
        <path attrs={{ d: "M32 10 L32 20 M32 44 L32 54 M10 32 L20 32 M44 32 L54 32", stroke: 'white', 'stroke-width': 4, 'stroke-linecap': 'round' }} />
    </svg>
);
