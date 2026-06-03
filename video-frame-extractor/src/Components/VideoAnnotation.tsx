import { useState, useCallback } from "react";
import type { VideoAnnotationResult, SegmentAnnotation } from "../Scripts/AnalyzeVideo";
import "./VideoAnnotation.css";

interface VideoAnnotationProps {
    annotation: VideoAnnotationResult;
    onReanalyze: () => void;
    analyzing: boolean;
    analyzingProgress?: string | null;
    frames?: VideoAnnotationResult[];
    onSeekToFrame?: (timestamp: number) => void;
    segments?: SegmentAnnotation[];
    segmented?: boolean;
}

function formatTimestamp(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00.0";
    const total = Math.max(0, seconds);
    const mm = Math.floor(total / 60);
    const ss = total - mm * 60;
    return `${String(mm).padStart(2, "0")}:${ss.toFixed(1).padStart(4, "0")}`;
}

/** Render the annotation fields (pose, tags, style, prompts) for a single annotation */
function AnnotationBody({ ann }: { ann: VideoAnnotationResult }) {
    const [promptExpanded, setPromptExpanded] = useState(true);
    const [videoPromptExpanded, setVideoPromptExpanded] = useState(true);
    const [i2vPromptExpanded, setI2vPromptExpanded] = useState(true);

    return (
        <div className="va-body">
            {ann.description && (
                <div className="va-section">
                    <span className="va-label">Description</span>
                    <p className="va-description">{ann.description}</p>
                </div>
            )}
            {(ann.pose || ann.pose_en) && (
                <div className="va-section">
                    <span className="va-label">Pose</span>
                    <div className="va-pills">
                        {ann.pose && <span className="va-pill">{ann.pose}</span>}
                        {ann.pose_en && <span className="va-pill">{ann.pose_en}</span>}
                    </div>
                </div>
            )}
            {ann.tags && ann.tags.length > 0 && (
                <div className="va-section">
                    <span className="va-label">Tags</span>
                    <div className="va-pills">
                        {ann.tags.map((tag, i) => (
                            <span className="va-pill" key={i}>{tag}</span>
                        ))}
                    </div>
                </div>
            )}
            {ann.style && (
                <div className="va-section">
                    <span className="va-label">Style</span>
                    <div className="va-pills">
                        <span className="va-pill va-pill-style">{ann.style}</span>
                    </div>
                </div>
            )}
            {ann.prompt && (
                <div className="va-section va-prompt-section">
                    <button className="va-prompt-toggle" onClick={() => setPromptExpanded(!promptExpanded)}>
                        <span className="va-label">Prompt</span>
                        <span className="va-toggle-icon">{promptExpanded ? "\u25b2" : "\u25bc"}</span>
                    </button>
                    {promptExpanded && (
                        <pre className="va-prompt-text">{ann.prompt}</pre>
                    )}
                </div>
            )}
            {ann.video_prompt && (
                <div className="va-section va-prompt-section">
                    <button className="va-prompt-toggle" onClick={() => setVideoPromptExpanded(!videoPromptExpanded)}>
                        <span className="va-label">{"\ud83c\udfac Text-to-Video Prompt"}</span>
                        <span className="va-toggle-icon">{videoPromptExpanded ? "\u25b2" : "\u25bc"}</span>
                    </button>
                    {videoPromptExpanded && (
                        <pre className="va-prompt-text">{ann.video_prompt}</pre>
                    )}
                </div>
            )}
            {ann.i2v_prompt && (
                <div className="va-section va-prompt-section">
                    <button className="va-prompt-toggle" onClick={() => setI2vPromptExpanded(!i2vPromptExpanded)}>
                        <span className="va-label">{"\ud83d\uddbc\ufe0f\u2192\ud83c\udfac Image-to-Video Prompt"}</span>
                        <span className="va-toggle-icon">{i2vPromptExpanded ? "\u25b2" : "\u25bc"}</span>
                    </button>
                    {i2vPromptExpanded && (
                        <pre className="va-prompt-text">{ann.i2v_prompt}</pre>
                    )}
                </div>
            )}
        </div>
    );
}

