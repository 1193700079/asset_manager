import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import "./BatchAnalysis.css";

interface ImagePreScreenProps {
    unannotatedCount: number;
    folders: string[];
    onComplete?: () => void;
    onClose?: () => void;
    prescreenVersion?: number;
}

interface PreScreenResult {
    path: string;
    name: string;
    should_annotate: boolean;
    reason: string;
    confidence: "high" | "medium" | "low";
    category?: "face_nsfw" | "body_nsfw" | "watermark" | "none";
    error?: string;
    overridden?: boolean;
    voters?: Array<{ model: string; should_annotate: boolean; reason: string; confidence: string; category: string }>;
}

interface AvailableModel {
    key: string;
    label: string;
    isArbiter: boolean;
}

interface PreScreenHistoryRow {
    batch_id: string;
    type: string;
    started_at: string;
    completed_at: string | null;
    confirmed_at: string | null;
    count_passed: number;
    count_rejected: number;
    count_error: number;
    note?: string;
    status?: string;
}

type BatchState = "idle" | "running" | "done" | "aborted";
type ModelStrategy = 'single' | 'vote' | 'loadbalance';

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
const IMG_PRESCREEN_STORAGE_KEY = 'imagePrescreen_settings';
function loadImagePrescreenSettings() {
    try {
        const raw = localStorage.getItem(IMG_PRESCREEN_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
}
function saveImagePrescreenSettings(settings: Record<string, any>) {
    try { localStorage.setItem(IMG_PRESCREEN_STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

export default function ImagePreScreen({ unannotatedCount, folders, onComplete, onClose, prescreenVersion }: ImagePreScreenProps) {
    const saved = useMemo(() => loadImagePrescreenSettings(), []);
    const [count, setCount] = useState<number>(saved?.count ?? 10);
    const [concurrency, setConcurrency] = useState<number>(saved?.concurrency ?? 3);
    const [batchSize, setBatchSize] = useState<number>(saved?.batchSize ?? 1);
    const [selectedFolder, setSelectedFolder] = useState<string>(saved?.selectedFolder ?? "");
    const [state, setState] = useState<BatchState>("idle");
    const [total, setTotal] = useState(0);
    const [current, setCurrent] = useState(0);
    const [currentImage, setCurrentImage] = useState("");
    const [passed, setPassed] = useState(0);
    const [rejected, setRejected] = useState(0);
    const [errors, setErrors] = useState(0);
    const [results, setResults] = useState<PreScreenResult[]>([]);
    const [errorMsg, setErrorMsg] = useState("");
    const abortRef = useRef<AbortController | null>(null);
    const [history, setHistory] = useState<PreScreenHistoryRow[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [resetMsg, setResetMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
    const [feedbackTarget, setFeedbackTarget] = useState<FeedbackTarget | null>(null);
    const [feedbackCategory, setFeedbackCategory] = useState<string>("");
    const [feedbackDesc, setFeedbackDesc] = useState<string>("");
    const [activeTab, setActiveTab] = useState<'all' | 'train' | 'face' | 'watermark' | 'rejected'>('all');
    const [includeFace, setIncludeFace] = useState(true);
    const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
    const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
    // Two-phase strategy states
    const [prescreenStrategy, setPrescreenStrategy] = useState<ModelStrategy>(saved?.prescreenStrategy ?? 'single');
    const [prescreenModels, setPrescreenModels] = useState<string[]>(saved?.prescreenModels ?? ['kimi', 'qwen']);
    const [prescreenArbiter, setPrescreenArbiter] = useState<string>(saved?.prescreenArbiter ?? 'deepseek');

    // Persist user settings to localStorage
    useEffect(() => {
        saveImagePrescreenSettings({ count, concurrency, batchSize, selectedFolder, prescreenStrategy, prescreenModels, prescreenArbiter });
    }, [count, concurrency, batchSize, selectedFolder, prescreenStrategy, prescreenModels, prescreenArbiter]);

    const [previewPath, setPreviewPath] = useState<string | null>(null);
    const [showLearningModal, setShowLearningModal] = useState(false);
    const [learningData, setLearningData] = useState<{ rules: string; stats: any[]; total: number } | null>(null);
    const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
    const lastClickedRef = useRef<string | null>(null);
    const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
    const [batchResultsLoading, setBatchResultsLoading] = useState(false);
    const [historyCollapsed, setHistoryCollapsed] = useState(true);
    const [interruptedBatch, setInterruptedBatch] = useState<{ batch_id: string; config: any; progress: any } | null>(null);
    const [resuming, setResuming] = useState(false);

    useEffect(() => {
        fetch('/api/image/prescreen/batch/status')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.interrupted) {
                    setInterruptedBatch(data.interrupted);
                }
            })
            .catch(() => { });
    }, []);

    const handleResume = useCallback(async () => {
        setResuming(true);
        try {
            const resumeRes = await fetch('/api/image/prescreen/batch/resume', { method: 'POST' });
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
            if (rc.batchSize) setBatchSize(rc.batchSize);
            if (rc.prescreenStrategy) setPrescreenStrategy(rc.prescreenStrategy);
            if (rc.prescreenModels) setPrescreenModels(rc.prescreenModels);
            if (rc.prescreenArbiter) setPrescreenArbiter(rc.prescreenArbiter);
            if (rc.folder) setSelectedFolder(rc.folder);
            setTimeout(() => {
                setResuming(false);
            }, 100);
        } catch (err: any) {
            setErrorMsg(err?.message || '恢复请求失败，请重新开始任务');
            setInterruptedBatch(null);
            setResuming(false);
            setTimeout(() => setErrorMsg(''), 3000);
        }
    }, []);

    const filteredResults = useMemo(() => results.filter(r => {
        if (activeTab === 'all') return true;
        if (activeTab === 'train') return r.should_annotate && r.category !== 'watermark' && (includeFace || r.category !== 'face_nsfw');
        if (activeTab === 'face') return r.should_annotate && r.category === 'face_nsfw';
        if (activeTab === 'watermark') return r.should_annotate && r.category === 'watermark';
        if (activeTab === 'rejected') return !r.should_annotate;
        return true;
    }), [results, activeTab, includeFace]);

    // Sync prescreen results when external changes occur (e.g. ImageBrowser override/restore/category switch)
    useEffect(() => {
        if (!prescreenVersion) return;
        let cancelled = false;

        // If a batch is selected, re-fetch its results from DB (always reflects latest overrides)
        if (selectedBatchId) {
            fetch(`/api/image/prescreen/results?batch_id=${encodeURIComponent(selectedBatchId)}`)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (cancelled || !data?.results) return;
                    setResults(data.results);
                    setPassed(data.results.filter((r: any) => r.should_annotate).length);
                    setRejected(data.results.filter((r: any) => !r.should_annotate).length);
                })
                .catch(() => { /* ignore */ });
        } else if (results.length > 0) {
            // Fallback: cross-reference displayed results with prescreened data
            fetch('/api/images/prescreened')
                .then(r => r.json())
                .then(data => {
                    if (cancelled) return;
                    if (!data?.success || !Array.isArray(data.data)) return;
                    const freshMap = new Map<string, { status: string; category: string }>();
                    data.data.forEach((item: any) => {
                        freshMap.set(item.path, { status: item.status, category: item.category || 'none' });
                    });
                    setResults(prev => {
                        const newResults = prev.map(r => {
                            const fresh = freshMap.get(r.path);
                            if (!fresh) return r;
                            const newAnnotate = fresh.status === 'passed';
                            const newCategory = fresh.category as PreScreenResult['category'];
                            if (newAnnotate === r.should_annotate && newCategory === (r.category || 'none')) return r;
                            return { ...r, should_annotate: newAnnotate, category: newCategory, overridden: true };
                        });
                        const newPassed = newResults.filter(x => x.should_annotate && !x.error).length;
                        const newRejected = newResults.filter(x => !x.should_annotate && !x.error).length;
                        setPassed(newPassed);
                        setRejected(newRejected);
                        return newResults;
                    });
                })
                .catch(() => { /* ignore */ });
        }

        // Also refresh history list
        refreshHistory();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prescreenVersion]);

    const refreshHistory = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const res = await fetch("/api/prescreen/history?type=image&subtype=prescreen");
            if (res.ok) {
                const data = await res.json();
                setHistory(Array.isArray(data?.history) ? data.history : []);
            }
        } catch { /* ignore */ }
        finally { setHistoryLoading(false); }
    }, []);

    useEffect(() => { refreshHistory(); }, [refreshHistory]);

    // Load latest batch results on mount (so results persist across page refresh)
    useEffect(() => {
        if (state !== 'idle' || results.length > 0) return;
        fetch('/api/image/prescreen/results')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.results?.length > 0 && results.length === 0 && state === 'idle') {
                    setResults(data.results);
                    const p = data.results.filter((r: any) => r.should_annotate).length;
                    const rej = data.results.filter((r: any) => !r.should_annotate).length;
                    setPassed(p);
                    setRejected(rej);
                    setTotal(data.results.length);
                    setCurrent(data.results.length);
                    setState('done');
                }
            })
            .catch(() => { /* ignore */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-select first batch when history loads
    useEffect(() => {
        if (history.length > 0 && !selectedBatchId) {
            setSelectedBatchId(history[0].batch_id);
        }
    }, [history, selectedBatchId]);

    const handleSelectBatch = useCallback(async (batchId: string) => {
        if (batchId === selectedBatchId) return;
        setSelectedBatchId(batchId);
        setBatchResultsLoading(true);
        try {
            const res = await fetch(`/api/image/prescreen/results?batch_id=${encodeURIComponent(batchId)}`);
            if (res.ok) {
                const data = await res.json();
                if (data?.results) {
                    setResults(data.results);
                    const p = data.results.filter((r: any) => r.should_annotate).length;
                    const rej = data.results.filter((r: any) => !r.should_annotate).length;
                    setPassed(p);
                    setRejected(rej);
                    setTotal(data.results.length);
                    setCurrent(data.results.length);
                    if (state === 'idle') setState('done');
                }
            }
        } catch { /* ignore */ }
        setBatchResultsLoading(false);
    }, [selectedBatchId, state]);

    useEffect(() => {
        fetch('/api/prescreen/models')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.models) setAvailableModels(data.models);
            })
            .catch(() => { /* ignore */ });
    }, []);

    const handleReset = useCallback(async (mode: "last" | "all") => {
        const promptText = mode === "all"
            ? "确定要重置全部图片预筛选记录吗？所有 image_prescreen 记录将被删除，此操作不可恢复。"
            : "确定要重置上一批图片预筛选结果吗？最近一次批量运行产生的记录将被删除。";
        if (!window.confirm(promptText)) return;

        setResetting(true);
        setResetMsg(null);
        try {
            const res = await fetch("/api/prescreen/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode, type: "image" }),
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
                const res = await fetch("/api/image/prescreen/batch/status");
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
        fetch('/api/image/prescreen/batch/status')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.running && !pollingRef.current) startPolling();
            })
            .catch(() => { });
    }, [state, startPolling]);

    const handleStart = useCallback(async () => {
        // Check if already running
        try {
            const statusRes = await fetch("/api/image/prescreen/batch/status");
            const statusData = await statusRes.json();
            if (statusData.running) {
                startPolling();
                return;
            }
        } catch { /* proceed */ }

        setState("running");
        setTotal(0);
        setCurrent(0);
        setCurrentImage("");
        setPassed(0);
        setRejected(0);
        setErrors(0);
        setResults([]);
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

            const response = await fetch("/api/image/prescreen/batch", {
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
                            setCurrentImage(event.imageName || "");
                            break;
                        case "item_done":
                            if (event.error) {
                                setErrors(n => n + 1);
                                setResults(prev => [...prev, {
                                    path: event.imagePath || "",
                                    name: event.imageName || "",
                                    should_annotate: false,
                                    reason: event.error,
                                    confidence: "low" as const,
                                    category: "none" as const,
                                    error: event.error,
                                }]);
                            } else {
                                if (event.should_annotate) setPassed(n => n + 1);
                                else setRejected(n => n + 1);
                                setResults(prev => [...prev, {
                                    path: event.imagePath || "",
                                    name: event.imageName || "",
                                    should_annotate: event.should_annotate,
                                    reason: event.reason || "",
                                    confidence: event.confidence || "medium",
                                    category: event.category || "none",
                                    voters: Array.isArray(event.voters) ? event.voters : undefined,
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
                    const statusRes = await fetch("/api/image/prescreen/batch/status");
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
                    const statusRes = await fetch("/api/image/prescreen/batch/status");
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
                    const statusRes = await fetch("/api/image/prescreen/batch/status");
                    const statusData = await statusRes.json();
                    if (statusData?.interrupted) setInterruptedBatch(statusData.interrupted);
                } catch { }
            }
        } finally {
            abortRef.current = null;
        }
    }, [count, concurrency, batchSize, selectedFolder, prescreenStrategy, prescreenModels, prescreenArbiter, onComplete, refreshHistory]);

    const handleStop = () => {
        abortRef.current?.abort();
    };

    const handleSetAll = () => {
        setCount(unannotatedCount);
    };

    const toggleSelect = useCallback((path: string, shiftKey: boolean) => {
        setSelectedSet(prev => {
            const next = new Set(prev);
            if (shiftKey && lastClickedRef.current && lastClickedRef.current !== path) {
                const currentResults = results.filter(r => {
                    if (activeTab === 'all') return true;
                    if (activeTab === 'train') return r.should_annotate && r.category !== 'watermark' && (includeFace || r.category !== 'face_nsfw');
                    if (activeTab === 'face') return r.should_annotate && r.category === 'face_nsfw';
                    if (activeTab === 'watermark') return r.should_annotate && r.category === 'watermark';
                    if (activeTab === 'rejected') return !r.should_annotate;
                    return true;
                });
                const paths = currentResults.map(r => r.path);
                const a = paths.indexOf(lastClickedRef.current);
                const b = paths.indexOf(path);
                if (a >= 0 && b >= 0) {
                    const [lo, hi] = a < b ? [a, b] : [b, a];
                    for (let i = lo; i <= hi; i++) next.add(paths[i]);
                    lastClickedRef.current = path;
                    return next;
                }
            }
            if (next.has(path)) next.delete(path); else next.add(path);
            lastClickedRef.current = path;
            return next;
        });
    }, [results, activeTab, includeFace]);

    const batchMove = useCallback(async (targetCategory: string) => {
        const paths = [...selectedSet];
        if (paths.length === 0) return;
        try {
            await Promise.all(paths.map(p => {
                const existing = results.find(r => r.path === p);
                const fromCategory = existing?.category || 'unknown';
                return fetch('/api/image/prescreen/override', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: p,
                        should_annotate: true,
                        category: targetCategory,
                        error_category: 'wrong_category',
                        feedback_description: `User moved from ${fromCategory} to ${targetCategory}`,
                    }),
                });
            }));
            setResults(prev => prev.map(r =>
                selectedSet.has(r.path)
                    ? { ...r, should_annotate: true, category: targetCategory as PreScreenResult['category'], overridden: true }
                    : r
            ));
            const updatedResults = results.map(r =>
                selectedSet.has(r.path)
                    ? { ...r, should_annotate: true, category: targetCategory as PreScreenResult['category'] }
                    : r
            );
            setPassed(updatedResults.filter(x => x.should_annotate && !x.error).length);
            setRejected(updatedResults.filter(x => !x.should_annotate && !x.error).length);
            setSelectedSet(new Set());
            lastClickedRef.current = null;
        } catch { /* ignore */ }
    }, [selectedSet, results]);

    const batchReject = useCallback(async () => {
        const paths = [...selectedSet];
        if (paths.length === 0) return;
        try {
            await Promise.all(paths.map(p =>
                fetch('/api/image/prescreen/override', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: p, should_annotate: false }),
                })
            ));
            setResults(prev => prev.map(r =>
                selectedSet.has(r.path)
                    ? { ...r, should_annotate: false, overridden: true }
                    : r
            ));
            const updatedResults = results.map(r =>
                selectedSet.has(r.path) ? { ...r, should_annotate: false } : r
            );
            setPassed(updatedResults.filter(x => x.should_annotate && !x.error).length);
            setRejected(updatedResults.filter(x => !x.should_annotate && !x.error).length);
            setSelectedSet(new Set());
            lastClickedRef.current = null;
        } catch { /* ignore */ }
    }, [selectedSet, results]);

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (!(e.key === 'Delete' || e.key === 'Backspace')) return;
            const target = e.target as HTMLElement | null;
            if (!target) return;
            const tagName = target.tagName?.toLowerCase();
            if (tagName === 'input' || tagName === 'textarea' || target.isContentEditable) return;
            if (selectedSet.size === 0) return;
            e.preventDefault();
            batchReject();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [selectedSet, batchReject]);

    const handleOverrideClick = (path: string, currentValue: boolean) => {
        setFeedbackTarget({ path, currentValue });
        setFeedbackCategory("");
        setFeedbackDesc("");
    };

    const applyOverride = async (path: string, currentValue: boolean, category?: string, description?: string) => {
        try {
            const body: Record<string, unknown> = { path, should_annotate: !currentValue };
            if (category) body.error_category = category;
            if (description) body.feedback_description = description;
            const res = await fetch("/api/image/prescreen/override", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                setResults(prev => prev.map(r =>
                    r.path === path
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
        // 'other' requires a description; ignore category if empty desc.
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

    const handleRestore = async (path: string, category: string) => {
        try {
            const res = await fetch("/api/image/prescreen/override", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path, should_annotate: true, category }),
            });
            if (res.ok) {
                setResults(prev => prev.map(r =>
                    r.path === path
                        ? { ...r, should_annotate: true, category: category as "face_nsfw" | "body_nsfw", overridden: true }
                        : r
                ));
                setRejected(n => n - 1);
                setPassed(n => n + 1);
            }
        } catch { /* ignore */ }
        setRestoreTarget(null);
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
                <h2 className="batch-title">图片预筛选</h2>
                {onClose && (
                    <button className="batch-close" onClick={onClose} title="关闭">✕</button>
                )}
            </header>

            <div className="batch-info">
                当前有 <strong>{unannotatedCount}</strong> 张待筛选图片
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
                <div className="prescreen-history-card-header"
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setHistoryCollapsed(c => !c)}>
                    <span className="prescreen-history-card-title">筛选历史</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="prescreen-history-time">{historyLoading ? "加载中…" : `共 ${history.length} 批`}</span>
                        <span style={{ fontSize: 10, color: '#94a3b8', transition: 'transform 0.2s', display: 'inline-block', transform: historyCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                    </span>
                </div>
                {!historyCollapsed && (<>
                    {history.length === 0 ? (
                        <div className="prescreen-history-card-empty">暂无预筛选历史</div>
                    ) : (
                        <div className="prescreen-history-list" style={{ maxHeight: 240, overflowY: 'auto' }}>
                            {history.map((h) => (
                                <div
                                    key={h.batch_id}
                                    className={`prescreen-history-item ${selectedBatchId === h.batch_id ? 'active' : ''}`}
                                    style={{
                                        padding: '8px 10px',
                                        cursor: 'pointer',
                                        borderRadius: 6,
                                        marginBottom: 4,
                                        background: selectedBatchId === h.batch_id ? 'rgba(99,102,241,0.12)' : 'transparent',
                                        border: selectedBatchId === h.batch_id ? '1px solid rgba(99,102,241,0.4)' : '1px solid transparent',
                                        transition: 'all 0.15s',
                                    }}
                                    onClick={() => handleSelectBatch(h.batch_id)}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span className="prescreen-history-time" style={{ fontSize: 11 }}>
                                            {formatHistoryTime(h.started_at)}
                                        </span>
                                        <span className="prescreen-history-stat" style={{ color: "#4ade80", fontSize: 11 }}>✓{h.count_passed}</span>
                                        <span className="prescreen-history-stat" style={{ color: "#f87171", fontSize: 11 }}>✗{h.count_rejected}</span>
                                        {h.count_error > 0 && (
                                            <span className="prescreen-history-stat" style={{ color: "#fbbf24", fontSize: 11 }}>⚠{h.count_error}</span>
                                        )}
                                        {!h.completed_at && h.status === 'interrupted' && (
                                            <span style={{ color: "#ef4444", fontSize: 10 }}>已中断</span>
                                        )}
                                        {!h.completed_at && h.status !== 'interrupted' && h.status !== 'resumed' && (
                                            <span style={{ color: "#fbbf24", fontSize: 10 }}>运行中…</span>
                                        )}
                                        {h.status === 'resumed' && (
                                            <span style={{ color: "#94a3b8", fontSize: 10 }}>已恢复</span>
                                        )}
                                        {h.completed_at && !h.confirmed_at && (
                                            <span style={{ color: "#f59e0b", fontSize: 10 }}>⏳待确认</span>
                                        )}
                                        {h.confirmed_at && (
                                            <span style={{ color: "#22c55e", fontSize: 10 }}>✓已确认</span>
                                        )}
                                    </div>
                                </div>
                            ))}
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
                            title="删除所有图片预筛选记录"
                        >
                            重置全部
                        </button>
                        {resetMsg && (
                            <span className={`prescreen-reset-msg${resetMsg.kind === "error" ? " error" : ""}`}>
                                {resetMsg.text}
                            </span>
                        )}
                        {history.length > 0 && history[0].completed_at && !history[0].confirmed_at && state !== "running" && (
                            <button
                                type="button"
                                className="prescreen-reset-btn"
                                style={{ background: '#059669', color: '#fff', borderColor: '#059669' }}
                                onClick={async () => {
                                    setShowLearningModal(true);
                                    setLearningData(null);
                                    try {
                                        await fetch('/api/prescreen/batch/confirm', { method: 'POST' });
                                        refreshHistory();
                                        // 确认后清空主区域结果展示，已记录在筛选历史中
                                        setResults([]);
                                        setPassed(0);
                                        setRejected(0);
                                        setSelectedBatchId(null);
                                        const res = await fetch('/api/prescreen/feedback/summary');
                                        const data = await res.json();
                                        setLearningData(data);
                                    } catch { /* keep modal open with loading state */ }
                                }}
                            >
                                ✓ 确认清洗完毕
                            </button>
                        )}
                    </div>
                </>)}
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
                    <div className="batch-input-row">
                        <label>批处理图片数:</label>
                        <input
                            type="number"
                            min={1}
                            max={8}
                            value={batchSize}
                            onChange={e => setBatchSize(Math.max(1, Math.min(8, parseInt(e.target.value) || 1)))}
                            className="batch-count-input"
                            style={{ width: "60px" }}
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
                    {/* Two-phase model strategy configuration */}
                    <div style={{ marginTop: 12, padding: '12px', background: 'rgba(99,102,241,0.06)', borderRadius: 8, border: '1px solid rgba(99,102,241,0.15)' }}>
                        {/* Prescreen strategy */}
                        <div style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>预筛选策略</div>
                            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                                {(['single', 'vote', 'loadbalance'] as ModelStrategy[]).map(s => (
                                    <button
                                        key={s}
                                        type="button"
                                        onClick={() => setPrescreenStrategy(s)}
                                        style={{
                                            padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                                            border: prescreenStrategy === s ? '1px solid #6366f1' : '1px solid #444',
                                            background: prescreenStrategy === s ? 'rgba(99,102,241,0.2)' : 'transparent',
                                            color: prescreenStrategy === s ? '#a5b4fc' : '#94a3b8',
                                        }}
                                    >
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
                                                <input
                                                    type="checkbox"
                                                    checked={prescreenModels.includes(m.key)}
                                                    onChange={e => {
                                                        if (e.target.checked) setPrescreenModels(prev => [...prev, m.key]);
                                                        else setPrescreenModels(prev => prev.filter(k => k !== m.key));
                                                    }}
                                                    style={{ accentColor: '#6366f1' }}
                                                />
                                                {m.label}
                                            </label>
                                        ))}
                                    </div>
                                    {prescreenStrategy === 'vote' && (
                                        <div style={{ marginTop: 6 }}>
                                            <span style={{ fontSize: 11, color: '#94a3b8', marginRight: 6 }}>仲裁模型：</span>
                                            <select
                                                value={prescreenArbiter}
                                                onChange={e => setPrescreenArbiter(e.target.value)}
                                                style={{ fontSize: 11, padding: '3px 6px', borderRadius: 4, border: '1px solid #444', background: '#1e1e2e', color: '#e2e8f0' }}
                                            >
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
                            <>正在筛选 {current}/{total} — <span className="batch-current-name">{currentImage}</span></>
                        ) : state === "done" ? (
                            <>筛选完成 ({total} 张图片)</>
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

                    {batchResultsLoading && (
                        <div style={{ padding: '12px 0', color: '#94a3b8', fontSize: 12, textAlign: 'center' as const }}>
                            加载筛选记录中…
                        </div>
                    )}

                    {results.length > 0 && (() => {
                        const tabCounts = {
                            all: results.length,
                            train: results.filter(r => r.should_annotate && r.category !== 'face_nsfw' && r.category !== 'watermark').length,
                            face: results.filter(r => r.should_annotate && r.category === 'face_nsfw').length,
                            watermark: results.filter(r => r.should_annotate && r.category === 'watermark').length,
                            rejected: results.filter(r => !r.should_annotate).length,
                        };
                        return (
                            <div className="batch-results">
                                <h3>筛选记录</h3>
                                {selectedSet.size > 0 && (
                                    <div className="prescreen-batch-bar">
                                        <span className="prescreen-batch-count">已选 <b>{selectedSet.size}</b> 张</span>
                                        <button className="prescreen-batch-btn" onClick={() => setSelectedSet(new Set(filteredResults.map(r => r.path)))}>全选</button>
                                        <button className="prescreen-batch-btn" onClick={() => { setSelectedSet(new Set()); lastClickedRef.current = null; }}>清除</button>
                                        <button className="prescreen-batch-btn prescreen-batch-move" onClick={() => batchMove('body_nsfw')}>🔥 移到训练素材</button>
                                        <button className="prescreen-batch-btn prescreen-batch-move" onClick={() => batchMove('face_nsfw')}>🎭 移到换脸素材</button>
                                        <button className="prescreen-batch-btn prescreen-batch-move" onClick={() => batchMove('watermark')}>💧 移到待去水印</button>
                                        <button className="prescreen-batch-btn prescreen-batch-reject" onClick={batchReject}>🗑 排除选中 ({selectedSet.size})</button>
                                    </div>
                                )}
                                <div className="prescreen-tab-bar">
                                    {([
                                        { key: 'all', label: '全部' },
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
                                {activeTab === 'train' && (
                                    <label className="prescreen-tab-toggle">
                                        <input
                                            type="checkbox"
                                            checked={includeFace}
                                            onChange={e => setIncludeFace(e.target.checked)}
                                        />
                                        包含换脸素材
                                    </label>
                                )}
                                <ul className="batch-result-list">
                                    {filteredResults.map((r, i) => (
                                        <li key={i} className={`batch-result-item ${getResultClass(r)}`}>
                                            <div
                                                className={`prescreen-check ${selectedSet.has(r.path) ? 'is-checked' : ''}`}
                                                onClick={(e) => { e.stopPropagation(); toggleSelect(r.path, e.shiftKey); }}
                                                title="选中以批量操作"
                                            >
                                                <span className="prescreen-check-mark">✓</span>
                                            </div>
                                            <img
                                                className="batch-result-thumb"
                                                src={`/api/images/serve?path=${encodeURIComponent(r.path)}`}
                                                alt={r.name}
                                                loading="lazy"
                                                onClick={() => setPreviewPath(previewPath === r.path ? null : r.path)}
                                            />
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
                                            {r.voters && r.voters.length > 0 && (
                                                <details style={{ marginTop: 4, fontSize: 11, width: '100%' }}>
                                                    <summary style={{ cursor: 'pointer', color: '#94a3b8' }}>投票详情 ({r.voters.length} 模型)</summary>
                                                    <div style={{ paddingLeft: 12, marginTop: 4 }}>
                                                        {r.voters.map((v, vi) => (
                                                            <div key={vi} style={{ color: v.should_annotate ? '#86efac' : '#fca5a5', marginBottom: 2 }}>
                                                                <span style={{ color: '#cbd5e1' }}>{v.model}:</span> {v.should_annotate ? '✓' : '✗'} {v.reason} <span style={{ color: '#64748b' }}>({v.confidence}, {v.category})</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </details>
                                            )}
                                            {!r.should_annotate ? (
                                                <span className="prescreen-restore-wrapper">
                                                    <button
                                                        className="batch-override-btn prescreen-restore-btn"
                                                        onClick={() => setRestoreTarget(restoreTarget === r.path ? null : r.path)}
                                                        title="恢复为通过"
                                                    >
                                                        恢复
                                                    </button>
                                                    {restoreTarget === r.path && (
                                                        <span className="prescreen-restore-menu">
                                                            <button onClick={() => handleRestore(r.path, 'body_nsfw')}>训练素材</button>
                                                            <button onClick={() => handleRestore(r.path, 'face_nsfw')}>换脸素材</button>
                                                        </span>
                                                    )}
                                                </span>
                                            ) : (
                                                <button
                                                    className="batch-override-btn"
                                                    onClick={() => handleOverrideClick(r.path, r.should_annotate)}
                                                    title="推翻为拒绝"
                                                >
                                                    推翻
                                                </button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        );
                    })()}
                </div>
            )}

            {feedbackTarget && (
                <div
                    className="prescreen-feedback-overlay"
                    onClick={(e) => { if (e.target === e.currentTarget) handleOverrideCancel(); }}
                    onKeyDown={(e) => { if (e.key === 'Escape') handleOverrideCancel(); }}
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

            {/* Image preview lightbox */}
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

            {/* AI learning summary modal */}
            {showLearningModal && (
                <div
                    className="prescreen-feedback-overlay"
                    onClick={(e) => { if (e.target === e.currentTarget) setShowLearningModal(false); }}
                    role="presentation"
                >
                    <div className="prescreen-feedback-modal" style={{ maxWidth: 520 }} role="dialog" aria-modal="true">
                        <h4>🧠 AI 学习摘要</h4>
                        {learningData ? (
                            <>
                                <p style={{ color: '#94a3b8', fontSize: 12, margin: '8px 0' }}>
                                    基于最近 30 天内 {learningData.total} 条人工纠错反馈，AI 已学到以下规则：
                                </p>
                                {learningData.rules ? (
                                    <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#e2e8f0', background: '#1e293b', padding: 12, borderRadius: 6, maxHeight: 300, overflow: 'auto' }}>
                                        {learningData.rules}
                                    </pre>
                                ) : (
                                    <p style={{ color: '#fbbf24' }}>暂无有效的学习规则</p>
                                )}
                                {learningData.stats && learningData.stats.length > 0 && (
                                    <div style={{ marginTop: 12 }}>
                                        <h5 style={{ color: '#94a3b8', fontSize: 11, marginBottom: 6 }}>纠错统计明细</h5>
                                        <ul style={{ listStyle: 'none', padding: 0, fontSize: 12 }}>
                                            {learningData.stats.map((s: any, i: number) => (
                                                <li key={i} style={{ color: '#cbd5e1', marginBottom: 4 }}>
                                                    <span style={{ color: '#6366f1' }}>{s.cnt}×</span>{' '}
                                                    {s.description || s.error_category}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </>
                        ) : (
                            <p style={{ color: '#94a3b8' }}>加载中…</p>
                        )}
                        <div style={{ marginTop: 16, textAlign: 'right' }}>
                            <button
                                className="prescreen-feedback-btn-confirm"
                                onClick={() => { setShowLearningModal(false); onClose?.(); }}
                            >
                                确认并关闭
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
