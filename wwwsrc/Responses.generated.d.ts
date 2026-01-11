// Generated from Responses.cs via Roslyn at 2026-01-11T13:34:40.3553390-06:00

export interface PhotoResponse {
    id: string;
    rootPathId: string;
    fileName: string;
    size: number;
    createdAt: string;
    modifiedAt: string;
    isPicked: boolean;
    rating: number;
}

export interface PagedPhotosResponse {
    photos: PhotoResponse[];
    total: number;
}

export interface MetadataItemResponse {
    directory: string;
    tag: string;
    value: string;
}

export interface RootPathResponse {
    id: string;
    parentId: string;
    name: string;
}

export interface CollectionResponse {
    id: string;
    name: string;
    count: number;
}

export interface StatsResponse {
    pickedCount: number;
    ratingCounts: number[];
}

