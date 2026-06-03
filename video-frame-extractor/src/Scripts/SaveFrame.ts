/**
 * SaveFrame.ts
 *
 * Thin client around the backend `POST /api/frames/save` endpoint. The endpoint
 * accepts a multipart payload containing the frame blob plus metadata, uploads
 * it to OSS and synchronously waits for Kimi to produce a structured caption.
 * Because that round-trip can take 5–15 seconds the caller is expected to keep
 * a `uploading` state visible in the UI for the full duration.
 */

export interface SaveFrameMetadata {
    /** Full (or VIDEOS_ROOT-relative) on-disk path of the source video. */
    videoPath: string;
    /** Display name of the video, used by the backend for OSS key + DB. */
    videoName: string;
    /** Frame timestamp inside the video, in seconds. */
    timestamp: number;
    /** Image format, mirrors the export setting. */
    format: "jpeg" | "png" | "webp" | string;
    /** Pixel width of the captured frame. */
    width: number;
    /** Pixel height of the captured frame. */
    height: number;
}

export interface SaveFrameRecord {
    id: number;
    video_path: string;
    video_name: string;
    timestamp: number;
    oss_url: string;
    oss_key: string;
    prompt: string | null;
    pose: string | null;
    pose_en: string | null;
    tags: string[];
    style: string | null;
    description: string | null;
    format: string;
    width: number | null;
    height: number | null;
    created_at: string;
}

export interface SaveFrameResponse {
    success: boolean;
    data: SaveFrameRecord;
    aiGenerated: boolean;
}

/**
 * Upload a single frame to the cloud. Throws on non-2xx responses; the caller
 * is responsible for surfacing the message to the user.
 */
export default async function saveFrame(
    frameBlob: Blob,
    metadata: SaveFrameMetadata,
    signal?: AbortSignal,
): Promise<SaveFrameResponse> {
    const formData = new FormData();
    const filename = `frame.${metadata.format === "jpeg" ? "jpg" : metadata.format}`;
    formData.append("frame", frameBlob, filename);
    formData.append("videoPath", metadata.videoPath);
    formData.append("videoName", metadata.videoName);
    formData.append("timestamp", metadata.timestamp.toString());
    formData.append("format", metadata.format);
    formData.append("width", metadata.width.toString());
    formData.append("height", metadata.height.toString());

    const response = await fetch("/api/frames/save", {
        method: "POST",
        body: formData,
        signal,
    });

    if (!response.ok) {
        let detail = response.statusText;
        try {
            const body = await response.json();
            if (body?.error) detail = body.error;
        } catch { /* swallow — keep statusText */ }
        throw new Error(`Save failed (${response.status}): ${detail}`);
    }

    return response.json() as Promise<SaveFrameResponse>;
}
