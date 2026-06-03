import { useEffect, useRef, useState, useCallback } from "react"
import Card from "./Card"
import DownloadContent from "../Scripts/DownloadContent";
import ExtractVideoFrame from "../Scripts/ExtractVideoFrame";
import ZipOptionsCallback from "./ZipOptionsCallback";
import { type QueueProp, type VideoQueueStorage } from "../Scripts/Interface";
import VideoQueue from "./VideoQueue";
import ImageButton from "./ImageButton";
import { lang } from "../Scripts/Translations";
import OperationTracker from "./OperationTracker";
import { createRoot } from "react-dom/client";
import ShowOperationTracker from "./ShowOperationTracker";
import { analyzeVideoStream, getVideoAnnotation, getVideoFrames } from "../Scripts/AnalyzeVideo";
import type { VideoAnnotationResult, SegmentAnnotation } from "../Scripts/AnalyzeVideo";
import VideoAnnotation from "./VideoAnnotation";
import "./VideoAnnotation.css";

interface Props {
    /**
     * The File of the video the user has chosen
     */
    video: File,
    /**
     * The Blob URL that permits video playback.
     */
    videoBlobUrl: string,
    /**
     * Server-side path of the chosen video. Used as the `videoPath` field on
     * the cloud-save endpoint so the backend can identify the source asset.
     * Falls back to the file name for purely local picks.
     */
    videoPath: string,
    /**
     * Optional callback invoked once a video-level AI annotation has been
     * successfully persisted on the backend. Lets the parent invalidate any
     * cached "annotated paths" set (e.g. VideoBrowser tabs).
     */
    onAnnotated?: () => void
}


/**
 * Export options that can be changed without triggering a re-render.
 */
interface ExportOptions {
    /**
     * A number, from 0 to 1, that indicates the output image quality
     */
    quality: number,
    /**
     * The mimetype of the output image
     */
    outputFormat: "jpeg" | "png" | "webp",
    /**
     * If the video position should be changed when the user changes the from/to inputs in the "Interval export" section
     */
    updateFrameWhileMovingInput: boolean,
    /**
     * If a new Video object should be created for the video interval exportation
     */
    createNewVideoElement: boolean,
    /**
     * A number between 0 and 1 that indicates the percentage of the width/height of the output image compared to its original size.
     */
    resizePercentage: number,
    /**
     * The output width or height. The other value must be resized according to the source's aspect ratio.
     */
    resizeFixed: number
}

interface ExportRerenderOptions {
    /**
     * If `singleFrame` is set, only the current frame will be saved.
     * 
     * If `interval` is set, the user will be propted to choose an interval of seconds, and all the frames between them will be downloaded
     */
    exportType: "singleFrame" | "interval",
    /**
     * If the image should be resized or not
     */
    resizeImage: boolean,
    /**
     * How the image should be resized? Should we calculate it based on the `percentage`? Should the user specify a `width` or a `height`?
     */
    resizeType: "percentage" | "width" | "height",
}

/**
 * Single step in the AI analysis flow. The backend pushes the current step
 * to its in-memory `analysisProgress` map; the front-end polls it and renders
 * a checklist so the user sees what the model is doing.
 */
interface AnalysisStep {
    step: 'probing' | 'calling_ai' | 'extracting_frames' | 'saving' | 'done' | 'error' | 'skipped';
    current?: number;
    total?: number;
}

/**
 * The core of the application. Calculate the framerate of the video, and display it along with conversion options.
 * @returns the MainVideoUI ReactNode
 */
