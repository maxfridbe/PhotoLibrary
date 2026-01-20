import { h } from '../../snabbdom-setup.js';
export function NotificationManager(props) {
    const { notifications } = props;
    return h('div#notifications', {
        style: {
            position: 'fixed', bottom: '2em', right: '2em', zIndex: '100000',
            display: 'flex', flexDirection: 'column', gap: '0.5em', pointerEvents: 'none'
        }
    }, notifications.map(n => h('div', {
        key: n.id,
        style: {
            padding: '0.8em 1.5em', borderRadius: '4px', color: '#fff', fontSize: '0.9em',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)', pointerEvents: 'auto', minWidth: '200px',
            transition: 'all 0.3s ease', opacity: '1', transform: 'translateY(0)',
            background: n.type === 'error' ? '#d32f2f' : (n.type === 'success' ? '#388e3c' : '#333')
        }
    }, n.message)));
}
