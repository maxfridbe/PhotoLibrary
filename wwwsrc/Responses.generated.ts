// Generated from Responses.cs via Roslyn at 2026-01-15T14:45:54.9718214-06:00
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

export interface PhotoResponse {
    id: string;
    rootPathId?: string;
    fileName?: string;
    size: number;
    createdAt: string;
    modifiedAt: string;
    hash?: string;
    isPicked: boolean;
    rating: number;
    rotation: number;
    stackCount: number;
    stackExtensions?: string;
    stackFileIds: string[];
}

export interface PagedPhotosResponse {
    photos: PhotoResponse[];
    total: number;
}

export interface MetadataItemResponse {
    directory?: string;
    tag?: string;
    value?: string;
}

export interface RootPathResponse {
    id: string;
    parentId?: string;
    name?: string;
    imageCount: number;
    thumbnailedCount: number;
    annotation?: string;
    color?: string;
}

export interface CollectionResponse {
    id: string;
    name: string;
    count: number;
}

export interface StatsResponse {
    totalCount: number;
    pickedCount: number;
    ratingCounts: number[];
}

export interface LibraryFolderResponse {
    id: string;
    path: string;
    parentId?: string;
    imageCount: number;
    thumbnailedCount: number;
    annotation?: string;
    color?: string;
}

export interface LibraryInfoResponse {
    totalImages: number;
    dbSize: number;
    previewDbSize: number;
    dbPath: string;
    previewDbPath: string;
    configPath: string;
    isIndexing: boolean;
    indexedCount: number;
    totalToIndex: number;
    totalThumbnailedImages: number;
    folders: LibraryFolderResponse[];
}

