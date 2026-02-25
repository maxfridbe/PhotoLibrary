// Generated from PhotoLibrary.Contracts/Models.cs via Roslyn
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';
import * as Rpc from './Results.generated.js';

export interface GeneratedPreview {
    size: number;
    data: number[];
}

export interface ProcessedFileData {
    entry: FileEntry;
    metadata: MetadataItem[];
    previews: GeneratedPreview[];
}

export interface FileEntry {
    id: string;
    rootPathId: string;
    fileName?: string;
    baseName?: string;
    size: number;
    createdAt: string;
    modifiedAt: string;
    hash?: string;
    recordTouched: number;
}

export interface MetadataItem {
    directory?: string;
    tag?: string;
    value?: string;
}

