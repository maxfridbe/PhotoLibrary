// Generated from PhotoLibrary.Contracts/Responses.cs via Roslyn
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

export interface PhotoResponse {
    fileEntryId: string;
    rootPathId?: string | null;
    fileName?: string | null;
    baseName?: string | null;
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
    directoryId: string;
    name: string;
    path: string;
    imageCount: number;
    thumbnailedCount: number;
    annotation?: string | null;
    color?: string | null;
    children: DirectoryNodeResponse[];
}

export interface CollectionResponse {
    collectionId: string;
    name: string;
    count: number;
}

export interface CollectionCreatedResponse {
    collectionId: string;
    name: string;
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

export interface ScanFileResult {
    path: string;
    dateTaken: string;
    exists: boolean;
}

export interface ValidateImportResponse {
    existingSourceFiles: string[];
}

export interface MapPhotoResponse {
    fileEntryId: string;
    fileName?: string | null;
    latitude: number;
    longitude: number;
    createdAt: string;
}

export interface PagedMapPhotoResponse {
    photos: MapPhotoResponse[];
    total: number;
}

