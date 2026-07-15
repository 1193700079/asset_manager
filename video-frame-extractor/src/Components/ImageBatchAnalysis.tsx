import { useState, useRef, useCallback } from "react";
import "./BatchAnalysis.css";

interface ImageBatchAnalysisProps {
    unannotatedCount: number;
    folders: string[];
    onComplete?: () => void;
    onClose?: () => void;
}

interface BatchItemResult {
    index: number;
    imagePath: string;
    imageName: string;
    result: "annotated" | "skipped" | "error";
    reason?: string;
    pre_screened?: boolean;
    video_prompt?: string;
    material_type?: string;
}

type BatchState = "idle" | "running" | "done" | "aborted";

export default function ImageBatchAnalysis({ unannotatedCount, folders, onComplete, onClose }: ImageBatchAnalysisProps) {
    const [count, setCount] = useState<number>(10);
    const [concurrency, setConcurrency] = useState<number>(3);
    const [selectedFolder, setSelectedFolder] = useState<string>("");
    const [source, setSource] = useState<"prescreened" | "all">("prescreened");
    const [state, setState] = useState<BatchState>("idle");
    const [total, setTotal] = useState(0);
    const [current, setCurrent] = useState(0);
    const [currentImage, setCurrentImage] = useState("");
    const [annotated, setAnnotated] = useState(0);
    const [skipped, setSkipped] = useState(0);
    const [errors, setErrors] = useState(0);
    const [results, setResults] = useState<BatchItemResult[]>([]);
    const [errorMsg, setErrorMsg] = useState("");
    const [preScreened, setPreScreened] = useState(0);
    const abortRef = useRef<AbortController | null>(null);

    const handleStart = useCallback(async () => {
        // Check if already running
        try {
            const statusRes = await fetch("/api/image/analyze/batch/status");
            const statusData = await statusRes.json();
            if (statusData.running) {
                setErrorMsg("已有批量任务在运行中");
                return;
            }
        } catch { /* proceed */ }

        setState("running");
        setTotal(0);
        setCurrent(0);
        setCurrentImage("");
        setAnnotated(0);
        setSkipped(0);
        setErrors(0);
        setPreScreened(0);
        setResults([]);
        setErrorMsg("");

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const body: any = { count, source, concurrency };
            if (selectedFolder) body.folder = selectedFolder;

            const response = await fetch("/api/image/analyze/batch", {
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
                            setCurrentImage(event.videoName || event.imageName || "");
                            break;
                        case "item_done":
                            setResults(prev => [...prev, {
                                index: event.index,
                                imagePath: event.videoPath || event.imagePath || "",
                                imageName: event.videoName || event.imageName || "",
                                result: event.result,
                                reason: event.reason,
                                pre_screened: event.pre_screened,
                                video_prompt: event.video_prompt,
                                material_type: event.material_type,
                            }]);
                            if (event.pre_screened && event.result === "skipped") setPreScreened(n => n + 1);
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
    }, [count, concurrency, selectedFolder, source, onComplete]);

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
                <h2 className="batch-title">Prompt 标注</h2>
                {onClose && (
                    <button className="batch-close" onClick={onClose} title="关闭">✕</button>
                )}
            </header>

            <div className="batch-info">
                当前有 <strong>{unannotatedCount}</strong> 张未标注图片
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
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "12px", color: source === "prescreened" ? "#6366f1" : "#aaa" }}>
                            <input type="radio" name="img-source" value="prescreened" checked={source === "prescreened"} onChange={() => setSource("prescreened")} />
                            通过筛选（推荐）
                        </label>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "12px", color: source === "all" ? "#6366f1" : "#aaa" }}>
                            <input type="radio" name="img-source" value="all" checked={source === "all"} onChange={() => setSource("all")} />
                            全部未标注
                        </label>
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
                    {folders.length > 0 && (
                        <div className="batch-input-row">
                            <label>文件夹:</label>
                            <select
                                value={selectedFolder}
                                onChange={e => setSelectedFolder(e.target.value)}
                                style={{
                                    padding: "6px 10px",
                                    border: "1px solid var(--vb-line-strong, #333)",
                                    borderRadius: "6px",
                                    background: "var(--vb-bg, #111)",
                                    color: "#f0f0f0",
                                    fontSize: "12px",
                                    fontFamily: "inherit",
                                }}
                            >
                                <option value="">全部文件夹</option>
                                {folders.map(f => (
                                    <option key={f} value={f}>{f}</option>
                                ))}
                            </select>
                        </div>
                    )}
                    <button className="batch-btn-start" onClick={handleStart} disabled={unannotatedCount === 0}>
                        开始 Prompt 标注
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
                            <>全部完成 ({total} 张图片)</>
                        ) : (
                            <>已中止 (处理了 {current}/{total})</>
                        )}
                    </div>

                    <div className="batch-stats">
                        <span className="batch-stat batch-stat-ok">已标注 {annotated}</span>
                        <span className="batch-stat batch-stat-skip">已跳过 {skipped}</span>
                        {preScreened > 0 && <span className="batch-stat" style={{ color: '#ff9800' }}>预筛选跳过 {preScreened}</span>}
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
                                        <span className="batch-result-name" title={r.imagePath}>{r.imageName}</span>
                                        {r.reason && (
                                            <span className="batch-result-reason">
                                                {r.pre_screened && <span style={{ color: '#ff9800', marginRight: 4 }}>⊘预筛选</span>}
                                                {r.reason}
                                            </span>
                                        )}
                                        {r.video_prompt && (
                                            <span
                                                className="batch-result-vprompt"
                                                title={r.video_prompt}
                                                style={{ display: 'block', marginTop: 2, color: '#4caf50', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}
                                            >
                                                🎬 {r.video_prompt}
                                            </span>
                                        )}
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
