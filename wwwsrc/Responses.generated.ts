// Generated from Responses.cs via Roslyn at 2026-01-15T19:35:17.7757611-06:00
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

export interface DirectoryNodeResponse {
    id: string;
    name: string;
    path: string;
    imageCount: number;
    thumbnailedCount: number;
    annotation?: string;
    color?: string;
    children: DirectoryNodeResponse[];
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
}

export interface DirectoryResponse {
    path: string;
    name: string;
}

