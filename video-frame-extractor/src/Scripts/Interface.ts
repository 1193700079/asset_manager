import type { SaveFrameRecord } from "./SaveFrame";

/**
 * Lifecycle of the per-frame "save to cloud" action. The same VideoQueueStorage
 * entry is mutated through these states as the upload progresses.
 */
export type SaveFrameStatus =
    | "idle"        // never attempted
    | "uploading"   // multipart upload in flight
    | "generating"  // upload done, waiting for Kimi to caption (server-blocking)
    | "saved"       // success, `saveResult` is populated
    | "error";      // failure, `saveError` is populated

export interface VideoQueueStorage {
    blob: Blob,
    name: string,
    duration: number,
    /** MIME-aligned format hint (`jpeg` | `png` | `webp`). */
    format?: string,
    /** Pixel width of the captured frame. */
    width?: number,
    /** Pixel height of the captured frame. */
    height?: number,
    /** Cloud-save state machine. Defaults to `idle` when missing. */
    saveStatus?: SaveFrameStatus,
    /** Server response after a successful save. */
    saveResult?: SaveFrameRecord,
    /** Human-readable error from the last failed save attempt. */
    saveError?: string,
}

export interface OpenSourceLicense {
    type: "mit" | "bsd3",
    author: string
}

export interface QueueProp {
    description: string,
    id: string,
    progress: number,
    max: number
}
