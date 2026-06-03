import { useEffect, useMemo, useRef, useState } from "react"
import Card from "./Card";
import type { QueueProp, SaveFrameStatus, VideoQueueStorage } from "../Scripts/Interface";
import type { VideoAnnotationResult } from "../Scripts/AnalyzeVideo";
import ZipOptionsCallback from "./ZipOptionsCallback";
import DownloadContent from "../Scripts/DownloadContent";
import ImageButton from "./ImageButton";
import { lang } from "../Scripts/Translations";
import saveFrame from "../Scripts/SaveFrame";


interface Props {
    /**
     * The list of images in the exportation list
     */
    queueFiles: VideoQueueStorage[],
    /**
     * The callback to update the exportation list state
     */
    updateQueueFiles: React.Dispatch<React.SetStateAction<VideoQueueStorage[]>>,
    /**
     * The function to call so that the main video will play from that specific frame
     * @param time the timestamp in seconds of the clicked frame
     */
    callback: (time: number) => void,
    /**
     * The File that is being used
     */
    video: File,
    /**
     * The function to update the operation list state, so that the user can track the progress of this zip file.
     */
    updateOperationList: React.Dispatch<React.SetStateAction<QueueProp[]>>,
    /**
     * Server-side path of the source video, sent as `videoPath` to /api/frames/save.
     */
    videoPath: string,
    /** AI-extracted key frames to display in the list alongside manually-added frames. */
    aiFrames?: VideoAnnotationResult[],
    /** Callback to seek the video to a specific timestamp (used for AI frames). */
    onSeekToTimestamp?: (timestamp: number) => void,
}

/**
 * Format a timestamp in seconds into mm:ss.f (one decimal of a second).
 * Used to display AI key-frame timestamps in a compact, scannable form.
 */
function formatTimestamp(t: number): string {
    if (!Number.isFinite(t) || t < 0) return "--:--";
    const minutes = Math.floor(t / 60);
    const seconds = t - minutes * 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = seconds.toFixed(1).padStart(4, "0");
    return `${mm}:${ss}`;
}

/**
 * Patch a single entry of the queue (matched by reference-stable `name`+`duration`),
 * applying `patch` while leaving the rest of the list untouched. Avoids races between
 * concurrent uploads of different rows.
 */
function patchEntry(
    update: React.Dispatch<React.SetStateAction<VideoQueueStorage[]>>,
    matcher: (item: VideoQueueStorage) => boolean,
    patch: Partial<VideoQueueStorage>,
) {
    update(prev => prev.map(item => matcher(item) ? { ...item, ...patch } : item));
}

const STATUS_LABEL: Record<SaveFrameStatus, string> = {
    idle: "Save to cloud",
    uploading: "Uploading…",
    generating: "AI captioning…",
    saved: "Saved",
    error: "Retry",
};

/**
 * A button that, if clicked, shows the list of all the frames that have been added to the exportation list.
 * @returns the VideoQueue ReactNode
 */
