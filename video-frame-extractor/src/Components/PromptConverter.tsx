import { useState, useRef, useCallback, useEffect } from "react";
import { FixedSizeList as List } from "react-window";
import "./BatchAnalysis.css";

interface ConvertibleFrame {
    id: number;
    image_path: string;
    prompt: string;
    video_prompt: string | null;
    video_prompt_model: string | null;
}

type PanelState = "idle" | "running" | "done" | "cancelled" | "error";

export default function PromptConverter() {
    const [frames, setFrames] = useState<ConvertibleFrame[]>([]);
    const [total, setTotal] = useState(0);
    const [totalAnnotated, setTotalAnnotated] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [state, setState] = useState<PanelState>("idle");
    const [progress, setProgress] = useState(0);
    const [progressTotal, setProgressTotal] = useState(0);
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [convertedMap, setConvertedMap] = useState<Map<number, string>>(new Map());
    const [convertedModelMap, setConvertedModelMap] = useState<Map<number, string>>(new Map());
    const [models, setModels] = useState<{id: string, label: string}[]>([]);
    const [selectedModels, setSelectedModels] = useState<string[]>([]);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [convertStats, setConvertStats] = useState<{ success: number; failed: number; refused: number; exhausted: number } | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    const limit = 100;

    // missingTotal = total (the number of frames missing video_prompt from API)
    const missingTotal = total;
    const completedCount = totalAnnotated - missingTotal;

    const fetchFrames = useCallback(async (p: number) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/prompts/convertible-frames?page=${p}&limit=${limit}`);
            if (res.ok) {
                const data = await res.json();
                setFrames(data.frames || []);
                setTotal(data.total || 0);
                setTotalAnnotated(data.totalAnnotated || 0);
                setPage(p);
            }
        } catch (err) {
            console.error("[PromptConverter] fetch failed:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchFrames(1);
        fetch('/api/prompts/video-models')
            .then(r => r.json())
            .then(data => {
                setModels(data);
                setSelectedModels(data.map((m: {id: string}) => m.id));
            })
            .catch(() => {});
    }, [fetchFrames]);

    const handleSelectAll = () => {
        const missing = new Set<number>();
        for (const f of frames) {
            if (!f.video_prompt && !convertedMap.has(f.id)) {
                missing.add(f.id);
            }
        }
        setSelected(missing);
    };

    const toggleSelect = (id: number) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // Shared SSE reader logic
    const processSSEStream = useCallback(async (response: Response) => {
        if (!response.ok || !response.body) {
            console.error('[PromptConverter] SSE failed: ok=', response.ok, 'status=', response.status);
            setErrorMsg(`请求失败 (HTTP ${response.status})，请刷新页面重试`);
            setState("error");
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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
                    case "busy":
                        setErrorMsg(event.message || "已有一个批量转换任务在进行中，请等待其完成");
                        setState("error");
                        return;
                    case "start":
                        if (event.total) {
                            setProgressTotal(event.total);
                        }
                        setConvertStats({ success: 0, failed: 0, refused: 0, exhausted: 0 });
                        break;
                    case "progress":
                        setProgress(event.current || 0);
                        if (event.total && event.total > 0) {
                            setProgressTotal(event.total);
                        }
                        if (typeof event.success === "number") {
                            setConvertStats({
                                success: event.success || 0,
                                failed: event.failed || 0,
                                refused: event.refused || 0,
                                exhausted: 0,
                            });
                        }
                        break;
                    case "result":
                        if (event.frameId && (event.videoPrompt || event.video_prompt)) {
                            const vp = event.videoPrompt || event.video_prompt;
                            setConvertedMap(prev => {
                                const next = new Map(prev);
                                next.set(event.frameId, vp);
                                return next;
                            });
                            if (event.modelId) {
                                setConvertedModelMap(prev => {
                                    const next = new Map(prev);
                                    next.set(event.frameId, event.modelId);
                                    return next;
                                });
                            }
                            setSelected(prev => {
                                const next = new Set(prev);
                                next.delete(event.frameId);
                                return next;
                            });
                        }
                        break;
                    case "done":
                        setConvertStats({
                            success: event.success || 0,
                            failed: event.failed || 0,
                            refused: event.refused || 0,
                            exhausted: event.exhausted || 0,
                        });
                        setState("done");
                        break;
                }
            }
        }

        setState("done");
    }, []);

    const handleStart = useCallback(async () => {
        if (state === "running") return;
        if (selected.size === 0 || selectedModels.length === 0) return;
        setState("running");
        setConvertStats(null);
        setErrorMsg(null);
        setProgress(0);
        setProgressTotal(selected.size);

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await fetch("/api/prompts/convert-to-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ frameIds: Array.from(selected), modelIds: selectedModels }),
                signal: controller.signal,
            });

            await processSSEStream(response);
        } catch (err: any) {
            if (err?.name === "AbortError") {
                setState("cancelled");
            } else {
                console.error('[PromptConverter] start error:', err);
                setErrorMsg(`转换请求失败: ${err?.message || '网络错误'}`);
                setState("error");
            }
        } finally {
            abortRef.current = null;
        }
    }, [state, selected, selectedModels, processSSEStream]);

    const handleConvertAll = useCallback(async () => {
        if (state === "running") return;
        if (selectedModels.length === 0) return;
        setState("running");
        setConvertStats(null);
        setErrorMsg(null);
        setProgress(0);
        // Don't pre-set total: let SSE "start" event provide the authoritative total
        // (the backend processes ALL missing frames in DB, not just current page)
        setProgressTotal(0);

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await fetch("/api/prompts/convert-to-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filter: "missing_video_prompt", modelIds: selectedModels }),
                signal: controller.signal,
            });

            await processSSEStream(response);
        } catch (err: any) {
            if (err?.name === "AbortError") {
                setState("cancelled");
            } else {
                console.error('[PromptConverter] convertAll error:', err);
                setErrorMsg(`转换请求失败: ${err?.message || '网络错误'}，请刷新页面重试`);
                setState("error");
            }
        } finally {
            abortRef.current = null;
            // Refresh frame list after completion
            fetchFrames(page);
        }
    }, [state, selectedModels, processSSEStream, fetchFrames, page]);

    const handleStop = () => {
        abortRef.current?.abort();
    };

    const handleReconvert = async (frameId: number) => {
        setSelected(new Set([frameId]));
        // Trigger single reconversion
        try {
            const response = await fetch("/api/prompts/convert-to-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ frameIds: [frameId], modelIds: selectedModels }),
            });
            if (!response.ok || !response.body) return;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
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
                    if (event.type === "result" && event.frameId && (event.videoPrompt || event.video_prompt)) {
                        const vp = event.videoPrompt || event.video_prompt;
                        setConvertedMap(prev => {
                            const next = new Map(prev);
                            next.set(event.frameId, vp);
                            return next;
                        });
                        if (event.modelId) {
                            setConvertedModelMap(prev => {
                                const next = new Map(prev);
                                next.set(event.frameId, event.modelId);
                                return next;
                            });
                        }
                    }
                }
            }
        } catch { /* ignore */ }
        setSelected(new Set());
    };

    const progressPct = progressTotal > 0 ? Math.round((progress / progressTotal) * 100) : 0;
    const totalPages = Math.ceil(total / limit);

    const truncate = (text: string, max: number) =>
        text.length > max ? text.slice(0, max) + "…" : text;

    const getVideoPromptStatus = (frame: ConvertibleFrame): "has" | "missing" => {
        if (convertedMap.has(frame.id)) return "has";
        return frame.video_prompt ? "has" : "missing";
    };

    const getVideoPromptModelLabel = (frame: ConvertibleFrame): string | null => {
        const modelId = convertedModelMap.get(frame.id) || frame.video_prompt_model;
        if (modelId) {
            const m = models.find(mod => mod.id === modelId);
            return m ? m.label : modelId;
        }
        return null;
    };

    const getVideoPromptText = (frame: ConvertibleFrame): string | null => {
        return convertedMap.get(frame.id) || frame.video_prompt || null;
    };

    // Row renderer for react-window
    const ROW_HEIGHT = 44;
    const RowRenderer = ({ index, style }: { index: number; style: React.CSSProperties }) => {
        const frame = frames[index];
        if (!frame) return null;
        const status = getVideoPromptStatus(frame);
        const isExpanded = expandedId === frame.id;
        const videoPromptText = getVideoPromptText(frame);
        const modelLabel = getVideoPromptModelLabel(frame);

        return (
            <div style={{ ...style, borderBottom: "1px solid #222" }}>
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "40px 50px 1fr 120px 36px",
                        alignItems: "center",
                        height: ROW_HEIGHT,
                        padding: "0 8px",
                        fontSize: "12px",
                        color: "#ccc",
                        cursor: "pointer",
                    }}
                    onClick={() => setExpandedId(isExpanded ? null : frame.id)}
                >
                    <input
                        type="checkbox"
                        checked={selected.has(frame.id)}
                        onChange={(e) => { e.stopPropagation(); toggleSelect(frame.id); }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ width: 16, height: 16 }}
                    />
                    <span style={{ color: "#888" }}>#{index + 1 + (page - 1) * limit}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>
                        {truncate(frame.prompt, 80)}
                    </span>
                    <span style={{ color: status === "has" ? "#4ade80" : "#f87171", fontWeight: 500, fontSize: 11 }}>
                        {status === "has" ? (modelLabel ? `✓ ${modelLabel}` : "✓ 已有") : "✗ 缺失"}
                    </span>
                    {status === "has" && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleReconvert(frame.id); }}
                            style={{
                                background: "transparent",
                                border: "1px solid #555",
                                borderRadius: 4,
                                color: "#aaa",
                                fontSize: 10,
                                cursor: "pointer",
                                padding: "2px 4px",
                            }}
                            title="重新转换"
                        >
                            ↻
                        </button>
                    )}
                </div>
                {isExpanded && videoPromptText && (
                    <div style={{
                        padding: "8px 12px 8px 50px",
                        fontSize: "11px",
                        color: "#a3e635",
                        background: "rgba(163,230,53,0.05)",
                        borderTop: "1px solid #333",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        maxHeight: 120,
                        overflowY: "auto",
                    }}>
                        {modelLabel && <div style={{ color: '#888', marginBottom: 4, fontSize: 10 }}>模型: {modelLabel}</div>}
                        {videoPromptText}
                    </div>
                )}
            </div>
        );
    };

    return (
        <section className="batch-panel">
            <header className="batch-header">
                <h2 className="batch-title">提示词转换</h2>
            </header>

            {/* Stats bar */}
            <div className="batch-info">
                共 <strong>{totalAnnotated}</strong> 个已标注帧，其中 <strong>{total}</strong> 个缺少视频提示词
                {loading && <span style={{ marginLeft: 8, color: "#888" }}>加载中...</span>}
                {state === "idle" && missingTotal > 0 && (
                    <span style={{ marginLeft: 12, color: "#fbbf24", fontSize: 12 }}>
                        还有 {missingTotal} 条待转换，点击“转换全部缺失”继续
                    </span>
                )}
            </div>

            {/* Action bar */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" }}>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    {models.map(m => (
                        <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 12, color: '#e0e0e0', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={selectedModels.includes(m.id)}
                                onChange={() => {
                                    setSelectedModels(prev =>
                                        prev.includes(m.id)
                                            ? prev.filter(id => id !== m.id)
                                            : [...prev, m.id]
                                    );
                                }}
                                disabled={state === "running"}
                            />
                            {m.label}
                        </label>
                    ))}
                    <button
                        onClick={() => setSelectedModels(models.map(m => m.id))}
                        disabled={state === "running"}
                        style={{ background: 'transparent', border: '1px solid #444', borderRadius: 4, color: '#888', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}
                    >全选</button>
                    <button
                        onClick={() => setSelectedModels([])}
                        disabled={state === "running"}
                        style={{ background: 'transparent', border: '1px solid #444', borderRadius: 4, color: '#888', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}
                    >全不选</button>
                </div>
                <button
                    className="batch-btn-all"
                    onClick={handleSelectAll}
                    disabled={state === "running"}
                >
                    全选缺失项
                </button>
                {state === "idle" || state === "done" || state === "cancelled" || state === "error" ? (
                    <>
                        <button
                            className="batch-btn-start"
                            onClick={handleStart}
                            disabled={selected.size === 0 || selectedModels.length === 0}
                        >
                            开始转换 ({selected.size})
                        </button>
                        <button
                            onClick={handleConvertAll}
                            disabled={missingTotal === 0 || selectedModels.length === 0}
                            style={{
                                padding: "6px 14px",
                                borderRadius: 6,
                                border: "none",
                                background: missingTotal > 0 && selectedModels.length > 0 ? "#f59e0b" : "#444",
                                color: missingTotal > 0 && selectedModels.length > 0 ? "#000" : "#888",
                                fontWeight: 600,
                                fontSize: 13,
                                cursor: missingTotal > 0 && selectedModels.length > 0 ? "pointer" : "not-allowed",
                            }}
                        >
                            转换全部缺失 ({completedCount} 已完成 / {missingTotal} 待转换)
                        </button>
                    </>
                ) : null}
                {state === "running" && (
                    <button className="batch-btn-stop" onClick={handleStop}>停止</button>
                )}
                {selected.size > 0 && state === "idle" && (
                    <span style={{ fontSize: 12, color: "#888" }}>已选 {selected.size} 项</span>
                )}
            </div>

            {/* Progress bar */}
            {state === "running" && (
                <div className="batch-progress-area">
                    <div className="batch-progress-bar-wrapper">
                        {progressTotal === 0 ? (
                            <div className="batch-progress-bar batch-progress-bar-indeterminate" />
                        ) : (
                            <div className="batch-progress-bar" style={{ width: `${progressPct}%` }} />
                        )}
                    </div>
                    <div className="batch-progress-text">
                        {progressTotal === 0
                            ? "正在准备..."
                            : `正在转换... ${progress}/${progressTotal} 已完成`}
                        {convertStats && (
                            <span style={{ marginLeft: 8, color: "#888" }}>
                                ✓{convertStats.success} ✗{convertStats.failed}
                                {convertStats.refused > 0 && ` (拒答${convertStats.refused})`}
                            </span>
                        )}
                    </div>
                </div>
            )}

            {state === "done" && progress > 0 && (
                <div style={{ fontSize: 12, color: "#4ade80", margin: "4px 0" }}>
                    ✓ 转换完成，共处理 {progress} / {progressTotal} 项
                    {convertStats && (
                        <span style={{ color: "#9ca3af", marginLeft: 6 }}>
                            （成功 {convertStats.success} / 失败 {convertStats.failed}
                            {convertStats.refused > 0 && `，其中拒答 ${convertStats.refused}`}
                            {convertStats.exhausted > 0 && `；已永久跳过 ${convertStats.exhausted} 条达上限`}）
                        </span>
                    )}
                    {progress < progressTotal && (
                        <span style={{ color: "#fbbf24", marginLeft: 6 }}>(部分完成)</span>
                    )}
                </div>
            )}

            {state === "cancelled" && progress > 0 && (
                <div style={{ fontSize: 12, color: "#fbbf24", margin: "4px 0" }}>
                    ⚠ 已中止，已处理 {progress} / {progressTotal} 项
                </div>
            )}

            {state === "error" && errorMsg && (
                <div style={{ fontSize: 12, color: "#f87171", margin: "4px 0", padding: "8px 12px", background: "rgba(248,113,113,0.1)", borderRadius: 4 }}>
                    ⚠ {errorMsg}
                </div>
            )}

            {/* Frame list */}
            <div style={{ border: "1px solid #333", borderRadius: 6, overflow: "hidden", marginTop: 8 }}>
                {/* Table header */}
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "40px 50px 1fr 120px 36px",
                    padding: "6px 8px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "#888",
                    background: "#1a1a1a",
                    borderBottom: "1px solid #333",
                }}>
                    <span></span>
                    <span>序号</span>
                    <span>原始 Prompt</span>
                    <span>Video Prompt</span>
                    <span></span>
                </div>

                {frames.length > 0 ? (
                    <List
                        height={Math.min(frames.length * ROW_HEIGHT, 500)}
                        itemCount={frames.length}
                        itemSize={ROW_HEIGHT}
                        width="100%"
                    >
                        {RowRenderer}
                    </List>
                ) : (
                    <div style={{ padding: "20px", textAlign: "center", color: "#666", fontSize: 13 }}>
                        {loading ? "加载中..." : "暂无可转换的帧"}
                    </div>
                )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "12px 0", alignItems: "center" }}>
                    <button
                        onClick={() => fetchFrames(page - 1)}
                        disabled={page <= 1 || loading}
                        style={{
                            padding: "4px 10px",
                            border: "1px solid #444",
                            borderRadius: 4,
                            background: "transparent",
                            color: page <= 1 ? "#555" : "#ccc",
                            cursor: page <= 1 ? "not-allowed" : "pointer",
                            fontSize: 12,
                        }}
                    >
                        上一页
                    </button>
                    <span style={{ fontSize: 12, color: "#888" }}>
                        {page} / {totalPages}
                    </span>
                    <button
                        onClick={() => fetchFrames(page + 1)}
                        disabled={page >= totalPages || loading}
                        style={{
                            padding: "4px 10px",
                            border: "1px solid #444",
                            borderRadius: 4,
                            background: "transparent",
                            color: page >= totalPages ? "#555" : "#ccc",
                            cursor: page >= totalPages ? "not-allowed" : "pointer",
                            fontSize: 12,
                        }}
                    >
                        下一页
                    </button>
                </div>
            )}
        </section>
    );
}
