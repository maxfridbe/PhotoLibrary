// Generated from Responses.cs via Roslyn at 2026-01-12T11:42:37.1117021-06:00
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

export interface PhotoResponse {
    id: string;
    rootPathId?: string;
    fileName?: string;
    size: number;
    createdAt: string;
    modifiedAt: string;
    isPicked: boolean;
    rating: number;
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
    parentId?: string;
    path: string;
    imageCount: number;
}

export interface LibraryInfoResponse {
    totalImages: number;
    dbSize: number;
    previewDbSize: number;
    dbPath: string;
    folders: LibraryFolderResponse[];
}

