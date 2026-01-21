import { VNodeData } from './lib/snabbdom/vnode.js';
import { Props } from './lib/snabbdom/modules/props.js';
import * as Res from './Responses.generated.js';

export interface LoupeViewProps {
    photo: Res.PhotoResponse | null;
    rotation: number;
    overlayText: string;
    imageUrlCache: Map<string, string>;
    isVisible: boolean;
    onRotate: (fileEntryId: string, rotation: number) => void;
}

export interface LoupeLogic {
    updateProps: (props: LoupeViewProps) => void;
    destroy: () => void;
}

export interface AppHTMLElement extends HTMLElement {
    _loupeLogic?: LoupeLogic;
}

export interface AppVNodeData<VNodeProps = Props> extends VNodeData<VNodeProps> {
    class?: {
        [key: string]: boolean;
    };
}
