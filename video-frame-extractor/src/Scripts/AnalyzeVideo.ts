/**
 * AnalyzeVideo.ts
 * Client for the video-level AI annotation endpoints.
 */

export interface VideoAnnotationResult {
    id: number;
    video_path: string;
    video_name: string;
    timestamp: number;  // always -1 for video-level
    oss_url: string;
    oss_key: string;
    prompt: string | null;
    pose: string | null;
    pose_en: string | null;
    tags: string[];
    style: string | null;
    description: string | null;
    video_prompt: string | null;
    i2v_prompt: string | null;
    format: string;
    width: number | null;
    height: number | null;
    created_at: string;
    /** Segmentation metadata (NULL/undefined for short non-segmented videos). */
    segment_index?: number | null;
    segment_start?: number | null;
    segment_end?: number | null;
    /** Frame quality feedback from human reviewer. */
    feedback?: 'good' | 'bad' | null;
    feedback_note?: string | null;
    feedback_at?: string | null;
}

/**
 * A single segment annotation produced when the backend splits a long video.
 * Same shape as VideoAnnotationResult but with required segment fields.
 */
export interface SegmentAnnotation extends VideoAnnotationResult {
    segment_index: number;
    segment_start: number;
    segment_end: number;
}

export interface AnalyzeVideoResponse {
    success: boolean;
    data?: VideoAnnotationResult;
    /** True when AI determines the video has no NSFW content and recommends skipping. */
    skipped?: boolean;
    skip_reason?: string;
    /**
     * Optional frame-level annotations produced when the backend auto-extracts
     * key frames during analysis. Each entry has the same shape as the
     * video-level result but with a real (non-negative) timestamp.
     */
    frames?: VideoAnnotationResult[];
    /**
     * For long videos: the per-segment video-level annotations, ordered by
     * segment_index. Absent (or empty) when the video was analyzed as a
     * single pass.
     */
    segments?: SegmentAnnotation[];
    /** True when the backend split the video and analyzed it segment-by-segment. */
    segmented: boolean;
    aiGenerated: boolean;
    /**
     * Optional warning surfaced by the backend when frame extraction or
     * frame-level annotation runs into a non-fatal issue (e.g. partial
     * extraction). The video-level annotation is still returned in `data`.
     */
    frameWarning?: string;
}

/**
 * Trigger AI video analysis. This can take 10-30+ seconds.
 */
export async function analyzeVideo(
    videoPath: string,
    signal?: AbortSignal,
): Promise<AnalyzeVideoResponse> {
    const response = await fetch("/api/video/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath }),
        signal,
    });

    if (!response.ok) {
        let detail = response.statusText;
        try {
            const body = await response.json();
            if (body?.error) detail = body.error;
        } catch { /* keep statusText */ }
        throw new Error(`Analysis failed (${response.status}): ${detail}`);
    }

    return response.json() as Promise<AnalyzeVideoResponse>;
}

/**
 * Stream-based video analysis via Server-Sent Events.
 *
 * Calls the /api/video/analyze/stream endpoint, parses each SSE `data:` line
 * as a typed event, and forwards it to `onEvent`. Resolves with the final
 * `result` event payload (same shape as `analyzeVideo`'s return value), or
 * rejects if the server emits an `error` event or the stream closes early.
 */
export async function analyzeVideoStream(
    videoPath: string,
    onEvent: (event: { type: string;[key: string]: unknown }) => void,
    signal?: AbortSignal,
): Promise<AnalyzeVideoResponse> {
    const response = await fetch("/api/video/analyze/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath }),
        signal,
    });

    if (!response.ok) {
        let detail = response.statusText;
        try {
            const body = await response.json();
            if (body?.error) detail = body.error;
        } catch { /* keep statusText */ }
        throw new Error(`Analysis failed (${response.status}): ${detail}`);
    }

    if (!response.body) {
        throw new Error("Response body is empty; SSE not supported by this client");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: AnalyzeVideoResponse | null = null;
    let streamError: Error | null = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines; within an event, fields are
        // newline-separated. We only emit single-line `data: ...` events from
        // the server so a per-line split is sufficient.
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, "");
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (!payload) continue;
            let event: { type: string;[key: string]: unknown };
            try {
                event = JSON.parse(payload);
            } catch {
                // Malformed line, skip silently rather than aborting the stream.
                continue;
            }
            onEvent(event);
            if (event.type === "result") {
                finalResult = event as unknown as AnalyzeVideoResponse;
            } else if (event.type === "error") {
                streamError = new Error(
                    typeof event.message === "string" ? event.message : "Stream error",
                );
            }
        }
    }

    if (streamError) throw streamError;
    if (!finalResult) {
        throw new Error("Stream ended without a result event");
    }
    return finalResult;
}

/**
 * Check if a video already has an annotation.
 */
export async function getVideoAnnotation(
    videoPath: string,
): Promise<VideoAnnotationResult | null> {
    const response = await fetch(`/api/video/annotation?path=${encodeURIComponent(videoPath)}`);
    if (!response.ok) return null;
    const body = await response.json();
    return body.data || null;
}

/**
 * Fetch all previously extracted frame-level annotations (timestamp >= 0)
 * for the given video. Used by MainVideoUI to repopulate the keyframe
 * gallery when re-entering an already-annotated video.
 *
 * Reuses the generic GET /api/frames?videoPath=... endpoint and filters out
 * the video-level row (timestamp === -1) on the client to avoid mixing it
 * with real keyframes.
 */
export async function getVideoFrames(
    videoPath: string,
): Promise<VideoAnnotationResult[]> {
    const response = await fetch(
        `/api/frames?videoPath=${encodeURIComponent(videoPath)}&limit=1000`,
    );
    if (!response.ok) return [];
    const body = await response.json();
    if (!body?.success || !Array.isArray(body.data)) return [];
    return (body.data as VideoAnnotationResult[])
        .filter(f => typeof f.timestamp === "number" && f.timestamp >= 0)
        .sort((a, b) => a.timestamp - b.timestamp);
}
