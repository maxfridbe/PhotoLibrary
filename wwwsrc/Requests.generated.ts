// Generated from Requests.cs via Roslyn at 2026-01-11T13:41:56.4486806-06:00

export interface IdRequest {
    id: string;
}

export interface NameRequest {
    name: string;
}

export interface PickRequest {
    id: string;
    isPicked: boolean;
}

export interface RateRequest {
    id: string;
    rating: number;
}

export interface SearchRequest {
    tag: string;
    value: string;
}

export interface CollectionAddRequest {
    collectionId: string;
    fileIds: string[];
}

export interface PagedPhotosRequest {
    limit?: number;
    offset?: number;
    rootId?: string;
    pickedOnly?: boolean;
    rating?: number;
    specificIds?: string[];
}

export interface ImageRequest {
    requestId: number;
    fileId: string;
    size: number;
}

