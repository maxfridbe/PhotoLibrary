// Generated from Requests.cs via Roslyn at 2026-01-11T19:05:23.7848700-06:00
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

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

export interface ZipRequest {
    fileIds: string[];
    type: string;
    name?: string;
}

export interface SettingRequest {
    key: string;
    value: string;
}

export interface ScanLibraryRequest {
    path: string;
    generateLow: boolean;
    generateMedium: boolean;
}

export interface PagedPhotosRequest {
    limit?: number;
    offset?: number;
    rootId?: string;
    pickedOnly?: boolean;
    rating?: number;
    specificIds?: string[];
    stacked?: boolean;
}

export interface ImageRequest {
    requestId: number;
    fileId: string;
    size: number;
}