export default function MainVideoUI({ video, videoBlobUrl, videoPath, onAnnotated }: Props) {
    const [videoFrameRate, updateVideoFrameRate] = useState<number>();
    const [isVideoPaused, updateVideoPaused] = useState(false);
    const [areVideoControlsDisabled, updateVideoControlsDisabled] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [analyzeStatus, setAnalyzeStatus] = useState<string>("");
    const [analyzingProgress, setAnalyzingProgress] = useState<string | null>(null);
    const [analysisStep, setAnalysisStep] = useState<AnalysisStep | null>(null);
    const [analysisLogs, setAnalysisLogs] = useState<string[]>([]);
    const [annotation, setAnnotation] = useState<VideoAnnotationResult | null>(null);
    const [extractedFrames, setExtractedFrames] = useState<VideoAnnotationResult[]>([]);
    /** Currently selected AI frame (shown below player) */
    const [selectedAiFrame, setSelectedAiFrame] = useState<VideoAnnotationResult | null>(null);
    const [segments, setSegments] = useState<SegmentAnnotation[]>([]);
    const [segmented, setSegmented] = useState(false);
    const [frameWarning, setFrameWarning] = useState<string>("");
    const [aiModel, setAiModel] = useState<string>('kimi');
    const [aiModelName, setAiModelName] = useState<string>('kimi-k2.6');
    const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Fetch current AI model on mount
    useEffect(() => {
        fetch('/api/ai/model').then(r => r.json()).then(data => {
            if (data.model) setAiModel(data.model);
            if (data.modelName) setAiModelName(data.modelName);
        }).catch(() => { });
    }, []);

    async function handleModelChange(newModel: string) {
        setAiModel(newModel);
        try {
            const res = await fetch('/api/ai/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: newModel }),
            });
            const data = await res.json();
            if (data.modelName) setAiModelName(data.modelName);
        } catch (e) {
            console.error('Failed to switch AI model', e);
        }
    }

    /**
     * Video exportation options that don't require a re-render
     */
    const videoExportOptions = useRef<ExportOptions>({
        quality: 0.9,
        outputFormat: "jpeg",
        updateFrameWhileMovingInput: true,
        createNewVideoElement: true,
        resizePercentage: 1,
        resizeFixed: 1000
    })

    const [videoSensitiveExportOptions, updateVideoSensitiveExportOptions] = useState<ExportRerenderOptions>({
        exportType: "singleFrame",
        resizeImage: false,
        resizeType: "percentage",

    });
    const [videoIntervalOptions, updateVideoIntervalOptions] = useState({
        downloadType: "zip",
        useServiceWorker: true
    })
    /**
     * Get the suggested file name for the extracted frame
     * @param videoObject the HTMLVideoElement that'll be used to get the currentTime
     * @param exportOptions the ExportOptions Object that is being used for this conversion. If not passed, the default one will be used. Note that this is important for interval conversions, since the user might change the settings while a conversion is being made.
     * @returns a string with the suggested file name for the image
     */
    function getFileName(videoObject?: HTMLVideoElement, exportOptions = videoExportOptions.current) {
        return `${video.name.substring(0, video.name.lastIndexOf("."))}-${(videoObject ?? videoObj.current)?.currentTime.toFixed(2)}.${exportOptions.outputFormat === "jpeg" ? "jpg" : exportOptions.outputFormat}`;
    }
    /**
     * An array that contains the start and the end of the interval (for multiple frames extraction)
     */
    const videoExportInterval = useRef<[number | undefined, number | undefined]>([undefined, undefined]);
    /**
     * The main video object, the one that'll always be visible
     */
    const videoObj = useRef<HTMLVideoElement>(null);
    /**
     * The Promise that should be resolved when the frame has been rendered by the browser.
     * Note that this promise is used only by the operations that use the main video (`videoObj`) for frame exportation.
     */
    const seekedPromise = useRef<() => void>(null);
    /**
     * The videos that have been added in the exportation list
     */
    const [videoInExportationList, updateVideoInExportationList] = useState<VideoQueueStorage[]>([]);
    /**
     * The list of the ongoing conversions
     */
    const [operationList, updateOperationList] = useState<QueueProp[]>([]);
    /**
     * Resize the image if requested by the user, and obtain the video frame as a Blob
     * @param videoObject the HTMLVideoElement that should be used to extract the frame
     * @param exportOptions the ExportOptions Object that is being used for this conversion. If not passed, the default one will be used. Note that this is important for interval conversions, since the user might change the settings while a conversion is being made.
     * @param videoSensitiveOptions the ExportRerenderOptions Object that is being used for this conversion. If not passed, the default one will be used. Note that this is important for interval conversions, since the user might change the settings while a conversion is being made.
     * @returns a Blob with the current frame
     */
    function ExtractVideoWrapper(videoObject = videoObj.current ?? undefined, videoOptions = videoExportOptions.current, videoSensitiveOptions = videoSensitiveExportOptions) {
        if (!videoObject) throw new Error("Failed getting video object");
        let [width, height] = [videoObject.videoWidth, videoObject.videoHeight];
        if (videoSensitiveOptions.resizeImage) {
            switch (videoSensitiveOptions.resizeType) {
                case "percentage":
                    width *= videoOptions.resizePercentage;
                    height *= videoOptions.resizePercentage;
                    break;
                case "width":
                    width = videoOptions.resizeFixed;
                    height = width * videoObject.videoHeight / videoObject.videoWidth
                    break;
                case "height":
                    height = videoOptions.resizeFixed;
                    width = height * videoObject.videoWidth / videoObject.videoHeight
                    break;
            }
        }
        return ExtractVideoFrame({ video: videoObject ?? (videoObj.current as HTMLVideoElement), quality: videoOptions.quality, format: videoOptions.outputFormat, width, height })
    }

    useEffect(() => {
        let cancelled = false;
        // Load video-level annotation AND any previously extracted frames so
        // re-opening an already-labeled video shows the full prior result
        // (description + keyframe gallery) without re-running AI analysis.
        Promise.all([
            getVideoAnnotation(videoPath),
            getVideoFrames(videoPath),
        ]).then(([videoAnn, frames]) => {
            if (cancelled) return;
            setAnnotation(videoAnn);
            setExtractedFrames(frames);
            setFrameWarning("");
        }).catch(err => {
            if (!cancelled) console.error("Failed to load existing annotation:", err);
        });
        return () => { cancelled = true; };
    }, [videoPath]);

    function handleSeekToTimestamp(timestamp: number) {
        const video = videoObj.current;
        if (video && Number.isFinite(timestamp) && timestamp >= 0) {
            video.currentTime = timestamp;
            // Best-effort: surface the seek visually by pausing on the frame.
            try { video.pause(); } catch { /* ignore */ }
        }
        // Find and select the AI frame closest to this timestamp
        const match = extractedFrames.find(f => Math.abs(f.timestamp - timestamp) < 0.05);
        setSelectedAiFrame(match ?? null);
    }

    const stopProgressPolling = useCallback(() => {
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
        }
        setAnalyzingProgress(null);
        setAnalysisStep(null);
    }, []);

    // Cleanup progress polling on unmount or video switch
    useEffect(() => {
        return () => { stopProgressPolling(); };
    }, [videoPath, stopProgressPolling]);

    async function handleAutoLabel() {
        setAnalyzing(true);
        setAnalyzeStatus("正在分析视频...");
        setFrameWarning("");
        setAnalyzingProgress(null);
        setAnalysisStep({ step: 'probing' });
        setAnalysisLogs([]);

        // SSE pushes step + log events directly, no more polling needed.
        stopProgressPolling();

        try {
            const result = await analyzeVideoStream(videoPath, (event) => {
                if (event.type === 'step') {
                    const step = (event.step as AnalysisStep['step']) || 'calling_ai';
                    const current = typeof event.current === 'number' ? event.current : undefined;
                    const total = typeof event.total === 'number' ? event.total : undefined;
                    setAnalysisStep({ step, current, total });
                    if (total !== undefined && total > 1 && current !== undefined) {
                        setAnalyzingProgress(`正在分析第 ${current}/${total} 段...`);
                    }
                } else if (event.type === 'log') {
                    const message = typeof event.message === 'string' ? event.message : '';
                    if (message) {
                        setAnalysisLogs(prev => [...prev, message]);
                    }
                }
            });

            // Handle AI skip recommendation (video has no NSFW content)
            if (result.skipped) {
                setAnnotation(null);
                setExtractedFrames([]);
                setSegments([]);
                setSegmented(false);
                setFrameWarning("");
                setAnalyzeStatus("");
                onAnnotated?.();
                alert(`AI 建议跳过此视频：${result.skip_reason || '无 NSFW 内容'}`);
                return;
            }

            setAnnotation(result.data ?? null);
            setExtractedFrames(result.frames ?? []);
            setSegments(result.segments ?? []);
            setSegmented(result.segmented ?? false);
            setFrameWarning(result.frameWarning ?? "");
            setAnalyzeStatus("");
            // Notify the parent so cached "annotated paths" sets refresh.
            onAnnotated?.();
        } catch (err) {
            console.error("Video analysis failed:", err);
            setAnalyzeStatus("");
            alert(`AI analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setAnalyzing(false);
            setAnalyzingProgress(null);
            setAnalysisStep(null);
        }
    }

    // Skip the current video: discard any prior annotations and mark the
    // video as "skipped" so it moves into the dedicated VideoBrowser tab.
    // Reuses the same `onAnnotated` callback because the browser tabs key
    // off the same `annotationsVersion` counter.
    async function handleSkipVideo() {
        if (!videoPath) return;
        const ok = window.confirm("跳过后将丢弃该视频已有的 AI 标注，并归入“已跳过”。是否继续？");
        if (!ok) return;
        try {
            const resp = await fetch('/api/video/skip', {
                method: 'POST',
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ videoPath }),
            });
            const data = await resp.json();
            if (data?.success) {
                setAnnotation(null);
                setExtractedFrames([]);
                setSegments([]);
                setSegmented(false);
                setFrameWarning("");
                onAnnotated?.();
            } else {
                console.error('Skip rejected:', data);
                alert(`Skip failed: ${data?.error || 'unknown'}`);
            }
        } catch (err) {
            console.error('Skip failed:', err);
            alert(`Skip failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }

    useEffect(() => {
        // Browser-side framerate detection: spin up a hidden video element,
        // play it for ~2s and pick the most-frequent inter-frame delta.
        // Used as the fallback path (and for purely local files).
        function detectFramerateInBrowser() {
            setTimeout(() => {
                const video = Object.assign(document.createElement("video"), {
                    muted: true,
                    autoplay: true,
                    playsInline: true,
                    src: videoBlobUrl
                });
                video.classList.add("hideVideo");
                console.log(video)
                video.addEventListener("playing", () => {
                    /**
                     * Getting video framerate is unreliable in JavaScript.
                     * What we'll do is to ask the browser to send a callback for each frame, and we'll see how much time has passed from a frame to the other.
                     * We'll observe this for approximately two seconds, and later the greatest number of frames will be chosen.
                     */
                    let prevMediaTime = Date.now();
                    let probabilities: any = {}
                    const callback = (_: any, metadata: VideoFrameCallbackMetadata) => {
                        const frameTime = metadata.mediaTime - prevMediaTime;
                        prevMediaTime = metadata.mediaTime;
                        const result = Math.round(1 / frameTime);
                        if (!probabilities[result.toString()]) probabilities[result.toString()] = 0;
                        probabilities[result.toString()]++;
                        video.requestVideoFrameCallback(callback);
                    }
                    setTimeout(() => {
                        video.pause();
                        let currentPosition = Object.keys(probabilities)[0];
                        for (const key in probabilities) {
                            if (probabilities[key] > probabilities[currentPosition]) currentPosition = key;
                        }
                        updateVideoFrameRate(+currentPosition);
                        video.remove();
                    }, 2000);
                    video.requestVideoFrameCallback(callback);
                })
                document.body.append(video);
            }, 500)
        }

        // Remote videos (path contains "/") are served by the backend, so
        // ask ffprobe directly — avoids re-downloading the whole file just
        // to estimate fps in the browser when Cache-Control: no-store is set.
        if (videoPath && videoPath.includes("/")) {
            fetch(`/api/video/fps?path=${encodeURIComponent(videoPath)}`)
                .then(r => r.json())
                .then(data => {
                    if (data && typeof data.fps === "number" && data.fps > 0) {
                        updateVideoFrameRate(data.fps);
                    } else {
                        detectFramerateInBrowser();
                    }
                })
                .catch(() => detectFramerateInBrowser());
            return;
        }

        // Local pick (just a file name): use the browser-side probe.
        detectFramerateInBrowser();
    }, [])
    return !videoFrameRate ? <>
        <Card>
            <h2>{lang("Analyzing video framerate")}</h2>
            <p>{lang("Do not switch tabs. This should take approximately three seconds.")}</p>
        </Card>
    </> : <>
        <Card>
            <div className="flex mainFlex gap">
                <div style={{ flex: "2 0" }} key={"VideoPreviewStable"}>
                    <Card fullWidth={true} secondLevel={true}>
                        <h2>{lang("Video preview:")}</h2>
                        <div className="flex wcenter">
                            <video playsInline={true} onPlay={() => updateVideoPaused(false)} onPause={() => updateVideoPaused(true)} onSeeked={() => seekedPromise.current && seekedPromise.current()} ref={videoObj} controls autoPlay muted poster={videoPath && videoPath.includes("/") ? `/api/video/poster?path=${encodeURIComponent(videoPath)}` : undefined} src={videoBlobUrl}></video>
                        </div><br></br>
                        <div className="flex wcenter miniButton miniGap mainFlex mainMiniFlex" key={"VideoControls"} style={{ overflow: "auto" }}>
                            <ImageButton disabled={areVideoControlsDisabled} img="previousFrame" onClick={() => {
                                if (!videoObj.current) return;
                                videoObj.current.currentTime -= (1 / videoFrameRate);
                            }}>{lang("Previous frame")}</ImageButton>
                            <ImageButton disabled={areVideoControlsDisabled} img={isVideoPaused ? "play" : "pause"} onClick={() => {
                                videoObj.current?.paused ? videoObj.current.play() : videoObj.current?.pause()
                            }}>{isVideoPaused ? lang("Play") : lang("Pause")}</ImageButton>
                            <ImageButton disabled={areVideoControlsDisabled} img="nextFrame" onClick={() => {
                                if (!videoObj.current) return;
                                videoObj.current.currentTime += (1 / videoFrameRate);
                            }}>{lang("Next frame")}</ImageButton>
                        </div>
                    </Card>
                    {selectedAiFrame && (
                        <div className="selected-ai-frame-info">
                            <div className="selected-ai-frame-header">
                                <span className="selected-ai-frame-badge">
                                    <span className="selected-ai-frame-dot" aria-hidden="true" />
                                    AI Keyframe
                                </span>
                                {Number.isFinite(selectedAiFrame.timestamp) && selectedAiFrame.timestamp >= 0 && (
                                    <span className="selected-ai-frame-timestamp">
                                        {(() => {
                                            const t = selectedAiFrame.timestamp;
                                            const m = Math.floor(t / 60).toString().padStart(2, '0');
                                            const s = Math.floor(t % 60).toString().padStart(2, '0');
                                            const ms = Math.floor((t - Math.floor(t)) * 100).toString().padStart(2, '0');
                                            return `${m}:${s}.${ms}`;
                                        })()}
                                    </span>
                                )}
                                <button className="selected-ai-frame-close" onClick={() => setSelectedAiFrame(null)} title="Close" aria-label="Close info panel">✕</button>
                            </div>
                            {selectedAiFrame.description && (
                                <p className="selected-ai-frame-desc">{selectedAiFrame.description}</p>
                            )}
                            {selectedAiFrame.prompt && (
                                <div className="selected-ai-frame-section">
                                    <span className="selected-ai-frame-label">Prompt</span>
                                    <pre className="selected-ai-frame-prompt">{selectedAiFrame.prompt}</pre>
                                </div>
                            )}
                            {selectedAiFrame.video_prompt && (
                                <div className="selected-ai-frame-section">
                                    <span className="selected-ai-frame-label">Video Prompt</span>
                                    <pre className="selected-ai-frame-prompt">{selectedAiFrame.video_prompt}</pre>
                                </div>
                            )}
                            {selectedAiFrame.i2v_prompt && (
                                <div className="selected-ai-frame-section">
                                    <span className="selected-ai-frame-label">I2V Prompt</span>
                                    <pre className="selected-ai-frame-prompt">{selectedAiFrame.i2v_prompt}</pre>
                                </div>
                            )}
                            {selectedAiFrame.tags && selectedAiFrame.tags.length > 0 && (
                                <div className="selected-ai-frame-section">
                                    <span className="selected-ai-frame-label">Tags</span>
                                    <div className="selected-ai-frame-tags">
                                        {selectedAiFrame.tags.map((t, i) => <span key={i} className="selected-ai-frame-tag">{t}</span>)}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ flex: "1 0 150px" }}>
                    <Card secondLevel={true}>
                        <h2>{lang("Export frame:")}</h2>
                        <select disabled={areVideoControlsDisabled} onChange={(e) => {
                            updateVideoSensitiveExportOptions(prev => { return { ...prev, exportType: e.target.value as "singleFrame" } })
                        }}>
                            <option value={"singleFrame"}>{lang("Export single frame")}</option>
                            <option value={"interval"}>{lang("Export frame interval")}</option>
                        </select><br></br><br></br>
                        {videoSensitiveExportOptions.exportType === "singleFrame" ? <>
                            <div className="flex gap mainFlex mainMiniFlex">
                                <ImageButton onClick={async () => new DownloadContent("link").downloadFile({ filename: getFileName(), content: await ExtractVideoWrapper() })} img="saveImage">{lang("Export current frame")}</ImageButton>
                                <ImageButton img="shareios" onClick={async () => {
                                    const blob = await ExtractVideoWrapper();
                                    navigator.share({
                                        files: [new File([blob], getFileName(), { type: blob.type })]
                                    })
                                }}>{lang("Share current frame")}</ImageButton>
                                <ImageButton img="imageAdd" onClick={async () => { // Add image in the exportation list
                                    const blob = await ExtractVideoWrapper();
                                    const exportOptions = videoExportOptions.current;
                                    const sourceVideo = videoObj.current;
                                    let [width, height] = [sourceVideo?.videoWidth ?? 0, sourceVideo?.videoHeight ?? 0];
                                    if (sourceVideo && videoSensitiveExportOptions.resizeImage) {
                                        switch (videoSensitiveExportOptions.resizeType) {
                                            case "percentage":
                                                width = Math.round(width * exportOptions.resizePercentage);
                                                height = Math.round(height * exportOptions.resizePercentage);
                                                break;
                                            case "width":
                                                width = exportOptions.resizeFixed;
                                                height = Math.round(width * sourceVideo.videoHeight / sourceVideo.videoWidth);
                                                break;
                                            case "height":
                                                height = exportOptions.resizeFixed;
                                                width = Math.round(height * sourceVideo.videoWidth / sourceVideo.videoHeight);
                                                break;
                                        }
                                    }
                                    const videoQueue: VideoQueueStorage = {
                                        blob,
                                        name: getFileName(),
                                        duration: sourceVideo?.currentTime ?? 0,
                                        format: exportOptions.outputFormat,
                                        width,
                                        height,
                                        saveStatus: "idle",
                                    }
                                    updateVideoInExportationList(prev => [...prev, videoQueue]);
                                }}>
                                    {lang("Add current frame to export list")}
                                </ImageButton>
                            </div><br></br><br></br>
                            <div className="mu-action-row">
                                <button
                                    className="ai-label-btn"
                                    onClick={handleAutoLabel}
                                    disabled={analyzing}
                                    title={annotation ? "Re-analyze video with AI" : "Analyze video with AI"}
                                >
                                    {analyzing ? (
                                        <span>
                                            <span className="ai-label-spinner">⟳</span>
                                            {analyzeStatus && <span style={{ marginLeft: 8 }}>{analyzeStatus}</span>}
                                        </span>
                                    ) : annotation ? (
                                        <span>✓ AI Labeled</span>
                                    ) : (
                                        <span>🤖 AI Auto-Label</span>
                                    )}
                                </button>
                                <select
                                    className="ai-model-select"
                                    value={aiModel}
                                    onChange={e => handleModelChange(e.target.value)}
                                    disabled={analyzing}
                                    title={`Current model: ${aiModelName}`}
                                >
                                    <option value="kimi">kimi-k2.6</option>
                                    <option value="qwen">qwen3.6-plus</option>
                                </select>
                                <button
                                    className="mu-skip-btn"
                                    onClick={handleSkipVideo}
                                    disabled={analyzing}
                                    title="跳过此视频，不进行标注"
                                >
                                    <span aria-hidden="true">⏭</span>
                                    <span style={{ marginLeft: 6 }}>Skip</span>
                                </button>
                            </div>
                            {analyzing && (
                                <div className="ai-analysis-progress">
                                    <div className="ai-progress-steps">
                                        {[
                                            { key: 'probing', label: '探测视频信息' },
                                            { key: 'calling_ai', label: '调用 AI 模型分析' },
                                            { key: 'extracting_frames', label: '提取关键帧' },
                                            { key: 'saving', label: '保存标注结果' },
                                        ].map((s) => {
                                            const stepOrder = ['probing', 'calling_ai', 'extracting_frames', 'saving'];
                                            const currentIdx = analysisStep ? stepOrder.indexOf(analysisStep.step) : -1;
                                            const thisIdx = stepOrder.indexOf(s.key);
                                            const status = thisIdx < currentIdx
                                                ? 'done'
                                                : thisIdx === currentIdx
                                                    ? 'active'
                                                    : 'pending';
                                            return (
                                                <div key={s.key} className={`ai-progress-step ai-progress-step--${status}`}>
                                                    <span className="ai-progress-step-icon">
                                                        {status === 'done' ? '✓' : status === 'active' ? '⟳' : '○'}
                                                    </span>
                                                    <span className="ai-progress-step-label">{s.label}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {analysisStep && analysisStep.total !== undefined && analysisStep.total > 1 && (
                                        <div className="ai-progress-segment">
                                            正在分析第 {analysisStep.current}/{analysisStep.total} 段
                                        </div>
                                    )}
                                    {analyzeStatus && !analysisStep && (
                                        <div className="ai-label-status">{analyzeStatus}</div>
                                    )}
                                    {analysisLogs.length > 0 && (
                                        <div className="ai-progress-logs">
                                            {analysisLogs.map((log, i) => (
                                                <div key={i} className="ai-progress-log-line">
                                                    <span className="ai-progress-log-dot">›</span>
                                                    <span className="ai-progress-log-text">{log}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                            {frameWarning && !analyzing && (
                                <div className="ai-label-warning" role="alert">⚠ {frameWarning}</div>
                            )}
                            {annotation && (
                                <VideoAnnotation
                                    annotation={annotation}
                                    onReanalyze={handleAutoLabel}
                                    analyzing={analyzing}
                                    analyzingProgress={analyzingProgress}
                                    frames={extractedFrames}
                                    onSeekToFrame={handleSeekToTimestamp}
                                    segments={segments}
                                    segmented={segmented}
                                />
                            )}
                            <VideoQueue updateOperationList={updateOperationList} updateQueueFiles={updateVideoInExportationList} queueFiles={videoInExportationList} video={video} videoPath={videoPath} aiFrames={extractedFrames} onSeekToTimestamp={handleSeekToTimestamp} callback={(time) => {
                                if (videoObj.current) videoObj.current.currentTime = time;
                            }}></VideoQueue>
                        </> : <div>
                            <p>{lang("Download all frames")}</p>
                            <label className="flex hcenter gap">{lang("From")}: <input disabled={areVideoControlsDisabled} type="number" min={0} step={1 / videoFrameRate} max={videoObj.current?.duration} onChange={(e) => {
                                videoExportInterval.current[0] = +e.target.value;
                                if (videoExportOptions.current.updateFrameWhileMovingInput && videoObj.current) videoObj.current.currentTime = videoExportInterval.current[0];
                            }} defaultValue={0}></input> {lang("seconds")}</label><br></br>
                            <label className="flex hcenter gap">{lang("To")}: <input type="number" disabled={areVideoControlsDisabled} min={0} step={1 / videoFrameRate} max={videoObj.current?.duration} onChange={e => {
                                videoExportInterval.current[1] = +e.target.value;
                                if (videoExportOptions.current.updateFrameWhileMovingInput && videoObj.current) videoObj.current.currentTime = videoExportInterval.current[1];
                            }} defaultValue={videoObj.current?.duration}></input> {lang("seconds")}</label><br></br>
                            <label className="flex hcenter gap">
                                <input type="checkbox" disabled={areVideoControlsDisabled} defaultChecked={videoExportOptions.current.updateFrameWhileMovingInput} onChange={(e) => (videoExportOptions.current.updateFrameWhileMovingInput = e.target.checked)}></input>{lang("Update the video position while changing from/to seconds")}
                            </label><br></br>
                            <ZipOptionsCallback disabled={areVideoControlsDisabled} otherAdvancedOptions={
                                <label className="flex hcenter gap">
                                    <input disabled={areVideoControlsDisabled} type="checkbox" defaultChecked={videoExportOptions.current.createNewVideoElement} onChange={(e) => (videoExportOptions.current.createNewVideoElement = e.target.checked)}></input>
                                    {lang("Create a new video element for this operation. This will allow you to download multiple intervals at the same time, but it will increment RAM usage.")}
                                </label>
                            } callback={(value) => {
                                updateVideoIntervalOptions(prev => { return { ...prev, ...value } });
                            }}></ZipOptionsCallback><br></br>
                            <ImageButton disabled={areVideoControlsDisabled} img="videoclipoptimize" onClick={async () => { // Download the interval
                                /**
                                 * The Promise that'll be solved when the browser has rendered the frame
                                 */
                                let localSeekedPromise: (() => void) | null = null;
                                const createNewVideoElement = !!videoExportOptions.current.createNewVideoElement;
                                const [videoObject, isLocalVideoObject] = await new Promise<[HTMLVideoElement, boolean]>(res => {
                                    !createNewVideoElement && videoObj.current && res([videoObj.current, false]); // In this case, we'll use the main video object.
                                    const newVideo = Object.assign(document.createElement("video"), { // Create the Video element that'll be used for this operation
                                        src: videoBlobUrl,
                                        autoplay: true,
                                        muted: true,
                                        playsInline: true,
                                        onload: () => newVideo.play(),
                                        onplay: () => {
                                            newVideo.pause();
                                            res([newVideo, true]);
                                        },
                                        onseeked: () => { localSeekedPromise && localSeekedPromise() }
                                    });
                                    newVideo.classList.add("hideVideo");
                                    document.body.append(newVideo);
                                })
                                try {
                                    const [videoOptions, videoSensitiveOptions] = [{ ...videoExportOptions.current }, { ...videoSensitiveExportOptions }]; // We'll copy these two object so that, if the user changes some values, they won't alter the current interval download.
                                    !createNewVideoElement && updateVideoControlsDisabled(true); // If the main video element is being used, disable the controls so that 
                                    if (!videoExportInterval.current[0]) videoExportInterval.current[0] = 0; // The start of the interval
                                    videoObject.currentTime = videoExportInterval.current[0];
                                    let currentPosition = videoObject.currentTime;
                                    const max = videoExportInterval.current[1] ?? videoObject.duration; // The end of the interval
                                    const intervalOptions = { ...videoIntervalOptions };
                                    const zipFileName = `${video.name.substring(0, video.name.lastIndexOf("."))} [${videoExportInterval.current[0]}-${videoExportInterval.current[1]}].zip`;
                                    const downloadContent = new DownloadContent(intervalOptions.downloadType === "zip" ? intervalOptions.useServiceWorker ? "zipstream" : "zipblob" : intervalOptions.downloadType === "share" ? "share" : "link", zipFileName); // Initialize the downloader
                                    updateOperationList(prev => [...prev, { // Add this extraction to the current list
                                        id: downloadContent.operationId,
                                        description: `${lang("Extracting frame interval between")} ${currentPosition} ${lang("and")} ${max} ${lang("seconds")}`,
                                        max: (max - currentPosition) * videoFrameRate,
                                        progress: -1
                                    }]);
                                    if (localStorage.getItem("VideoFrameExtractor-ShowDocumentQueue") !== "a") { // Show the user where they can track the extraction progress
                                        const div = document.createElement("div");
                                        const root = createRoot(div);
                                        root.render(<ShowOperationTracker close={() => {
                                            root.unmount();
                                            div.remove();
                                        }}></ShowOperationTracker>)
                                        document.body.append(div);
                                    }
                                    while (currentPosition < max) { // Extract the frames
                                        videoObject.pause();
                                        await downloadContent.downloadFile({ filename: getFileName(videoObject, videoOptions), content: await ExtractVideoWrapper(videoObject, videoOptions, videoSensitiveOptions) }); // Download the file, or add it to the zip file.
                                        currentPosition += (1 / videoFrameRate);
                                        if (currentPosition < max) { // If the next frame should be extracted, let's wait that the browser renders it. 
                                            await new Promise<void>(res => {
                                                if (isLocalVideoObject) localSeekedPromise = res; else seekedPromise.current = res;
                                                videoObject.currentTime = currentPosition; // Go to the next frame
                                            })
                                        };
                                        updateOperationList(prev => { // Update the progress of the operation
                                            const entry = prev.findIndex(item => item.id === downloadContent.operationId);
                                            if (entry !== -1) prev[entry].progress++;
                                            return [...prev];
                                        })
                                    }
                                    await downloadContent.releaseFile(zipFileName); // In case of zip files, they'll be closed and downloaded
                                    videoObject.controls = true; // Show again the controls of the video object
                                    !createNewVideoElement && updateVideoControlsDisabled(false); // Enable again the components
                                    isLocalVideoObject && videoObject.remove(); // And remove the videoObject if it was created only for this extraction
                                    updateOperationList(prev => { // Delete the current extraction from the operation list.
                                        const entry = prev.findIndex(item => item.id === downloadContent.operationId);
                                        if (entry !== -1) prev.splice(entry, 1);
                                        return [...prev];
                                    })
                                } catch (ex) {
                                    videoObject.controls = true;
                                    !createNewVideoElement && updateVideoControlsDisabled(false);
                                    isLocalVideoObject && videoObject.remove();
                                }
                            }}>{lang("Export frames")}</ImageButton>
                        </div>}

                    </Card><br></br>
                    <Card secondLevel={true}>
                        <h2>{lang("Export options:")}</h2>
                        <label className="flex hcenter">
                            {lang("Output format:")}
                            <select disabled={areVideoControlsDisabled} defaultValue={videoExportOptions.current.outputFormat} onChange={e => (videoExportOptions.current.outputFormat = e.target.value as "jpeg")}>
                                <option value={"jpeg"}>JPEG</option>
                                <option value={"png"}>PNG</option>
                                {document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp") && <option value={"webp"}>WebP</option>}
                            </select>
                        </label><br></br>
                        <label>
                            {lang("Image quality (irrelevant for PNG files):")}
                            <input disabled={areVideoControlsDisabled} defaultValue={videoExportOptions.current.quality} onChange={e => (videoExportOptions.current.quality = +e.target.value)} type="range" min={0} max={1} step={0.01}></input>
                        </label><br></br>
                        <label className="flex hcenter gap">
                            <input type="checkbox" disabled={areVideoControlsDisabled} defaultChecked={videoSensitiveExportOptions.resizeImage} onChange={(e) => updateVideoSensitiveExportOptions(prev => { return { ...prev, resizeImage: e.target.checked } })}></input>
                            {lang("Resize the output image")}
                        </label><br></br>
                        {videoSensitiveExportOptions.resizeImage && <Card>
                            <h4>{lang("Resize options:")}</h4>
                            <select disabled={areVideoControlsDisabled} defaultValue={videoSensitiveExportOptions.resizeType} onChange={(e) => updateVideoSensitiveExportOptions(prev => { return { ...prev, resizeType: e.target.value as "percentage" } })}>
                                <option value={"percentage"}>{lang("Resize in percentage")}</option>
                                <option value={"width"}>{lang("Set a fixed width")}</option>
                                <option value={"height"}>{lang("Set a fixed height")}</option>
                            </select><br></br><br></br>
                            {videoSensitiveExportOptions.resizeType === "percentage" ? <label>
                                {lang("Output image width/height:")} <input disabled={areVideoControlsDisabled} type="range" min={0} max={1} step={0.01} defaultValue={videoExportOptions.current.resizePercentage} onChange={(e) => (videoExportOptions.current.resizePercentage = +e.target.value)}></input>
                            </label> : <label className="flex hcenter gap">
                                {lang(`Output ${videoSensitiveExportOptions.resizeType}`)}: <input disabled={areVideoControlsDisabled} type="number" defaultValue={videoExportOptions.current.resizeFixed} onChange={(e) => (videoExportOptions.current.resizeFixed = +e.target.value)}></input></label>}
                        </Card>}
                    </Card>
                </div>
            </div>
        </Card>
        <OperationTracker status={operationList}></OperationTracker>
    </>
}