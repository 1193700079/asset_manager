import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import "./BatchAnalysis.css";

interface VideoPreScreenProps {
    unannotatedCount: number;
    onComplete?: () => void;
    onClose?: () => void;
}

interface PreScreenResult {
    path: string;
    name: string;
    should_annotate: boolean;
    reason: string;
    confidence: "high" | "medium" | "low";
    category?: "face_nsfw" | "body_nsfw" | "none";
    error?: string;
    overridden?: boolean;
}

interface PreScreenHistoryRow {
    batch_id: string;
    type: string;
    started_at: string;
    completed_at: string | null;
    count_passed: number;
    count_rejected: number;
    count_error: number;
    note?: string;
    status?: string;
}

type BatchState = "idle" | "running" | "done" | "aborted";

interface FeedbackTarget {
    path: string;
    currentValue: boolean;
}

const ERROR_CATEGORIES: { value: string; label: string }[] = [
    { value: 'mosaic_false_pass', label: '马赛克误通过' },
    { value: 'blur_false_pass', label: '模糊误通过' },
    { value: 'clear_false_reject', label: '清晰误拒绝' },
    { value: 'sfw_false_pass', label: '非NSFW误通过' },
    { value: 'low_quality_false_pass', label: '低质量误通过' },
    { value: 'ai_generated_false_pass', label: 'AI生成误通过' },
    { value: 'face_category_wrong', label: '人脸分类错误' },
    { value: 'other', label: '其他' },
];

function formatHistoryTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    try {
        const d = new Date(iso);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return iso || "—"; }
}

