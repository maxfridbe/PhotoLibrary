// Generated from PhotoLibrary.Contracts/Results/Results.cs via Roslyn
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';
import * as Mod from './Models.generated.js';

export interface RpcResult<T> {
    data?: T | null;
    success: boolean;
    error?: string | null;
}

export interface FileResult {
    data: number[];
}

export interface PhysicalFileResult {
    fullPath: string;
    fileName: string;
}

export interface ExportInfo {
    fullPath: string;
    rotation: number;
    isHidden: boolean;
}

