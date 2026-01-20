// Generated from PhotoLibrary.Contracts/Requests.cs via Roslyn at 2026-01-20T08:57:18.7118871-06:00
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
    tag?: string | null;
    value?: string | null;
    query?: string | null;
}

export interface CollectionAddRequest {
    collectionId: string;
    fileIds: string[];
}

export interface ZipRequest {
    fileIds: string[];
    type: string;
    name?: string | null;
}

export interface SettingRequest {
    key: string;
    value: string;
}

export interface ImportBatchRequest {
    rootPath: string;
    relativePaths: string[];
    generateLow: boolean;
    generateMedium: boolean;
}

export interface GenerateThumbnailsRequest {
    rootId: string;
    recursive: boolean;
}

export interface FolderAnnotationRequest {
    folderId: string;
    annotation: string;
    color?: string | null;
}

export interface ForceUpdatePreviewRequest {
    id: string;
}

export interface PagedPhotosRequest {
    limit?: number | null;
    offset?: number | null;
    rootId?: string | null;
    pickedOnly?: boolean | null;
    rating?: number | null;
    specificIds?: string[] | null;
    stacked?: boolean | null;
}

export interface ImageRequest {
    requestId: number;
    fileId: string;
    size: number;
    priority: number;
}

