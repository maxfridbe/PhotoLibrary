import { init } from './lib/snabbdom/init.js';
import { classModule } from './lib/snabbdom/modules/class.js';
import { propsModule } from './lib/snabbdom/modules/props.js';
import { styleModule } from './lib/snabbdom/modules/style.js';
import { eventListenersModule } from './lib/snabbdom/modules/eventlisteners.js';
import { attributesModule } from './lib/snabbdom/modules/attributes.js';
import { datasetModule } from './lib/snabbdom/modules/dataset.js';
import { h } from './lib/snabbdom/h.js';
export const patch = init([
    classModule,
    propsModule,
    styleModule,
    eventListenersModule,
    attributesModule,
    datasetModule,
]);
export { h };