// localStorage persistence helpers
const VID_PRESCREEN_STORAGE_KEY = 'videoPrescreen_settings';
function loadVideoPrescreenSettings() {
    try {
        const raw = localStorage.getItem(VID_PRESCREEN_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
}
function saveVideoPrescreenSettings(settings: Record<string, any>) {
    try { localStorage.setItem(VID_PRESCREEN_STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

export default function VideoPreScreen({ unannotatedCount, onComplete, onClose }: VideoPreScreenProps) {
    const saved = useMemo(() => loadVideoPrescreenSettings(), []);
    const [count, setCount] = useState<number>(saved?.count ?? 10);
    const [concurrency, setConcurrency] = useState<number>(saved?.concurrency ?? 2);
    const [state, setState] = useState<BatchState>("idle");
    const [total, setTotal] = useState(0);
    const [current, setCurrent] = useState(0);
    const [currentVideo, setCurrentVideo] = useState("");
    const [passed, setPassed] = useState(0);
    const [rejected, setRejected] = useState(0);
    const [errors, setErrors] = useState(0);
    const [results, setResults] = useState<PreScreenResult[]>([]);
    const [errorMsg, setErrorMsg] = useState("");
    const abortRef = useRef<AbortController | null>(null);
    const [history, setHistory] = useState<PreScreenHistoryRow[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [resetting, setResetting] = useState(false);

    // Persist user settings to localStorage
    useEffect(() => {
        saveVideoPrescreenSettings({ count, concurrency });
    }, [count, concurrency]);
    const [resetMsg, setResetMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
    const [feedbackTarget, setFeedbackTarget] = useState<FeedbackTarget | null>(null);
    const [feedbackCategory, setFeedbackCategory] = useState<string>("");
    const [feedbackDesc, setFeedbackDesc] = useState<string>("");
    const [interruptedBatch, setInterruptedBatch] = useState<{ batch_id: string; config: any; progress: any } | null>(null);
    const [resuming, setResuming] = useState(false);

    useEffect(() => {
        fetch('/api/video/prescreen/batch/status')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.interrupted) setInterruptedBatch(data.interrupted);
            })
            .catch(() => {});
    }, []);

    const handleResume = useCallback(async () => {
        setResuming(true);
        try {
            const resumeRes = await fetch('/api/video/prescreen/batch/resume', { method: 'POST' });
            const resumeData = await resumeRes.json();
            if (!resumeRes.ok || !resumeData.config) {
                setErrorMsg(resumeData?.error || '恢复失败，请重新开始任务');
                setInterruptedBatch(null);
                setResuming(false);
                setTimeout(() => setErrorMsg(''), 3000);
                return;
            }
            setInterruptedBatch(null);
            const rc = resumeData.config;
            if (rc.count !== undefined) setCount(rc.count);
            if (rc.concurrency) setConcurrency(rc.concurrency);
            setTimeout(() => setResuming(false), 100);
        } catch (err: any) {
            setErrorMsg(err?.message || '恢复请求失败，请重新开始任务');
            setInterruptedBatch(null);
            setResuming(false);
            setTimeout(() => setErrorMsg(''), 3000);
        }
    }, []);

    const refreshHistory = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const res = await fetch("/api/prescreen/history?type=video");
            if (res.ok) {
                const data = await res.json();
                setHistory(Array.isArray(data?.history) ? data.history : []);
            }
        } catch { /* ignore */ }
        finally { setHistoryLoading(false); }
    }, []);

    useEffect(() => { refreshHistory(); }, [refreshHistory]);

    const handleReset = useCallback(async (mode: "last" | "all") => {
        const promptText = mode === "all"
            ? "确定要重置全部视频预筛选记录吗？所有 video_prescreen 记录将被删除，此操作不可恢复。"
            : "确定要重置上一批视频预筛选结果吗？最近一次批量运行产生的记录将被删除。";
        if (!window.confirm(promptText)) return;

        setResetting(true);
        setResetMsg(null);
        try {
            const res = await fetch("/api/prescreen/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode, type: "video" }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setResetMsg({ kind: "error", text: data?.error || `HTTP ${res.status}` });
            } else {
                setResetMsg({ kind: "ok", text: `已删除 ${data?.deletedCount ?? 0} 条记录` });
                await refreshHistory();
                onComplete?.();
            }
        } catch (err: any) {
            setResetMsg({ kind: "error", text: err?.message || "请求失败" });
        } finally {
            setResetting(false);
        }
    }, [refreshHistory, onComplete]);

    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const startPolling = useCallback(() => {
        if (pollingRef.current) return;
        setState("running");
        pollingRef.current = setInterval(async () => {
            try {
                const res = await fetch("/api/video/prescreen/batch/status");
                const data = await res.json();
                if (data?.running && data.progress) {
                    const p = data.progress;
                    setTotal(p.total || 0);
                    setCurrent(p.processed || 0);
                    setPassed(p.passed || 0);
                    setRejected(p.rejected || 0);
                    setErrors(p.errors || 0);
                } else {
                    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
                    setState("done");
                    refreshHistory();
                    onComplete?.();
                }
            } catch { /* ignore */ }
        }, 2000);
    }, [refreshHistory, onComplete]);

    useEffect(() => {
        return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
    }, []);

    useEffect(() => {
        if (state !== 'running') return;
        fetch('/api/video/prescreen/batch/status')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.running && !pollingRef.current) startPolling();
            })
            .catch(() => {});
    }, [state, startPolling]);

    const handleStart = useCallback(async () => {
        // Check if already running
        try {
            const statusRes = await fetch("/api/video/prescreen/batch/status");
            const statusData = await statusRes.json();
            if (statusData.running) {
                startPolling();
                return;
            }
        } catch { /* proceed */ }

        setState("running");
        setTotal(0);
        setCurrent(0);
        setCurrentVideo("");
        setPassed(0);
        setRejected(0);
        setErrors(0);
        setResults([]);
        setErrorMsg("");

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const body: any = { count, concurrency };

            const response = await fetch("/api/video/prescreen/batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                const respBody = await response.json().catch(() => ({}));
                setErrorMsg(respBody?.message || `HTTP ${response.status}`);
                setState("idle");
                return;
            }

            if (!response.body) {
                setErrorMsg("SSE not supported");
                setState("idle");
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let streamDone = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const rawLine of lines) {
                    const line = rawLine.replace(/\r$/, "");
                    if (!line.startsWith("data: ")) continue;
                    const payload = line.slice(6);
                    if (!payload) continue;
                    let event: any;
                    try {
                        event = JSON.parse(payload);
                    } catch {
                        continue;
                    }

                    switch (event.type) {
                        case "start":
                            setTotal(event.total);
                            setCurrent(0);
                            break;
                        case "item_start":
                            setCurrent(event.index + 1);
                            setCurrentVideo(event.videoName || "");
                            break;
                        case "item_done":
                            if (event.error) {
                                setErrors(n => n + 1);
                                setResults(prev => [...prev, {
                                    path: event.videoPath || "",
                                    name: event.videoName || "",
                                    should_annotate: false,
                                    reason: event.reason || event.error,
                                    confidence: "low" as const,
                                    category: "none" as const,
                                    error: event.reason || event.error,
                                }]);
                            } else {
                                if (event.should_annotate) setPassed(n => n + 1);
                                else setRejected(n => n + 1);
                                setResults(prev => [...prev, {
                                    path: event.videoPath || "",
                                    name: event.videoName || "",
                                    should_annotate: event.should_annotate,
                                    reason: event.reason || "",
                                    confidence: event.confidence || "medium",
                                    category: event.category || "none",
                                }]);
                            }
                            break;
                        case "done":
                            streamDone = true;
                            setState("done");
                            refreshHistory();
                            onComplete?.();
                            break;
                        case "aborted":
                            streamDone = true;
                            setState("aborted");
                            refreshHistory();
                            onComplete?.();
                            break;
                        case "error":
                            streamDone = true;
                            setErrorMsg(event.message || "Unknown error");
                            setState("idle");
                            break;
                    }
                }
            }

            if (!streamDone) {
                try {
                    const statusRes = await fetch("/api/video/prescreen/batch/status");
                    const statusData = await statusRes.json();
                    if (statusData?.running) {
                        startPolling();
                    } else if (statusData?.interrupted) {
                        setInterruptedBatch(statusData.interrupted);
                        setState("idle");
                    } else {
                        setState("done");
                        onComplete?.();
                    }
                } catch {
                    setState("done");
                    onComplete?.();
                }
                refreshHistory();
            }
        } catch (err: any) {
            if (err?.name === "AbortError") {
                try {
                    const statusRes = await fetch("/api/video/prescreen/batch/status");
                    const statusData = await statusRes.json();
                    if (statusData?.running) {
                        startPolling();
                    } else {
                        setState("aborted");
                        onComplete?.();
                    }
                } catch {
                    setState("aborted");
                    onComplete?.();
                }
                refreshHistory();
            } else {
                setErrorMsg(err?.message || "Connection failed");
                setState("idle");
                try {
                    const statusRes = await fetch("/api/video/prescreen/batch/status");
                    const statusData = await statusRes.json();
                    if (statusData?.interrupted) setInterruptedBatch(statusData.interrupted);
                } catch {}
            }
        } finally {
            abortRef.current = null;
        }
    }, [count, concurrency, onComplete, refreshHistory]);

    const handleStop = () => {
        abortRef.current?.abort();
    };

    const handleSetAll = () => {
        setCount(unannotatedCount);
    };

    const handleOverrideClick = (videoPath: string, currentValue: boolean) => {
        setFeedbackTarget({ path: videoPath, currentValue });
        setFeedbackCategory("");
        setFeedbackDesc("");
    };

    const applyOverride = async (videoPath: string, currentValue: boolean, category?: string, description?: string) => {
        try {
            const body: Record<string, unknown> = { path: videoPath, should_annotate: !currentValue };
            if (category) body.error_category = category;
            if (description) body.feedback_description = description;
            const res = await fetch("/api/video/prescreen/override", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                setResults(prev => prev.map(r =>
                    r.path === videoPath
                        ? { ...r, should_annotate: !currentValue, overridden: true }
                        : r
                ));
                if (currentValue) {
                    setPassed(n => n - 1);
                    setRejected(n => n + 1);
                } else {
                    setRejected(n => n - 1);
                    setPassed(n => n + 1);
                }
            }
        } catch { /* ignore */ }
    };

    const handleOverrideConfirm = async () => {
        if (!feedbackTarget) return;
        const { path, currentValue } = feedbackTarget;
        const cat = feedbackCategory || undefined;
        const desc = feedbackDesc.trim() || undefined;
        const finalCat = cat === 'other' && !desc ? undefined : cat;
        await applyOverride(path, currentValue, finalCat, desc);
        setFeedbackTarget(null);
    };

    const handleOverrideSkip = async () => {
        if (!feedbackTarget) return;
        const { path, currentValue } = feedbackTarget;
        await applyOverride(path, currentValue);
        setFeedbackTarget(null);
    };

    const handleOverrideCancel = () => {
        setFeedbackTarget(null);
    };

    const progressPct = total > 0 ? Math.round((current / total) * 100) : 0;

    const getResultClass = (r: PreScreenResult) => {
        if (r.error) return "batch-result-low";
        if (r.confidence === "low") return "batch-result-low";
        return r.should_annotate ? "batch-result-passed" : "batch-result-rejected";
    };

    const getResultIcon = (r: PreScreenResult) => {
        if (r.error) return "⚠";
        if (r.confidence === "low") return "⚠";
        return r.should_annotate ? "✓" : "✗";
    };

    const getIconColor = (r: PreScreenResult) => {
        if (r.error || r.confidence === "low") return "#ff9800";
        return r.should_annotate ? "#4caf50" : "#f44336";
    };

    return (
        <section className="batch-panel">
            <header className="batch-header">
                <h2 className="batch-title">视频预筛选</h2>
                {onClose && (
                    <button className="batch-close" onClick={onClose} title="关闭">✕</button>
                )}
            </header>

            <div className="batch-info">
                当前有 <strong>{unannotatedCount}</strong> 个待筛选视频
            </div>

            {interruptedBatch && state === 'idle' && (
                <div style={{
                    margin: '8px 0', padding: '12px 16px', borderRadius: 8,
                    background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                }}>
                    <div>
                        <div style={{ color: '#fbbf24', fontWeight: 600, fontSize: 13 }}>
                            上次预筛选因服务中断未完成
                        </div>
                        <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
                            已完成 {interruptedBatch.progress?.processed || 0} / {interruptedBatch.progress?.total || '?'} 项
                            {interruptedBatch.progress?.passed != null && ` (通过 ${interruptedBatch.progress.passed}, 拒绝 ${interruptedBatch.progress.rejected || 0})`}
                        </div>
                    </div>
                    <button
                        className="prescreen-reset-btn"
                        style={{ background: '#f59e0b', color: '#000', borderColor: '#f59e0b', whiteSpace: 'nowrap', fontWeight: 600 }}
                        disabled={resuming}
                        onClick={handleResume}
                    >
                        {resuming ? '恢复中…' : '继续处理'}
                    </button>
                </div>
            )}

            <div className="prescreen-history-card">
                <div className="prescreen-history-card-header">
                    <span className="prescreen-history-card-title">上次预筛选</span>
                    <span className="prescreen-history-time">{historyLoading ? "加载中…" : `共 ${history.length} 批`}</span>
                </div>
                {history.length === 0 ? (
                    <div className="prescreen-history-card-empty">暂无预筛选历史</div>
                ) : (
                    <div className="prescreen-history-summary">
                        <span className="prescreen-history-time">{formatHistoryTime(history[0].started_at)}</span>
                        <span className="prescreen-history-stat" style={{ color: "#4ade80" }}>✓ 通过 <strong>{history[0].count_passed}</strong></span>
                        <span className="prescreen-history-stat" style={{ color: "#f87171" }}>✗ 拒绝 <strong>{history[0].count_rejected}</strong></span>
                        {history[0].count_error > 0 && (
                            <span className="prescreen-history-stat" style={{ color: "#fbbf24" }}>⚠ 错误 <strong>{history[0].count_error}</strong></span>
                        )}
                        {!history[0].completed_at && history[0].status === 'interrupted' && (
                            <span className="prescreen-history-stat" style={{ color: "#ef4444" }}>已中断</span>
                        )}
                        {!history[0].completed_at && history[0].status !== 'interrupted' && history[0].status !== 'resumed' && (
                            <span className="prescreen-history-stat" style={{ color: "#fbbf24" }}>运行中…</span>
                        )}
                        {history[0].status === 'resumed' && (
                            <span className="prescreen-history-stat" style={{ color: "#94a3b8" }}>已恢复</span>
                        )}
                    </div>
                )}
                <div className="prescreen-reset-row">
                    <button
                        type="button"
                        className="prescreen-reset-btn"
                        onClick={() => handleReset("last")}
                        disabled={resetting || state === "running" || history.length === 0}
                        title="删除最近一批预筛选记录"
                    >
                        重置上一批
                    </button>
                    <button
                        type="button"
                        className="prescreen-reset-btn danger"
                        onClick={() => handleReset("all")}
                        disabled={resetting || state === "running"}
                        title="删除所有视频预筛选记录"
                    >
                        重置全部
                    </button>
                    {resetMsg && (
                        <span className={`prescreen-reset-msg${resetMsg.kind === "error" ? " error" : ""}`}>
                            {resetMsg.text}
                        </span>
                    )}
                </div>
            </div>

            {state === "idle" && (
                <div className="batch-controls">
                    <div className="batch-input-row">
                        <label>处理数量:</label>
                        <input
                            type="number"
                            min={1}
                            max={unannotatedCount}
                            value={count}
                            onChange={e => setCount(Math.max(1, parseInt(e.target.value) || 1))}
                            className="batch-count-input"
                        />
                        <button className="batch-btn-all" onClick={handleSetAll}>全部 ({unannotatedCount})</button>
                    </div>
                    <div className="batch-input-row">
                        <label>并发数:</label>
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={concurrency}
                            onChange={e => setConcurrency(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                            className="batch-count-input"
                            style={{ width: "60px" }}
                        />
                        <span style={{ color: "#888", fontSize: "11px" }}>（1-20，越大越快但占用更多API配额）</span>
                    </div>
                    <button className="batch-btn-start" onClick={handleStart} disabled={unannotatedCount === 0}>
                        开始预筛选
                    </button>
                    {errorMsg && <div className="batch-error">{errorMsg}</div>}
                </div>
            )}

            {(state === "running" || state === "done" || state === "aborted") && (
                <div className="batch-progress-area">
                    <div className="batch-progress-bar-wrapper">
                        <div className="batch-progress-bar" style={{ width: `${progressPct}%` }} />
                    </div>
                    <div className="batch-progress-text">
                        {state === "running" ? (
                            <>正在筛选 {current}/{total} — <span className="batch-current-name">{currentVideo}</span></>
                        ) : state === "done" ? (
                            <>筛选完成 ({total} 个视频)</>
                        ) : (
                            <>已中止 (处理了 {current}/{total})</>
                        )}
                    </div>

                    <div className="batch-stats">
                        <span className="batch-stat" style={{ color: "#4caf50" }}>通过 {passed}</span>
                        <span className="batch-stat" style={{ color: "#f44336" }}>拒绝 {rejected}</span>
                        <span className="batch-stat batch-stat-err">错误 {errors}</span>
                    </div>

                    {state === "running" && (
                        <button className="batch-btn-stop" onClick={handleStop}>停止</button>
                    )}

                    {(state === "done" || state === "aborted") && (
                        <button className="batch-btn-start" onClick={() => { setState("idle"); setResults([]); }}>
                            再次运行
                        </button>
                    )}

                    {results.length > 0 && (
                        <div className="batch-results">
                            <h3>筛选记录</h3>
                            <ul className="batch-result-list">
                                {results.map((r, i) => (
                                    <li key={i} className={`batch-result-item ${getResultClass(r)}`}>
                                        <span className="batch-result-icon" style={{ color: getIconColor(r) }}>
                                            {getResultIcon(r)}
                                        </span>
                                        <span className="batch-result-name" title={r.path}>{r.name}</span>
                                        <span className={`batch-confidence batch-confidence-${r.confidence}`}>
                                            {r.confidence}
                                        </span>
                                        {r.should_annotate && r.category === "face_nsfw" && (
                                            <span className="batch-category-badge batch-category-face" title="有清晰人脸 + NSFW">🎭 换脸素材</span>
                                        )}
                                        {r.should_annotate && r.category === "body_nsfw" && (
                                            <span className="batch-category-badge batch-category-train" title="NSFW训练素材">🔥 NSFW素材</span>
                                        )}
                                        {r.reason && <span className="batch-result-reason">{r.reason}</span>}
                                        {r.overridden && <span style={{ color: "#ff9800", fontSize: 11, marginLeft: 4 }}>已推翻</span>}
                                        <button
                                            className="batch-override-btn"
                                            onClick={() => handleOverrideClick(r.path, r.should_annotate)}
                                            title={r.should_annotate ? "推翻为拒绝" : "推翻为通过"}
                                        >
                                            推翻
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {feedbackTarget && (
                <div
                    className="prescreen-feedback-overlay"
                    onClick={(e) => { if (e.target === e.currentTarget) handleOverrideCancel(); }}
                    role="presentation"
                >
                    <div className="prescreen-feedback-modal" role="dialog" aria-modal="true">
                        <h4>AI判断错误原因</h4>
                        <p className="prescreen-feedback-hint">
                            选择错误类别可帮助AI在下次预筛选中避免同类错误
                        </p>
                        <div className="prescreen-feedback-categories">
                            {ERROR_CATEGORIES.map(cat => (
                                <label
                                    key={cat.value}
                                    className={`prescreen-feedback-cat-option ${feedbackCategory === cat.value ? 'selected' : ''}`}
                                >
                                    <input
                                        type="radio"
                                        name="error_category"
                                        value={cat.value}
                                        checked={feedbackCategory === cat.value}
                                        onChange={() => setFeedbackCategory(cat.value)}
                                    />
                                    {cat.label}
                                </label>
                            ))}
                        </div>
                        {feedbackCategory === 'other' && (
                            <input
                                type="text"
                                className="prescreen-feedback-desc-input"
                                placeholder="请描述具体错误模式…"
                                value={feedbackDesc}
                                onChange={e => setFeedbackDesc(e.target.value)}
                                autoFocus
                            />
                        )}
                        <div className="prescreen-feedback-actions">
                            <button
                                type="button"
                                className="prescreen-feedback-btn-skip"
                                onClick={handleOverrideSkip}
                            >
                                跳过反馈直接推翻
                            </button>
                            <button
                                type="button"
                                className="prescreen-feedback-btn-confirm"
                                onClick={handleOverrideConfirm}
                                disabled={feedbackCategory === 'other' && !feedbackDesc.trim()}
                            >
                                确认推翻
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
