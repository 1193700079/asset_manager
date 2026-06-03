import { useState, useRef, useCallback } from "react";
import "./BatchAnalysis.css";

interface BatchAnalysisProps {
    unannotatedCount: number;
    onComplete?: () => void;
    onClose?: () => void;
}

interface BatchItemResult {
    index: number;
    videoPath: string;
    videoName: string;
    result: "annotated" | "skipped" | "error";
    reason?: string;
}

type BatchState = "idle" | "running" | "done" | "aborted";

export default function BatchAnalysis({ unannotatedCount, onComplete, onClose }: BatchAnalysisProps) {
    const [count, setCount] = useState<number>(10);
    const [source, setSource] = useState<"prescreened" | "all">("prescreened");
    const [state, setState] = useState<BatchState>("idle");
    const [total, setTotal] = useState(0);
    const [current, setCurrent] = useState(0);
    const [currentVideo, setCurrentVideo] = useState("");
    const [annotated, setAnnotated] = useState(0);
    const [skipped, setSkipped] = useState(0);
    const [errors, setErrors] = useState(0);
    const [results, setResults] = useState<BatchItemResult[]>([]);
    const [errorMsg, setErrorMsg] = useState("");
    const abortRef = useRef<AbortController | null>(null);

    const handleStart = useCallback(async () => {
        // Check if already running
        try {
            const statusRes = await fetch("/api/video/analyze/batch/status");
            const statusData = await statusRes.json();
            if (statusData.running) {
                setErrorMsg("已有批量任务在运行中");
                return;
            }
        } catch { /* proceed */ }

        setState("running");
        setTotal(0);
        setCurrent(0);
        setCurrentVideo("");
        setAnnotated(0);
        setSkipped(0);
        setErrors(0);
        setResults([]);
        setErrorMsg("");

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await fetch("/api/video/analyze/batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ count, source }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                setErrorMsg(body?.message || `HTTP ${response.status}`);
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
                            setResults(prev => [...prev, {
                                index: event.index,
                                videoPath: event.videoPath,
                                videoName: event.videoName,
                                result: event.result,
                                reason: event.reason,
                            }]);
                            if (event.result === "annotated") setAnnotated(n => n + 1);
                            else if (event.result === "skipped") setSkipped(n => n + 1);
                            else setErrors(n => n + 1);
                            break;
                        case "done":
                            streamDone = true;
                            setState("done");
                            onComplete?.();
                            break;
                        case "aborted":
                            streamDone = true;
                            setState("aborted");
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

            // Stream ended without explicit terminal event
            if (!streamDone) {
                setState("done");
                onComplete?.();
            }
        } catch (err: any) {
            if (err?.name === "AbortError") {
                setState("aborted");
                onComplete?.();
            } else {
                setErrorMsg(err?.message || "Connection failed");
                setState("idle");
            }
        } finally {
            abortRef.current = null;
        }
    }, [count, source, onComplete]);

    const handleStop = () => {
        abortRef.current?.abort();
    };

    const handleSetAll = () => {
        setCount(unannotatedCount);
    };

    const progressPct = total > 0 ? Math.round((current / total) * 100) : 0;

    return (
        <section className="batch-panel">
            <header className="batch-header">
                <h2 className="batch-title">批量 AI 分析</h2>
                {onClose && (
                    <button className="batch-close" onClick={onClose} title="关闭">✕</button>
                )}
            </header>

            <div className="batch-info">
                当前有 <strong>{unannotatedCount}</strong> 个未标注视频
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
                        <label>数据源:</label>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "12px", color: source === "prescreened" ? "#d99454" : "#aaa" }}>
                            <input type="radio" name="video-source" value="prescreened" checked={source === "prescreened"} onChange={() => setSource("prescreened")} />
                            通过筛选（推荐）
                        </label>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "12px", color: source === "all" ? "#d99454" : "#aaa" }}>
                            <input type="radio" name="video-source" value="all" checked={source === "all"} onChange={() => setSource("all")} />
                            全部未标注
                        </label>
                    </div>
                    <button className="batch-btn-start" onClick={handleStart} disabled={unannotatedCount === 0}>
                        开始批量分析
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
                            <>正在处理 {current}/{total} — <span className="batch-current-name">{currentVideo}</span></>
                        ) : state === "done" ? (
                            <>全部完成 ({total} 个视频)</>
                        ) : (
                            <>已中止 (处理了 {current}/{total})</>
                        )}
                    </div>

                    <div className="batch-stats">
                        <span className="batch-stat batch-stat-ok">已标注 {annotated}</span>
                        <span className="batch-stat batch-stat-skip">已跳过 {skipped}</span>
                        <span className="batch-stat batch-stat-err">失败 {errors}</span>
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
                            <h3>处理记录</h3>
                            <ul className="batch-result-list">
                                {results.map((r, i) => (
                                    <li key={i} className={`batch-result-item batch-result-${r.result}`}>
                                        <span className="batch-result-icon">
                                            {r.result === "annotated" ? "✓" : r.result === "skipped" ? "⊘" : "✗"}
                                        </span>
                                        <span className="batch-result-name" title={r.videoPath}>{r.videoName}</span>
                                        {r.reason && <span className="batch-result-reason">{r.reason}</span>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
