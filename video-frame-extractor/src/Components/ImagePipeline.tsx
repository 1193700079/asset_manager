import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import "./BatchAnalysis.css";

interface ImagePipelineProps {
    unannotatedCount: number;
    folders: string[];
    onComplete?: () => void;
    onClose?: () => void;
}

interface AvailableModel {
    key: string;
    label: string;
    isArbiter: boolean;
}

type BatchState = "idle" | "running" | "done" | "aborted";
type ModelStrategy = 'single' | 'vote' | 'loadbalance';

const STORAGE_KEY = 'imagePipeline_settings';
function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
}
function saveSettings(settings: Record<string, any>) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

export default function ImagePipeline({ unannotatedCount, folders, onComplete, onClose }: ImagePipelineProps) {
    const saved = useMemo(() => loadSettings(), []);
    const [count, setCount] = useState<number>(saved?.count ?? 10);
    const [concurrency, setConcurrency] = useState<number>(saved?.concurrency ?? 3);
    const [batchSize, setBatchSize] = useState<number>(saved?.batchSize ?? 1);
    const [selectedFolder, setSelectedFolder] = useState<string>(saved?.selectedFolder ?? "");
    const [state, setState] = useState<BatchState>("idle");
    const [total, setTotal] = useState(0);
    const [current, setCurrent] = useState(0);
    const [currentImage, setCurrentImage] = useState("");
    const [prescreenPassed, setPrescreenPassed] = useState(0);
    const [prescreenRejected, setPrescreenRejected] = useState(0);
    const [annotated, setAnnotated] = useState(0);
    const [skipped, setSkipped] = useState(0);
    const [errors, setErrors] = useState(0);
    const [errorMsg, setErrorMsg] = useState("");
    const abortRef = useRef<AbortController | null>(null);
    const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
    const [prescreenStrategy, setPrescreenStrategy] = useState<ModelStrategy>(saved?.prescreenStrategy ?? 'single');
    const [prescreenModels, setPrescreenModels] = useState<string[]>(saved?.prescreenModels ?? ['kimi', 'qwen']);
    const [prescreenArbiter, setPrescreenArbiter] = useState<string>(saved?.prescreenArbiter ?? 'deepseek');
    const [annotateStrategy, setAnnotateStrategy] = useState<ModelStrategy>(saved?.annotateStrategy ?? 'single');
    const [annotateModels, setAnnotateModels] = useState<string[]>(saved?.annotateModels ?? ['kimi', 'qwen']);
    const [annotateArbiter, setAnnotateArbiter] = useState<string>(saved?.annotateArbiter ?? 'deepseek');
    const [interruptedBatch, setInterruptedBatch] = useState<{ batch_id: string; config: any; progress: any } | null>(null);
    const [resuming, setResuming] = useState(false);
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [historyCollapsed, setHistoryCollapsed] = useState(true);
    const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
    const [batchResults, setBatchResults] = useState<any[]>([]);
    const [batchResultsLoading, setBatchResultsLoading] = useState(false);
    const [activeTab, setActiveTab] = useState<'all' | 'annotated' | 'train' | 'face' | 'watermark' | 'rejected'>('all');
    const [previewPath, setPreviewPath] = useState<string | null>(null);

    const refreshHistory = useCallback(async () => {
        try {
            const res = await fetch("/api/prescreen/history?type=image&subtype=pipeline");
            if (res.ok) {
                const data = await res.json();
                setHistory(Array.isArray(data?.history) ? data.history : []);
            }
        } catch { /* ignore */ }
    }, []);

    useEffect(() => { refreshHistory(); }, [refreshHistory]);

    const handleSelectBatch = useCallback(async (batchId: string) => {
        if (batchId === selectedBatchId) return;
        setSelectedBatchId(batchId);
        setBatchResultsLoading(true);
        try {
            const [prescreenRes, annotatedRes] = await Promise.all([
                fetch(`/api/image/prescreen/results?batch_id=${encodeURIComponent(batchId)}`),
                fetch('/api/images/annotated'),
            ]);
            let results: any[] = [];
            if (prescreenRes.ok) {
                const data = await prescreenRes.json();
                results = data?.results || [];
            }
            let annotatedSet = new Set<string>();
            if (annotatedRes.ok) {
                const aData = await annotatedRes.json();
                if (aData?.success && Array.isArray(aData.data)) annotatedSet = new Set(aData.data);
            }
            const enriched = results.map((r: any) => ({ ...r, annotated: annotatedSet.has(r.path) }));
            setBatchResults(enriched);
        } catch { /* ignore */ }
        setBatchResultsLoading(false);
    }, [selectedBatchId]);

    useEffect(() => {
        if (history.length > 0 && !selectedBatchId) {
            handleSelectBatch(history[0].batch_id);
        }
    }, [history, selectedBatchId, handleSelectBatch]);

    useEffect(() => {
        saveSettings({ count, concurrency, batchSize, selectedFolder, prescreenStrategy, prescreenModels, prescreenArbiter, annotateStrategy, annotateModels, annotateArbiter });
    }, [count, concurrency, batchSize, selectedFolder, prescreenStrategy, prescreenModels, prescreenArbiter, annotateStrategy, annotateModels, annotateArbiter]);

    useEffect(() => {
        fetch('/api/prescreen/models')
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data?.models) setAvailableModels(data.models); })
            .catch(() => {});
    }, []);

    useEffect(() => {
        fetch('/api/image/pipeline/batch/status')
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data?.interrupted) setInterruptedBatch(data.interrupted); })
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (state !== 'running') return;
        fetch('/api/image/pipeline/batch/status')
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data?.running && !pollingRef.current) startPolling(); })
            .catch(() => {});
    }, [state]);

    useEffect(() => {
        return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
    }, []);

    const startPolling = useCallback(() => {
        if (pollingRef.current) return;
        setState("running");
        pollingRef.current = setInterval(async () => {
            try {
                const res = await fetch("/api/image/pipeline/batch/status");
                const data = await res.json();
                if (data?.running && data.progress) {
                    const p = data.progress;
                    setTotal(p.total || 0);
                    setCurrent(p.processed || 0);
                    setPrescreenPassed(p.prescreenPassed || 0);
                    setPrescreenRejected(p.prescreenRejected || 0);
                    setAnnotated(p.annotated || 0);
                    setSkipped(p.skipped || 0);
                    setErrors(p.errors || 0);
                } else {
                    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
                    setState("done");
                    onComplete?.();
                }
            } catch { /* ignore */ }
        }, 2000);
    }, [onComplete]);

    const handleStart = useCallback(async () => {
        try {
            const statusRes = await fetch("/api/image/pipeline/batch/status");
            const statusData = await statusRes.json();
            if (statusData.running) {
                startPolling();
                return;
            }
        } catch { /* proceed */ }

        setState("running");
        setTotal(0); setCurrent(0); setCurrentImage("");
        setPrescreenPassed(0); setPrescreenRejected(0);
        setAnnotated(0); setSkipped(0); setErrors(0);
        setErrorMsg("");

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const body: any = { count, concurrency, batchSize };
            if (selectedFolder) body.folder = selectedFolder;
            body.prescreenStrategy = prescreenStrategy;
            if (prescreenStrategy !== 'single' && prescreenModels.length > 0) {
                body.prescreenModels = prescreenModels;
                if (prescreenStrategy === 'vote') body.prescreenArbiter = prescreenArbiter;
            }
            body.annotateStrategy = annotateStrategy;
            if (annotateStrategy !== 'single' && annotateModels.length > 0) {
                body.annotateModels = annotateModels;
                if (annotateStrategy === 'vote') body.annotateArbiter = annotateArbiter;
            }

            const response = await fetch("/api/image/pipeline/batch", {
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
                    try { event = JSON.parse(payload); } catch { continue; }

                    switch (event.type) {
                        case "start":
                            setTotal(event.total);
                            setCurrent(0);
                            break;
                        case "item_start":
                            setCurrent(event.index + 1);
                            setCurrentImage(event.imageName || "");
                            break;
                        case "prescreen_done":
                            if (event.should_annotate) setPrescreenPassed(n => n + 1);
                            else setPrescreenRejected(n => n + 1);
                            break;
                        case "annotate_done":
                            if (event.result === 'annotated') setAnnotated(n => n + 1);
                            else if (event.result === 'skipped') setSkipped(n => n + 1);
                            else setErrors(n => n + 1);
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
                    const statusRes = await fetch("/api/image/pipeline/batch/status");
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
            }
        } catch (err: any) {
            if (err?.name === "AbortError") {
                try {
                    const statusRes = await fetch("/api/image/pipeline/batch/status");
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
            } else {
                setErrorMsg(err?.message || "Connection failed");
                setState("idle");
                try {
                    const statusRes = await fetch("/api/image/pipeline/batch/status");
                    const statusData = await statusRes.json();
                    if (statusData?.interrupted) setInterruptedBatch(statusData.interrupted);
                } catch {}
            }
        } finally {
            abortRef.current = null;
        }
    }, [count, concurrency, batchSize, selectedFolder, prescreenStrategy, prescreenModels, prescreenArbiter, annotateStrategy, annotateModels, annotateArbiter, onComplete, startPolling]);

    const handleResume = useCallback(async () => {
        setResuming(true);
        try {
            const resumeRes = await fetch('/api/image/pipeline/batch/resume', { method: 'POST' });
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
            if (rc.prescreenStrategy) setPrescreenStrategy(rc.prescreenStrategy);
            if (rc.prescreenModels) setPrescreenModels(rc.prescreenModels);
            if (rc.prescreenArbiter) setPrescreenArbiter(rc.prescreenArbiter);
            if (rc.annotateStrategy) setAnnotateStrategy(rc.annotateStrategy);
            if (rc.annotateModels) setAnnotateModels(rc.annotateModels);
            if (rc.annotateArbiter) setAnnotateArbiter(rc.annotateArbiter);
            if (rc.folder) setSelectedFolder(rc.folder);
            setResuming(false);
            setTimeout(() => handleStart(), 500);
        } catch (err: any) {
            setErrorMsg(err?.message || '恢复请求失败，请重新开始任务');
            setInterruptedBatch(null);
            setResuming(false);
            setTimeout(() => setErrorMsg(''), 3000);
        }
    }, [handleStart]);

    const handleStop = async () => {
        try { await fetch('/api/image/pipeline/batch/stop', { method: 'POST' }); } catch {}
        abortRef.current?.abort();
    };

    const progressPct = total > 0 ? Math.round((current / total) * 100) : 0;

    return (
        <section className="batch-panel">
            <header className="batch-header">
                <h2 className="batch-title">预筛选 + Prompt 标注</h2>
                {onClose && (
                    <button className="batch-close" onClick={onClose} title="关闭">✕</button>
                )}
            </header>

            <div className="batch-info">
                当前有 <strong>{unannotatedCount}</strong> 张待处理图片
                <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 8 }}>
                    一步完成：先预筛选，通过的自动进行 Prompt 标注
                </span>
            </div>

            {interruptedBatch && state === 'idle' && (
                <div style={{
                    margin: '8px 0', padding: '12px 16px', borderRadius: 8,
                    background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                }}>
                    <div>
                        <div style={{ color: '#fbbf24', fontWeight: 600, fontSize: 13 }}>
                            上次任务因服务中断未完成
                        </div>
                        <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
                            已完成 {interruptedBatch.progress?.processed || 0} / {interruptedBatch.progress?.total || '?'} 项
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
                <div className="prescreen-history-card-header"
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setHistoryCollapsed(c => !c)}>
                    <span className="prescreen-history-card-title">任务历史</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="prescreen-history-time">{`共 ${history.length} 批`}</span>
                        <span style={{ fontSize: 10, color: '#94a3b8', transition: 'transform 0.2s', display: 'inline-block', transform: historyCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                    </span>
                </div>
                {!historyCollapsed && (<>
                    {history.length === 0 ? (
                        <div className="prescreen-history-card-empty">暂无任务历史</div>
                    ) : (
                        <div className="prescreen-history-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
                            {history.map((h: any) => (
                                <div
                                    key={h.batch_id}
                                    style={{
                                        padding: '8px 10px', cursor: 'pointer', borderRadius: 6, marginBottom: 4,
                                        background: selectedBatchId === h.batch_id ? 'rgba(99,102,241,0.12)' : 'transparent',
                                        border: selectedBatchId === h.batch_id ? '1px solid rgba(99,102,241,0.4)' : '1px solid transparent',
                                        transition: 'all 0.15s',
                                    }}
                                    onClick={() => handleSelectBatch(h.batch_id)}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span className="prescreen-history-time" style={{ fontSize: 11 }}>
                                            {(() => { try { const d = new Date(h.started_at); const pad = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; } catch { return h.started_at; } })()}
                                        </span>
                                        <span style={{ color: "#4ade80", fontSize: 11 }}>✓{h.count_passed}</span>
                                        <span style={{ color: "#f87171", fontSize: 11 }}>✗{h.count_rejected}</span>
                                        {h.count_error > 0 && <span style={{ color: "#fbbf24", fontSize: 11 }}>⚠{h.count_error}</span>}
                                        {h.status === 'interrupted' && <span style={{ color: "#ef4444", fontSize: 10 }}>已中断</span>}
                                        {h.status === 'completed' && <span style={{ color: "#22c55e", fontSize: 10 }}>✓已完成</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>)}
            </div>

            {batchResultsLoading && (
                <div style={{ padding: '12px 0', color: '#94a3b8', fontSize: 12, textAlign: 'center' as const }}>
                    加载记录中…
                </div>
            )}

            {batchResults.length > 0 && (() => {
                const tabCounts = {
                    all: batchResults.length,
                    annotated: batchResults.filter((r: any) => r.should_annotate && r.annotated).length,
                    train: batchResults.filter((r: any) => r.should_annotate && r.category !== 'face_nsfw' && r.category !== 'watermark').length,
                    face: batchResults.filter((r: any) => r.should_annotate && r.category === 'face_nsfw').length,
                    watermark: batchResults.filter((r: any) => r.should_annotate && r.category === 'watermark').length,
                    rejected: batchResults.filter((r: any) => !r.should_annotate).length,
                };
                const filtered = batchResults.filter((r: any) => {
                    if (activeTab === 'all') return true;
                    if (activeTab === 'annotated') return r.should_annotate && r.annotated;
                    if (activeTab === 'train') return r.should_annotate && r.category !== 'watermark' && r.category !== 'face_nsfw';
                    if (activeTab === 'face') return r.should_annotate && r.category === 'face_nsfw';
                    if (activeTab === 'watermark') return r.should_annotate && r.category === 'watermark';
                    if (activeTab === 'rejected') return !r.should_annotate;
                    return true;
                });
                return (
                    <div className="batch-results">
                        <h3>筛选记录</h3>
                        <div className="prescreen-tab-bar">
                            {([
                                { key: 'all', label: '全部' },
                                { key: 'annotated', label: '已标注' },
                                { key: 'train', label: '训练素材' },
                                { key: 'face', label: '换脸素材' },
                                { key: 'watermark', label: '待去水印' },
                                { key: 'rejected', label: '已拒绝' },
                            ] as const).map(tab => (
                                <button
                                    key={tab.key}
                                    className={`prescreen-tab ${activeTab === tab.key ? 'active' : ''}`}
                                    onClick={() => setActiveTab(tab.key)}
                                >
                                    {tab.label} ({tabCounts[tab.key]})
                                </button>
                            ))}
                        </div>
                        <ul className="batch-result-list">
                            {filtered.map((r: any, i: number) => (
                                <li key={i} className={`batch-result-item ${r.error ? 'batch-result-low' : r.confidence === 'low' ? 'batch-result-low' : r.should_annotate ? 'batch-result-passed' : 'batch-result-rejected'}`}>
                                    <img
                                        className="batch-result-thumb"
                                        src={`/api/images/serve?path=${encodeURIComponent(r.path)}`}
                                        alt={r.name}
                                        loading="lazy"
                                        onClick={() => setPreviewPath(previewPath === r.path ? null : r.path)}
                                    />
                                    <span className="batch-result-icon" style={{ color: r.error || r.confidence === 'low' ? '#ff9800' : r.should_annotate ? '#4caf50' : '#f44336' }}>
                                        {r.error || r.confidence === 'low' ? '⚠' : r.should_annotate ? '✓' : '✗'}
                                    </span>
                                    <span className="batch-result-name" title={r.path}>{r.name}</span>
                                    <span className={`batch-confidence batch-confidence-${r.confidence}`}>{r.confidence}</span>
                                    {r.should_annotate && r.annotated && (
                                        <span style={{ color: '#22c55e', fontSize: 10, marginLeft: 4 }}>✓已标注</span>
                                    )}
                                    {r.should_annotate && !r.annotated && (
                                        <span style={{ color: '#94a3b8', fontSize: 10, marginLeft: 4 }}>待标注</span>
                                    )}
                                    {r.should_annotate && r.category === 'face_nsfw' && (
                                        <span className="batch-category-badge batch-category-face" title="有清晰人脸 + NSFW">🎭 换脸素材</span>
                                    )}
                                    {r.should_annotate && r.category === 'body_nsfw' && (
                                        <span className="batch-category-badge batch-category-train" title="NSFW训练素材">🔥 NSFW素材</span>
                                    )}
                                    {r.reason && <span className="batch-result-reason">{r.reason}</span>}
                                </li>
                            ))}
                        </ul>
                    </div>
                );
            })()}

            {state === "idle" && (
                <div className="batch-controls">
                    <div className="batch-input-row">
                        <label>处理数量:</label>
                        <input
                            type="number" min={1} max={unannotatedCount}
                            value={count}
                            onChange={e => setCount(Math.max(1, parseInt(e.target.value) || 1))}
                            className="batch-count-input"
                        />
                        <button className="batch-btn-all" onClick={() => setCount(unannotatedCount)}>全部 ({unannotatedCount})</button>
                    </div>
                    <div className="batch-input-row">
                        <label>并发数:</label>
                        <input
                            type="number" min={1} max={20}
                            value={concurrency}
                            onChange={e => setConcurrency(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                            className="batch-count-input" style={{ width: "60px" }}
                        />
                        <span style={{ color: "#888", fontSize: "11px" }}>（1-20，越大越快但占用更多API配额）</span>
                    </div>
                    <div className="batch-input-row">
                        <label>批处理图片数:</label>
                        <input
                            type="number" min={1} max={8}
                            value={batchSize}
                            onChange={e => setBatchSize(Math.max(1, Math.min(8, parseInt(e.target.value) || 1)))}
                            className="batch-count-input" style={{ width: "60px" }}
                        />
                        <span style={{ color: "#888", fontSize: "11px" }}>（每个请求含N张图，越大越省API调用但准确性可能略降）</span>
                    </div>
                    {folders.length > 0 && (
                        <div className="batch-input-row">
                            <label>文件夹:</label>
                            <select
                                value={selectedFolder}
                                onChange={e => setSelectedFolder(e.target.value)}
                                style={{
                                    padding: "6px 10px", border: "1px solid var(--vb-line-strong, #333)",
                                    borderRadius: "6px", background: "var(--vb-bg, #111)",
                                    color: "#f0f0f0", fontSize: "12px", fontFamily: "inherit",
                                }}
                            >
                                <option value="">全部文件夹</option>
                                {folders.map(f => <option key={f} value={f}>{f}</option>)}
                            </select>
                        </div>
                    )}

                    <div style={{ marginTop: 12, padding: '12px', background: 'rgba(99,102,241,0.06)', borderRadius: 8, border: '1px solid rgba(99,102,241,0.15)' }}>
                        <div style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>预筛选策略</div>
                            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                                {(['single', 'vote', 'loadbalance'] as ModelStrategy[]).map(s => (
                                    <button key={s} type="button" onClick={() => setPrescreenStrategy(s)}
                                        style={{
                                            padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                                            border: prescreenStrategy === s ? '1px solid #6366f1' : '1px solid #444',
                                            background: prescreenStrategy === s ? 'rgba(99,102,241,0.2)' : 'transparent',
                                            color: prescreenStrategy === s ? '#a5b4fc' : '#94a3b8',
                                        }}>
                                        {s === 'single' ? '单模型' : s === 'vote' ? '投票+仲裁' : '负载分流'}
                                    </button>
                                ))}
                            </div>
                            {prescreenStrategy !== 'single' && (
                                <div style={{ marginTop: 6 }}>
                                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>模型（可多选）：</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                                        {availableModels.filter(m => !m.isArbiter).map(m => (
                                            <label key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
                                                <input type="checkbox" checked={prescreenModels.includes(m.key)}
                                                    onChange={e => {
                                                        if (e.target.checked) setPrescreenModels(prev => [...prev, m.key]);
                                                        else setPrescreenModels(prev => prev.filter(k => k !== m.key));
                                                    }} style={{ accentColor: '#6366f1' }} />
                                                {m.label}
                                            </label>
                                        ))}
                                    </div>
                                    {prescreenStrategy === 'vote' && (
                                        <div style={{ marginTop: 6 }}>
                                            <span style={{ fontSize: 11, color: '#94a3b8', marginRight: 6 }}>仲裁模型：</span>
                                            <select value={prescreenArbiter} onChange={e => setPrescreenArbiter(e.target.value)}
                                                style={{ fontSize: 11, padding: '3px 6px', borderRadius: 4, border: '1px solid #444', background: '#1e1e2e', color: '#e2e8f0' }}>
                                                {availableModels.filter(m => m.isArbiter).map(m => (
                                                    <option key={m.key} value={m.key}>{m.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div style={{ borderTop: '1px solid rgba(99,102,241,0.12)', paddingTop: 12 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>标注策略</div>
                            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                                {(['single', 'vote', 'loadbalance'] as ModelStrategy[]).map(s => (
                                    <button key={s} type="button" onClick={() => setAnnotateStrategy(s)}
                                        style={{
                                            padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                                            border: annotateStrategy === s ? '1px solid #6366f1' : '1px solid #444',
                                            background: annotateStrategy === s ? 'rgba(99,102,241,0.2)' : 'transparent',
                                            color: annotateStrategy === s ? '#a5b4fc' : '#94a3b8',
                                        }}>
                                        {s === 'single' ? '单模型' : s === 'vote' ? '投票+仲裁' : '负载分流'}
                                    </button>
                                ))}
                            </div>
                            {annotateStrategy !== 'single' && (
                                <div style={{ marginTop: 6 }}>
                                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>模型（可多选）：</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                                        {availableModels.filter(m => !m.isArbiter).map(m => (
                                            <label key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
                                                <input type="checkbox" checked={annotateModels.includes(m.key)}
                                                    onChange={e => {
                                                        if (e.target.checked) setAnnotateModels(prev => [...prev, m.key]);
                                                        else setAnnotateModels(prev => prev.filter(k => k !== m.key));
                                                    }} style={{ accentColor: '#6366f1' }} />
                                                {m.label}
                                            </label>
                                        ))}
                                    </div>
                                    {annotateStrategy === 'vote' && (
                                        <div style={{ marginTop: 6 }}>
                                            <span style={{ fontSize: 11, color: '#94a3b8', marginRight: 6 }}>仲裁模型：</span>
                                            <select value={annotateArbiter} onChange={e => setAnnotateArbiter(e.target.value)}
                                                style={{ fontSize: 11, padding: '3px 6px', borderRadius: 4, border: '1px solid #444', background: '#1e1e2e', color: '#e2e8f0' }}>
                                                {availableModels.filter(m => m.isArbiter).map(m => (
                                                    <option key={m.key} value={m.key}>{m.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <button className="batch-btn-start" onClick={handleStart} disabled={unannotatedCount === 0}
                        style={{ background: '#6366f1', marginTop: 8 }}>
                        开始预筛选 + 标注
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
                            <>正在处理 {current}/{total} — <span className="batch-current-name">{currentImage}</span></>
                        ) : state === "done" ? (
                            <>处理完成 ({total} 张图片)</>
                        ) : (
                            <>已中止 (处理了 {current}/{total})</>
                        )}
                    </div>

                    <div className="batch-stats">
                        <span className="batch-stat" style={{ color: "#4caf50" }}>筛选通过 {prescreenPassed}</span>
                        <span className="batch-stat" style={{ color: "#f44336" }}>筛选拒绝 {prescreenRejected}</span>
                        <span className="batch-stat" style={{ color: "#2196f3" }}>已标注 {annotated}</span>
                        <span className="batch-stat" style={{ color: "#ff9800" }}>AI跳过 {skipped}</span>
                        <span className="batch-stat batch-stat-err">错误 {errors}</span>
                    </div>

                    {state === "running" && (
                        <button className="batch-btn-stop" onClick={handleStop}>停止</button>
                    )}

                    {(state === "done" || state === "aborted") && (
                        <button className="batch-btn-start" onClick={() => { setState("idle"); }}>
                            再次运行
                        </button>
                    )}
                </div>
            )}

            {previewPath && (
                <div
                    className="prescreen-preview-overlay"
                    onClick={() => setPreviewPath(null)}
                    onKeyDown={e => { if (e.key === 'Escape') setPreviewPath(null); }}
                    tabIndex={0}
                    role="dialog"
                    aria-modal="true"
                >
                    <img
                        className="prescreen-preview-img"
                        src={`/api/images/serve?path=${encodeURIComponent(previewPath)}`}
                        alt="预览"
                        onClick={e => e.stopPropagation()}
                    />
                    <button className="prescreen-preview-close" onClick={() => setPreviewPath(null)}>✕</button>
                </div>
            )}
        </section>
    );
}