/** Inline feedback widget for a single frame card */
function FrameFeedbackWidget({ frame }: { frame: VideoAnnotationResult }) {
    const [fb, setFb] = useState<'good' | 'bad' | null>(frame.feedback ?? null);
    const [showNote, setShowNote] = useState(false);
    const [note, setNote] = useState(frame.feedback_note ?? '');
    const [saving, setSaving] = useState(false);

    const submitFeedback = useCallback(async (feedback: 'good' | 'bad' | null, feedbackNote?: string) => {
        if (!frame.id) return;
        setSaving(true);
        try {
            const resp = await fetch(`/api/frames/${frame.id}/feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ feedback, note: feedbackNote || null }),
            });
            const data = await resp.json();
            if (data.success) {
                setFb(feedback);
                if (feedback !== 'bad') setShowNote(false);
            }
        } catch (err) {
            console.error('Feedback save failed:', err);
        } finally {
            setSaving(false);
        }
    }, [frame.id]);

    function handleGood(e: React.MouseEvent) {
        e.stopPropagation();
        submitFeedback(fb === 'good' ? null : 'good');
    }

    function handleBad(e: React.MouseEvent) {
        e.stopPropagation();
        if (fb === 'bad') {
            submitFeedback(null);
        } else {
            setShowNote(true);
        }
    }

    function handleNoteSubmit(e: React.MouseEvent | React.KeyboardEvent) {
        e.stopPropagation();
        submitFeedback('bad', note);
        setShowNote(false);
    }

    return (
        <div className={`va-frame-feedback${fb ? ` va-fb-${fb}` : ''}`} onClick={e => e.stopPropagation()}>
            <div className="va-fb-buttons">
                <button
                    className={`va-fb-btn va-fb-good${fb === 'good' ? ' active' : ''}`}
                    onClick={handleGood}
                    disabled={saving}
                    title="Good frame"
                >&#x1F44D;</button>
                <button
                    className={`va-fb-btn va-fb-bad${fb === 'bad' ? ' active' : ''}`}
                    onClick={handleBad}
                    disabled={saving}
                    title="Bad frame"
                >&#x1F44E;</button>
                {fb === 'bad' && note && !showNote && (
                    <span className="va-fb-note-badge" title={note}>&#x1F4DD;</span>
                )}
            </div>
            {showNote && (
                <div className="va-fb-note-input">
                    <input
                        type="text"
                        placeholder="原因（如：模糊、角度差、无内容）"
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                            e.stopPropagation();
                            if (e.key === 'Enter') handleNoteSubmit(e);
                        }}
                        autoFocus
                    />
                    <button onClick={handleNoteSubmit} disabled={saving}>✓</button>
                </div>
            )}
        </div>
    );
}

/** Render frames that belong to a given time range */
function SegmentFrames({
    frames,
    segStart,
    segEnd,
    onSeekToFrame,
}: {
    frames: VideoAnnotationResult[];
    segStart: number;
    segEnd: number;
    onSeekToFrame?: (timestamp: number) => void;
}) {
    const segFrames = frames.filter(
        (f) => f.timestamp >= segStart && f.timestamp < segEnd
    );
    if (segFrames.length === 0) return null;

    return (
        <div className="va-frames-section va-segment-frames">
            <div className="va-frames-header">
                <span className="va-title">Key Frames</span>
                <span className="va-frames-count">{segFrames.length}</span>
            </div>
            <div className="va-frames-grid">
                {segFrames.map((frame) => {
                    const clickable = !!onSeekToFrame;
                    return (
                        <div
                            key={frame.id ?? `${frame.timestamp}-${frame.oss_key}`}
                            className={`va-frame-card${clickable ? " va-frame-clickable" : ""}${frame.feedback === 'good' ? ' va-frame-good' : ''}${frame.feedback === 'bad' ? ' va-frame-bad' : ''}`}
                            role={clickable ? "button" : undefined}
                            tabIndex={clickable ? 0 : undefined}
                            onClick={() => clickable && onSeekToFrame!(frame.timestamp)}
                            onKeyDown={(e) => {
                                if (!clickable) return;
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSeekToFrame!(frame.timestamp);
                                }
                            }}
                            title={clickable ? `Jump to ${formatTimestamp(frame.timestamp)}` : undefined}
                        >
                            <div className="va-frame-thumb-wrap">
                                <img
                                    className="va-frame-thumb"
                                    src={frame.oss_url}
                                    alt={frame.description ?? `frame@${frame.timestamp}s`}
                                    loading="lazy"
                                />
                                <span className="va-frame-timestamp">{formatTimestamp(frame.timestamp)}</span>
                            </div>
                            {frame.description && (
                                <p className="va-frame-desc">{frame.description}</p>
                            )}
                            {frame.prompt && (
                                <pre className="va-frame-prompt">{frame.prompt}</pre>
                            )}
                            <FrameFeedbackWidget frame={frame} />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** Segmented video timeline display */
function SegmentedView({
    segments,
    frames,
    onSeekToFrame,
}: {
    segments: SegmentAnnotation[];
    frames: VideoAnnotationResult[];
    onSeekToFrame?: (timestamp: number) => void;
}) {
    const [activeIndex, setActiveIndex] = useState(0);

    // Calculate total duration for proportional widths
    const totalDuration = segments.length > 0
        ? Math.max(...segments.map((s) => s.segment_end)) - Math.min(...segments.map((s) => s.segment_start))
        : 1;

    const handleSegmentClick = (index: number, startTime: number) => {
        setActiveIndex(index);
        onSeekToFrame?.(startTime);
    };

    return (
        <div className="va-segments-container">
            {/* Timeline Bar */}
            <div className="va-segment-timeline">
                {segments.map((seg, i) => {
                    const width = ((seg.segment_end - seg.segment_start) / totalDuration) * 100;
                    return (
                        <button
                            key={seg.segment_index}
                            className={`va-segment-bar${i === activeIndex ? " active" : ""}`}
                            style={{ width: `${Math.max(width, 2)}%` }}
                            onClick={() => handleSegmentClick(i, seg.segment_start)}
                            title={`Segment ${seg.segment_index}: ${formatTimestamp(seg.segment_start)} - ${formatTimestamp(seg.segment_end)}`}
                        >
                            <span className="va-segment-bar-label">{seg.segment_index}</span>
                        </button>
                    );
                })}
            </div>

            {/* Segment List */}
            <div className="va-segment-list">
                {segments.map((seg, i) => {
                    const isExpanded = i === activeIndex;
                    return (
                        <div key={seg.segment_index} className={`va-segment-item${isExpanded ? " expanded" : ""}`}>
                            <button
                                className="va-segment-header"
                                onClick={() => handleSegmentClick(i, seg.segment_start)}
                            >
                                <span className="va-segment-toggle">{isExpanded ? "\u25bc" : "\u25b6"}</span>
                                <span className="va-segment-title">
                                    Segment {seg.segment_index}
                                </span>
                                <span className="va-segment-time">
                                    {formatTimestamp(seg.segment_start)} - {formatTimestamp(seg.segment_end)}
                                </span>
                            </button>
                            {isExpanded && (
                                <div className="va-segment-body">
                                    <AnnotationBody ann={seg} />
                                    <SegmentFrames
                                        frames={frames}
                                        segStart={seg.segment_start}
                                        segEnd={seg.segment_end}
                                        onSeekToFrame={onSeekToFrame}
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default function VideoAnnotation({
    annotation,
    onReanalyze,
    analyzing,
    analyzingProgress,
    frames,
    onSeekToFrame,
    segments,
    segmented,
}: VideoAnnotationProps) {
    const hasFrames = Array.isArray(frames) && frames.length > 0;
    const isSegmented = segmented === true && Array.isArray(segments) && segments.length > 0;

    return (
        <div className={`video-annotation-card${analyzing ? " va-analyzing" : ""}`}>
            {analyzing && <div className="va-loading-overlay"><span className="va-pulse">{analyzingProgress || "Analyzing..."}</span></div>}
            <div className="va-header">
                <span className="va-title">AI Annotation{isSegmented ? " (Segmented)" : ""}</span>
                <button className="va-reanalyze-btn" onClick={onReanalyze} disabled={analyzing} title="Re-analyze">
                    ↻
                </button>
            </div>

            {isSegmented ? (
                /* Segmented long video display */
                <SegmentedView
                    segments={segments!}
                    frames={frames ?? []}
                    onSeekToFrame={onSeekToFrame}
                />
            ) : (
                /* Short video (original display) */
                <>
                    <AnnotationBody ann={annotation} />
                    {hasFrames && (
                        <div className="va-frames-section">
                            <div className="va-frames-header">
                                <span className="va-title">AI Key Frames</span>
                                <span className="va-frames-count">{frames!.length}</span>
                            </div>
                            <div className="va-frames-grid">
                                {frames!.map((frame) => {
                                    const clickable = !!onSeekToFrame;
                                    return (
                                        <div
                                            key={frame.id ?? `${frame.timestamp}-${frame.oss_key}`}
                                            className={`va-frame-card${clickable ? " va-frame-clickable" : ""}${frame.feedback === 'good' ? ' va-frame-good' : ''}${frame.feedback === 'bad' ? ' va-frame-bad' : ''}`}
                                            role={clickable ? "button" : undefined}
                                            tabIndex={clickable ? 0 : undefined}
                                            onClick={() => clickable && onSeekToFrame!(frame.timestamp)}
                                            onKeyDown={(e) => {
                                                if (!clickable) return;
                                                if (e.key === "Enter" || e.key === " ") {
                                                    e.preventDefault();
                                                    onSeekToFrame!(frame.timestamp);
                                                }
                                            }}
                                            title={clickable ? `Jump to ${formatTimestamp(frame.timestamp)}` : undefined}
                                        >
                                            <div className="va-frame-thumb-wrap">
                                                <img
                                                    className="va-frame-thumb"
                                                    src={frame.oss_url}
                                                    alt={frame.description ?? `frame@${frame.timestamp}s`}
                                                    loading="lazy"
                                                />
                                                <span className="va-frame-timestamp">{formatTimestamp(frame.timestamp)}</span>
                                            </div>
                                            {frame.description && (
                                                <p className="va-frame-desc">{frame.description}</p>
                                            )}
                                            {frame.prompt && (
                                                <pre className="va-frame-prompt">{frame.prompt}</pre>
                                            )}
                                            <FrameFeedbackWidget frame={frame} />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
