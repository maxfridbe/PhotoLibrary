// Generated from PhotoLibrary.Contracts/Requests.cs via Roslyn
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

export interface FileIdRequest {
    fileEntryId: string;
}

export interface CollectionIdRequest {
    collectionId: string;
}

export interface TaskRequest {
    taskId: string;
}

export interface NameRequest {
    name: string;
}

export interface PickRequest {
    fileEntryId: string;
    isPicked: boolean;
}

export interface RateRequest {
    fileEntryId: string;
    rating: number;
}

export interface SearchRequest {
    tag?: string | null;
    value?: string | null;
    query?: string | null;
}

export interface CollectionAddRequest {
    collectionId: string;
    fileEntryIds: string[];
}

export interface ZipRequest {
    fileEntryIds: string[];
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

export interface ImportLocalRequest {
    sourceRoot: string;
    sourceFiles: string[];
    targetRootId: string;
    directoryTemplate: string;
    generatePreview: boolean;
    preventDuplicateName: boolean;
    preventDuplicateHash: boolean;
}

export interface ValidateImportRequest {
    targetRootId: string;
    items: { [key: string]: string };
}

export interface GenerateThumbnailsRequest {
    rootId: string;
    recursive: boolean;
    force: boolean;
}

export interface FolderAnnotationRequest {
    folderId: string;
    annotation: string;
    color?: string | null;
}

export interface ForceUpdatePreviewRequest {
    fileEntryId: string;
}

export interface PagedPhotosRequest {
    limit?: number | null;
    offset?: number | null;
    rootId?: string | null;
    pickedOnly?: boolean | null;
    rating?: number | null;
    specificFileEntryIds?: string[] | null;
    stacked?: boolean | null;
}

export interface ImageRequest {
    requestId: number;
    fileEntryId: string;
    size: number;
    priority: number;
}

