// Generated from Responses.cs via Roslyn at 2026-01-11T16:50:49.8452486-06:00
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