export default function VideoQueue({ queueFiles, callback, video, updateQueueFiles, updateOperationList, videoPath, aiFrames, onSeekToTimestamp }: Props) {
    const [isVideoQueueOpened, openVideoQueue] = useState<boolean>(false);
    const [isDownloadInProgress, updateDownload] = useState<boolean>(false);
    /** Rows for which the AI result panel is currently expanded.
     *  AI frames default to expanded so prompt is immediately visible. */
    const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

    // Auto-expand all AI rows so prompt is visible without clicking
    const aiFrameList = aiFrames ?? [];
    useEffect(() => {
        if (aiFrameList.length === 0) return;
        setExpandedRows(prev => {
            const next = new Set(prev);
            let changed = false;
            for (const f of aiFrameList) {
                const key = `ai::${f.id}`;
                if (!next.has(key)) { next.add(key); changed = true; }
            }
            return changed ? next : prev;
        });
    }, [aiFrames]);
    /**
     * If, at the end of the download, all the images should be removed from the exportation list
     */
    const removeImageQueue = useRef(true);
    const dialogRef = useRef<HTMLDivElement>(null);
    const tableDiv = useRef<HTMLDivElement>(null);
    /**
     * The settings to download the
     */
    const downloadDiv = useRef<HTMLDivElement>(null);

    async function closeDialog() {
        if (dialogRef.current) {
            await opacityFadeOutTransition(dialogRef.current)
            openVideoQueue(false);
            updateDownload(false);
        }
    }
    async function opacityFadeOutTransition(item: HTMLElement) {
        item.style.opacity = "0";
        await new Promise(res => setTimeout(res, 210));
    }
    async function opacityFadeInTransition(item: HTMLElement) {
        setTimeout(() => item.style.opacity = "1", 25)
    }
    const [zipFileOptions, updateZipFileOptions] = useState({
        downloadType: "zip",
        useServiceWorker: true
    });
    const [optionsDisabled, updateOptionsDisabled] = useState(false);
    useEffect(() => {
        isVideoQueueOpened && dialogRef.current && opacityFadeInTransition(dialogRef.current);
    }, [isVideoQueueOpened]);
    useEffect(() => {
        isDownloadInProgress && downloadDiv.current && opacityFadeInTransition(downloadDiv.current);
    }, [isDownloadInProgress])

    /**
     * Run the cloud-save lifecycle for a single row. Status transitions:
     *   idle → uploading → generating → saved
     *                           ↘ error (with `saveError` populated)
     */
    async function uploadRow(target: VideoQueueStorage) {
        const matcher = (item: VideoQueueStorage) =>
            item.name === target.name && item.duration === target.duration && item.blob === target.blob;
        patchEntry(updateQueueFiles, matcher, { saveStatus: "uploading", saveError: undefined });
        // We deliberately flip to "generating" right after fetch resolves the
        // upload phase. Since the backend keeps the connection open while Kimi
        // generates the caption, we approximate the boundary with a microtask
        // delay so the UI shows the user *something* moves before the long wait.
        const flipToGenerating = setTimeout(() => {
            patchEntry(updateQueueFiles, matcher, { saveStatus: "generating" });
        }, 400);
        try {
            const width = target.width ?? 0;
            const height = target.height ?? 0;
            const format = (target.format ?? "jpeg");
            const result = await saveFrame(target.blob, {
                videoPath,
                videoName: video.name,
                timestamp: target.duration,
                format,
                width,
                height,
            });
            clearTimeout(flipToGenerating);
            patchEntry(updateQueueFiles, matcher, {
                saveStatus: "saved",
                saveResult: result.data,
                saveError: undefined,
            });
            // Auto-expand the AI panel so the freshly-generated caption is visible.
            setExpandedRows(prev => {
                const next = new Set(prev);
                next.add(rowKey(target));
                return next;
            });
        } catch (err) {
            clearTimeout(flipToGenerating);
            const message = err instanceof Error ? err.message : String(err);
            patchEntry(updateQueueFiles, matcher, { saveStatus: "error", saveError: message });
        }
    }

    /** Stable identity for a row across re-renders (object refs may be replaced by patchEntry). */
    function rowKey(item: VideoQueueStorage) {
        return `${item.name}::${item.duration}`;
    }

    function toggleExpanded(item: VideoQueueStorage) {
        const key = rowKey(item);
        setExpandedRows(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    }

    /** Counts used to gate the bulk-save button and report progress in the toolbar. */
    const saveSummary = useMemo(() => {
        let pending = 0, saved = 0, busy = 0, errored = 0;
        for (const item of queueFiles) {
            const s = item.saveStatus ?? "idle";
            if (s === "saved") saved++;
            else if (s === "uploading" || s === "generating") busy++;
            else if (s === "error") errored++;
            else pending++;
        }
        return { pending, saved, busy, errored };
    }, [queueFiles]);

    async function saveAllPending() {
        // Run sequentially: backend blocks on Kimi per request and parallel calls
        // would only stack server-side latency without speeding anything up.
        for (const item of queueFiles) {
            const status = item.saveStatus ?? "idle";
            if (status === "saved" || status === "uploading" || status === "generating") continue;
            await uploadRow(item);
        }
    }

    const totalCount = aiFrameList.length + queueFiles.length;

    async function seekToAiFrame(timestamp: number) {
        await closeDialog();
        if (onSeekToTimestamp) onSeekToTimestamp(timestamp);
        else callback(timestamp);
    }

    function toggleAiExpanded(id: number) {
        const key = `ai::${id}`;
        setExpandedRows(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    }

    return <>
        <ImageButton img="imageMultiple" onClick={() => openVideoQueue(true)}>
            {totalCount > 0
                ? `${lang("View frames list")} (${totalCount})`
                : lang("View frames list")}
        </ImageButton>
        {isVideoQueueOpened && <>
            <div className="dialog" ref={dialogRef}>
                <Card>
                    <div style={{ height: "100%", overflow: "auto" }}>
                        <h2>{lang("Frames list:")}</h2>
                        <div className="flex gap mainFlex mainMiniFlex">
                            {!isDownloadInProgress && <ImageButton img="download" onClick={async () => {
                                if (tableDiv.current) await opacityFadeOutTransition(tableDiv.current);
                                updateDownload(true);
                            }}>{lang("Download everything")}</ImageButton>}
                            {!isDownloadInProgress && <ImageButton img="save" disabled={saveSummary.pending + saveSummary.errored === 0 || saveSummary.busy > 0} onClick={() => saveAllPending()}>
                                {saveSummary.busy > 0
                                    ? `${lang("Saving")} (${saveSummary.saved + saveSummary.busy}/${queueFiles.length})`
                                    : `${lang("Save all to cloud")} (${saveSummary.pending + saveSummary.errored})`}
                            </ImageButton>}
                            <ImageButton img="dismiss" onClick={() => closeDialog()}>Close</ImageButton>
                        </div><br></br>
                        {isDownloadInProgress ? <div ref={downloadDiv}>
                            <Card secondLevel={true}>
                                <h3>{lang("Download settings:")}</h3>
                                <ZipOptionsCallback disabled={optionsDisabled} callback={(callback) => {
                                    updateZipFileOptions(prev => { return { ...prev, ...callback } });
                                }}></ZipOptionsCallback><br></br>
                                <label className="flex hcenter gap">
                                    <input type="checkbox" defaultChecked={removeImageQueue.current} onChange={(e) => (removeImageQueue.current = e.target.checked)}></input>
                                    {lang("Remove images from list after download")}
                                </label>
                            </Card>
                            <br></br>
                            <ImageButton disabled={optionsDisabled} img="download" onClick={async () => {
                                updateOptionsDisabled(true);
                                const zipFileName = `${video.name.substring(0, video.name.lastIndexOf("."))} - Queue [${Date.now()}].zip`;
                                const zipOptions = { ...zipFileOptions };
                                const zipDownload = new DownloadContent(zipOptions.downloadType === "zip" ? zipOptions.useServiceWorker ? "zipstream" : "zipblob" : zipOptions.downloadType === "share" ? "share" : "link", zipFileName);
                                updateOperationList(prev => [...prev, { // Add the current download to the operation list
                                    id: zipDownload.operationId,
                                    description: lang(`Downloading frame list`),
                                    max: queueFiles.length,
                                    progress: 0
                                }])
                                for (const file of queueFiles) {
                                    await zipDownload.downloadFile({ filename: file.name, content: file.blob }); // Download the file, or add it to the zip file
                                    updateOperationList(prev => { // Update the operation progress
                                        const entry = prev.findIndex(item => item.id === zipDownload.operationId);
                                        prev[entry].progress++;
                                        return [...prev];
                                    });
                                }
                                await zipDownload.releaseFile(zipFileName); // Download the zip file if requested by the user
                                removeImageQueue.current && updateQueueFiles([]); // Remove the images frmo the list
                                updateOptionsDisabled(false);
                                updateOperationList(prev => { // Delete the current operation from the list
                                    const entry = prev.findIndex(item => item.id === zipDownload.operationId);
                                    prev.splice(entry, 1);
                                    return [...prev];
                                })
                                await closeDialog();
                            }}>{lang("Download list")}</ImageButton>
                        </div> : <div className="opacity" ref={tableDiv}>
                            <p>{lang("Click the image to remove it. Click the file name to download the local copy. Click the timestamp to seek the video. Click 'Save to cloud' to push the frame to the server and let AI describe it.")}</p>
                            {aiFrameList.length > 0 && <div className="aiFramesSection">
                                <div className="aiFramesHeader">
                                    <span className="aiFramesHeader__badge">🤖 AI</span>
                                    <span className="aiFramesHeader__title">{lang("AI Key Frames")} ({aiFrameList.length})</span>
                                    <span className="aiFramesHeader__hint">{lang("Auto-extracted & annotated. Click timestamp to seek.")}</span>
                                </div>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>{lang("Image:")}</th>
                                            <th>{lang("File name:")}</th>
                                            <th>{lang("Timestamp:")}</th>
                                            <th>{lang("Cloud:")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {aiFrameList.map(frame => {
                                            const expanded = expandedRows.has(`ai::${frame.id}`);
                                            return <AiFrameRow
                                                key={`AiFrame-${frame.id}`}
                                                frame={frame}
                                                expanded={expanded}
                                                onSeek={() => seekToAiFrame(frame.timestamp)}
                                                onToggle={() => toggleAiExpanded(frame.id)}
                                            />
                                        })}
                                    </tbody>
                                </table>
                            </div>}
                            {queueFiles.length > 0 && aiFrameList.length > 0 && <div className="aiFramesHeader aiFramesHeader--manual">
                                <span className="aiFramesHeader__badge aiFramesHeader__badge--manual">✋</span>
                                <span className="aiFramesHeader__title">{lang("Manual Frames")} ({queueFiles.length})</span>
                            </div>}
                            <div>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>{lang("Image:")}</th>
                                            <th>{lang("File name:")}</th>
                                            <th>{lang("Timestamp:")}</th>
                                            <th>{lang("Cloud:")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {queueFiles.map((item, i) => {
                                            const objectUrl = URL.createObjectURL(item.blob);
                                            const status: SaveFrameStatus = item.saveStatus ?? "idle";
                                            const expanded = expandedRows.has(rowKey(item));
                                            const isBusy = status === "uploading" || status === "generating";
                                            return <FrameRow
                                                key={`PreviewImage-${item.name}-${item.duration}`}
                                                item={item}
                                                index={i}
                                                objectUrl={objectUrl}
                                                status={status}
                                                expanded={expanded}
                                                isBusy={isBusy}
                                                onDelete={() => updateQueueFiles(prev => {
                                                    prev.splice(i, 1);
                                                    return [...prev];
                                                })}
                                                onSeek={async () => {
                                                    await closeDialog();
                                                    callback(item.duration);
                                                }}
                                                onSave={() => uploadRow(item)}
                                                onToggle={() => toggleExpanded(item)}
                                            />
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>}
                    </div>
                </Card>
            </div>
        </>}
    </>
}

interface FrameRowProps {
    item: VideoQueueStorage;
    index: number;
    objectUrl: string;
    status: SaveFrameStatus;
    expanded: boolean;
    isBusy: boolean;
    onDelete: () => void;
    onSeek: () => void;
    onSave: () => void;
    onToggle: () => void;
}

/**
 * Single row of the queue table plus its (optional) AI inspector panel rendered
 * as a second `<tr>` so the panel spans the full width of the table.
 */
function FrameRow({ item, objectUrl, status, expanded, isBusy, onDelete, onSeek, onSave, onToggle }: FrameRowProps) {
    return <>
        <tr className={`frameRow frameRow--${status}`}>
            <td>
                <div className="frameThumbWrap">
                    <img onClick={onDelete} className="previewImg" src={objectUrl} loading="lazy" alt={item.name} />
                    {status === "saved" && <span className="cloudBadge" title={lang("Saved to cloud")}>✓</span>}
                </div>
            </td>
            <td>
                <a href={objectUrl} target="_blank" download={item.name}>{item.name}</a>
            </td>
            <td>
                <span style={{ textDecoration: "underline", cursor: "pointer" }} onClick={onSeek}>{item.duration}</span>
            </td>
            <td>
                <CloudCell
                    status={status}
                    expanded={expanded}
                    hasResult={!!item.saveResult}
                    saveError={item.saveError}
                    onSave={onSave}
                    onToggle={onToggle}
                    isBusy={isBusy}
                />
            </td>
        </tr>
        {expanded && item.saveResult && (
            <tr className="aiPanelRow">
                <td colSpan={4}>
                    <AiResultPanel record={item.saveResult} />
                </td>
            </tr>
        )}
    </>
}

interface CloudCellProps {
    status: SaveFrameStatus;
    expanded: boolean;
    hasResult: boolean;
    saveError?: string;
    isBusy: boolean;
    onSave: () => void;
    onToggle: () => void;
}

function CloudCell({ status, expanded, hasResult, saveError, isBusy, onSave, onToggle }: CloudCellProps) {
    return <div className="cloudCell">
        <button
            className={`cloudBtn cloudBtn--${status}`}
            onClick={onSave}
            disabled={isBusy}
            title={saveError ?? STATUS_LABEL[status]}
        >
            <span className="cloudBtn__icon" aria-hidden="true">
                {status === "uploading" || status === "generating" ? <span className="cloudSpinner" /> :
                    status === "saved" ? "✓" :
                        status === "error" ? "!" : "☁"}
            </span>
            <span className="cloudBtn__label">{STATUS_LABEL[status]}</span>
        </button>
        {hasResult && (
            <button className="cloudLink" onClick={onToggle}>
                {expanded ? lang("Hide AI") : lang("View AI")}
            </button>
        )}
        {status === "error" && saveError && (
            <span className="cloudErr" title={saveError}>{truncate(saveError, 60)}</span>
        )}
    </div>
}

function truncate(s: string, n: number) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

interface AiFrameRowProps {
    frame: VideoAnnotationResult;
    expanded: boolean;
    onSeek: () => void;
    onToggle: () => void;
}

/**
 * Read-only row representing an AI-extracted key frame. Image source is the
 * server-side `oss_url` (no blob), deletion is disabled, and the cloud cell is
 * locked to a confirmed "✓ AI" state since these rows are inherently saved.
 */
function AiFrameRow({ frame, expanded, onSeek, onToggle }: AiFrameRowProps) {
    const fileName = frame.description && frame.description.trim().length > 0
        ? frame.description
        : `AI Frame @${frame.timestamp.toFixed(1)}s`;
    return <>
        <tr className="frameRow frameRow--ai">
            <td>
                <div className="frameThumbWrap">
                    <img
                        className="previewImg previewImg--ai"
                        src={frame.oss_url}
                        loading="lazy"
                        alt={fileName}
                        onClick={onToggle}
                        title={lang("Toggle AI details")}
                    />
                    <span className="cloudBadge cloudBadge--ai" title={lang("AI key frame")}>🤖</span>
                </div>
            </td>
            <td>
                <div className="aiFrameName">
                    <span className="aiFrameName__chip">AI</span>
                    <span className="aiFrameName__text" title={fileName}>{truncate(fileName, 80)}</span>
                </div>
            </td>
            <td>
                <span
                    className="aiTimestamp"
                    style={{ textDecoration: "underline", cursor: "pointer" }}
                    onClick={onSeek}
                    title={lang("Seek video to this frame")}
                >
                    {formatTimestamp(frame.timestamp)}
                </span>
            </td>
            <td>
                <div className="cloudCell">
                    <button className="cloudBtn cloudBtn--saved" disabled title={lang("Saved on server")}>
                        <span className="cloudBtn__icon" aria-hidden="true">✓</span>
                        <span className="cloudBtn__label">✓ AI</span>
                    </button>
                    <button className="cloudLink" onClick={onToggle}>
                        {expanded ? lang("Hide AI") : lang("View AI")}
                    </button>
                </div>
            </td>
        </tr>
        {expanded && (
            <tr className="aiPanelRow">
                <td colSpan={4}>
                    <AiResultPanel record={frame} />
                </td>
            </tr>
        )}
    </>
}

interface AiResultPanelProps {
    record: NonNullable<VideoQueueStorage["saveResult"]> | VideoAnnotationResult;
}

/**
 * Structured AI inspector. Shows description, pose (bilingual), style, tags and
 * the generated text-to-image prompt in a collapsible block.
 */
function AiResultPanel({ record }: AiResultPanelProps) {
    const [copied, setCopied] = useState<string | null>(null);
    const tags = Array.isArray(record.tags) ? record.tags : [];

    async function copyText(text: string, label: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(label);
            setTimeout(() => setCopied(null), 1500);
        } catch { /* noop */ }
    }

    // VideoAnnotationResult may carry video_prompt / i2v_prompt; SaveFrameRecord does not.
    const videoPrompt = "video_prompt" in record ? (record as any).video_prompt as string | null : null;
    const i2vPrompt = "i2v_prompt" in record ? (record as any).i2v_prompt as string | null : null;

    return <div className="aiPanel">
        <div className="aiPanel__head">
            <div className="aiPanel__lead">
                <span className="aiPanel__kicker">AI INSPECTOR</span>
                {record.style && <span className="aiPanel__style">{record.style}</span>}
            </div>
            {record.oss_url && (
                <a className="aiPanel__oss" href={record.oss_url} target="_blank" rel="noreferrer">
                    {lang("Open on OSS ↗")}
                </a>
            )}
        </div>

        {record.description && (
            <div className="aiField">
                <div className="aiField__label">{lang("Description")}</div>
                <p className="aiField__body">{record.description}</p>
            </div>
        )}

        {(record.pose || record.pose_en) && (
            <div className="aiField">
                <div className="aiField__label">{lang("Pose")}</div>
                <div className="aiPose">
                    {record.pose && <span className="aiPose__cn">{record.pose}</span>}
                    {record.pose_en && <span className="aiPose__en">{record.pose_en}</span>}
                </div>
            </div>
        )}

        {tags.length > 0 && (
            <div className="aiField">
                <div className="aiField__label">{lang("Tags")}</div>
                <div className="aiTags">
                    {tags.map((t, idx) => <span key={`${t}-${idx}`} className="aiTag">{t}</span>)}
                </div>
            </div>
        )}

        {record.prompt && (
            <div className="aiField">
                <div className="aiField__label aiField__label--row">
                    <span>{lang("Prompt")}</span>
                    <button className="aiGhostBtn" onClick={() => copyText(record.prompt!, "prompt")}>{copied === "prompt" ? lang("Copied!") : lang("Copy")}</button>
                </div>
                <pre className="aiPrompt">{record.prompt}</pre>
            </div>
        )}

        {videoPrompt && (
            <div className="aiField">
                <div className="aiField__label aiField__label--row">
                    <span>{lang("Prompt")} (text-to-video)</span>
                    <button className="aiGhostBtn" onClick={() => copyText(videoPrompt, "video")}>{copied === "video" ? lang("Copied!") : lang("Copy")}</button>
                </div>
                <pre className="aiPrompt">{videoPrompt}</pre>
            </div>
        )}

        {i2vPrompt && (
            <div className="aiField">
                <div className="aiField__label aiField__label--row">
                    <span>{lang("Prompt")} (image-to-video)</span>
                    <button className="aiGhostBtn" onClick={() => copyText(i2vPrompt, "i2v")}>{copied === "i2v" ? lang("Copied!") : lang("Copy")}</button>
                </div>
                <pre className="aiPrompt">{i2vPrompt}</pre>
            </div>
        )}

        <div className="aiMeta">
            <span>#{record.id}</span>
            <span>{record.format?.toUpperCase()}</span>
            {record.width && record.height && <span>{record.width}×{record.height}</span>}
            <span>t = {record.timestamp.toFixed(2)}s</span>
            <span>{new Date(record.created_at).toLocaleString()}</span>
        </div>
    </div>
}
