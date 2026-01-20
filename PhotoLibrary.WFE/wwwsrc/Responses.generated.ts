// Generated from PhotoLibrary.Contracts/Responses.cs via Roslyn at 2026-01-20T15:41:48.9302926-06:00
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

export interface PhotoResponse {
    id: string;
    rootPathId?: string | null;
    fileName?: string | null;
    size: number;
    createdAt: string;
    modifiedAt: string;
    hash?: string | null;
    isPicked: boolean;
    rating: number;
    rotation: number;
    stackCount: number;
    stackExtensions?: string | null;
    stackFileIds: string[];
}

export interface PagedPhotosResponse {
    photos: PhotoResponse[];
    total: number;
}

export interface MetadataItemResponse {
    directory?: string | null;
    tag?: string | null;
    value?: string | null;
}

export interface MetadataGroupResponse {
    name: string;
    items: { [key: string]: string };
}

export interface DirectoryNodeResponse {
    id: string;
    name: string;
    path: string;
    imageCount: number;
    thumbnailedCount: number;
    annotation?: string | null;
    color?: string | null;
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
    backups: BackupFileResponse[];
}

export interface BackupFileResponse {
    name: string;
    date: string;
    size: number;
}

export interface DirectoryResponse {
    path: string;
    name: string;
}

export interface ApplicationSettingsResponse {
    runtimeMode: string;
    version: string;
}

