import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./ImageBrowser.css";
import CreateAlert from "../Scripts/CreateAlert";

export interface RemoteImage {
    path: string;
    name: string;
    folder: string;
    size: number;
    mtime: number;
    ext: string;
}

interface FolderInfo {
    folder: string;
    count: number;
    size: number;
}

interface ImageCatalogue {
    root: string;
    count: number;
    totalSize: number;
    totalFiltered: number;
    page: number;
    limit: number;
    totalPages: number;
    groups: FolderInfo[];
    items: RemoteImage[];
    status?: string;
}

interface AnnotationData {
    id: number;
    path: string;
    name: string;
    prompt: string | null;
    description: string | null;
    dimensions: Record<string, string[]>;
    tags: string[];
    model_id: string | null;
    created_at: string;
    video_prompt: string | null;
    video_prompt_model: string | null;
}

interface Props {
    onPick?: (image: RemoteImage) => void;
    annotationsVersion?: number;
    initialImagePath?: string | null;
    onPrescreenChange?: () => void;
}

const FOLDER_ALL = "__ALL__";
const PAGE_SIZE = 100;

function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(digits)} ${units[i]}`;
}

function fmtNum(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "—";
    return n.toLocaleString("en-US");
}

function formatBatchTime(iso: string | null | undefined): string {
    if (!iso) return "未知时间";
    try {
        const d = new Date(iso);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return iso || "未知时间"; }
}

type SortMode = "recent" | "size" | "name";
type TabMode = "unannotated" | "train" | "face" | "rejected" | "watermark" | "annotated";

const PRESCREEN_ERROR_CATEGORIES: { value: string; label: string }[] = [
    { value: 'mosaic_false_pass', label: '马赛克误通过' },
    { value: 'blur_false_pass', label: '模糊误通过' },
    { value: 'clear_false_reject', label: '清晰误拒绝' },
    { value: 'sfw_false_pass', label: '非NSFW误通过' },
    { value: 'low_quality_false_pass', label: '低质量误通过' },
    { value: 'ai_generated_false_pass', label: 'AI生成误通过' },
    { value: 'face_category_wrong', label: '人脸分类错误' },
    { value: 'other', label: '其他' },
];

export default function ImageBrowser({ onPick, annotationsVersion = 0, initialImagePath, onPrescreenChange }: Props) {
    const [data, setData] = useState<ImageCatalogue | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [activeFolder, setActiveFolder] = useState<string>(FOLDER_ALL);
    const [sort, setSort] = useState<SortMode>("recent");
    const [tab, setTab] = useState<TabMode>("unannotated");
    const [annotatedPaths, setAnnotatedPaths] = useState<Set<string>>(new Set());
    const [skippedPaths, setSkippedPaths] = useState<Set<string>>(new Set());
    const [skipReasons, setSkipReasons] = useState<Record<string, string>>({});
    const [prescreenedPaths, setPrescreenedPaths] = useState<Map<string, { status: string, reason: string, confidence: string, category: string, batch_id?: string, prescreened_at?: string }>>(new Map());

    // Annotation detail view
    const [selectedImage, setSelectedImage] = useState<RemoteImage | null>(null);
    const [annotation, setAnnotation] = useState<AnnotationData | null>(null);
    const [annotationLoading, setAnnotationLoading] = useState(false);

    // Single image analysis state
    const [analyzingPath, setAnalyzingPath] = useState<string | null>(null);
    const [analyzeError, setAnalyzeError] = useState<string | null>(null);
    const [selectedModel, setSelectedModel] = useState<string>('kimi');
    const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(false);

    // Lightbox (double-click zoom)
    const [lightboxPath, setLightboxPath] = useState<string | null>(null);

    // Prescreen feedback/override state
    const [feedbackTarget, setFeedbackTarget] = useState<{ path: string; currentPassed: boolean } | null>(null);
    const [feedbackCategory, setFeedbackCategory] = useState<string>("");
    const [feedbackDesc, setFeedbackDesc] = useState<string>("");
    const [restoreMenuPath, setRestoreMenuPath] = useState<string | null>(null);

    // Close lightbox on ESC
    useEffect(() => {
        if (!lightboxPath) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') setLightboxPath(null);
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [lightboxPath]);

    // Pagination: only render a window of items to avoid DOM overload
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const loadMoreRef = useRef<HTMLDivElement>(null);

    // Multi-select for batch reject (only used in unannotated tab)
    const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
    const lastClickedRef = useRef<string | null>(null);

    // Fetch annotated image paths
    useEffect(() => {
        let cancelled = false;
        fetch("/api/images/annotated")
            .then(r => r.json())
            .then(d => {
                if (cancelled) return;
                if (d.success) {
                    setAnnotatedPaths(new Set(d.data as string[]));
                }
            })
            .catch(() => { /* ignore */ });
        fetch("/api/images/skipped")
            .then(r => r.json())
            .then(d => {
                if (cancelled) return;
                if (d.success && Array.isArray(d.data)) {
                    setSkippedPaths(new Set(d.data.map((item: { path: string }) => item.path)));
                    const reasons: Record<string, string> = {};
                    d.data.forEach((item: { path: string; reason: string }) => {
                        if (item.reason) reasons[item.path] = item.reason;
                    });
                    setSkipReasons(reasons);
                }
            })
            .catch(() => { /* ignore */ });
        fetch("/api/images/prescreened")
            .then(r => r.json())
            .then(d => {
                if (cancelled) return;
                if (d.success && Array.isArray(d.data)) {
                    const map = new Map<string, { status: string, reason: string, confidence: string, category: string, batch_id?: string, prescreened_at?: string }>();
                    d.data.forEach((item: { path: string; status: string; reason: string; confidence: string; category?: string; batch_id?: string; prescreened_at?: string }) => {
                        map.set(item.path, { status: item.status, reason: item.reason, confidence: item.confidence, category: item.category || 'none', batch_id: item.batch_id || undefined, prescreened_at: item.prescreened_at || undefined });
                    });
                    setPrescreenedPaths(map);
                }
            })
            .catch(() => { /* ignore */ });
        return () => { cancelled = true; };
    }, [annotationsVersion]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (activeFolder !== FOLDER_ALL) params.set("folder", activeFolder);
            if (query.trim()) params.set("q", query.trim());
            params.set("sort", sort);
            params.set("limit", "0");
            const res = await fetch(`/api/images?${params.toString()}`, { cache: "no-store" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: ImageCatalogue = await res.json();
            if (json.status === "scanning") {
                setData(null);
            } else {
                setData(json);
            }
        } catch (e: any) {
            setError(e?.message || "Failed to reach the image API.");
        } finally {
            setLoading(false);
        }
    }, [activeFolder, query, sort]);

    useEffect(() => { load(); }, [load]);

    // Auto-select image from URL on initial load
    const initialSelectDone = useRef(false);
    useEffect(() => {
        if (initialSelectDone.current || !initialImagePath || !data?.items?.length) return;
        const target = data.items.find(img => img.path === initialImagePath);
        if (target) {
            initialSelectDone.current = true;
            handleImageClick(target);
        }
    }, [data, initialImagePath]);

    const rawItems = data?.items ?? [];

    const filteredItems = useMemo(() => {
        switch (tab) {
            case "annotated":
                return rawItems.filter(v => annotatedPaths.has(v.path));
            case "rejected":
                return rawItems.filter(v => {
                    if (annotatedPaths.has(v.path)) return false;
                    // 打标阶段跳过的
                    if (skippedPaths.has(v.path)) return true;
                    // 筛选阶段拒绝的
                    return prescreenedPaths.has(v.path) &&
                        prescreenedPaths.get(v.path)!.status === 'rejected';
                });
            case "train":
                return rawItems.filter(v => {
                    const ps = prescreenedPaths.get(v.path);
                    if (!ps || ps.status !== 'passed') return false;
                    if (annotatedPaths.has(v.path) || skippedPaths.has(v.path)) return false;
                    return ps.category !== 'face_nsfw' && ps.category !== 'watermark';
                });
            case "face":
                return rawItems.filter(v => {
                    const ps = prescreenedPaths.get(v.path);
                    if (!ps || ps.status !== 'passed') return false;
                    if (annotatedPaths.has(v.path) || skippedPaths.has(v.path)) return false;
                    return ps.category === 'face_nsfw';
                });
            case "watermark":
                return rawItems.filter(v => {
                    const ps = prescreenedPaths.get(v.path);
                    if (!ps || ps.status !== 'passed') return false;
                    if (annotatedPaths.has(v.path) || skippedPaths.has(v.path)) return false;
                    return ps.category === 'watermark';
                });
            case "unannotated":
            default:
                return rawItems.filter(v => !annotatedPaths.has(v.path) && !skippedPaths.has(v.path) && !prescreenedPaths.has(v.path));
        }
    }, [rawItems, tab, annotatedPaths, skippedPaths, prescreenedPaths]);

    // Only render visible slice for performance
    const visibleItems = useMemo(() =>
        filteredItems.slice(0, visibleCount),
        [filteredItems, visibleCount]
    );

    // Determine if current tab is a prescreen tab that should show batch grouping
    const isPrescreenTab = tab === 'train' || tab === 'face' || tab === 'watermark' || tab === 'rejected';

    // Group filtered items by batch for prescreen tabs
    const groupedByBatch = useMemo(() => {
        if (!isPrescreenTab) return [];
        const groups = new Map<string, { batch_id: string; prescreened_at: string; items: typeof filteredItems }>();
        const noBatch: typeof filteredItems = [];

        for (const item of filteredItems) {
            const ps = prescreenedPaths.get(item.path);
            const batchId = ps?.batch_id;
            if (!batchId) {
                noBatch.push(item);
                continue;
            }
            if (!groups.has(batchId)) {
                groups.set(batchId, { batch_id: batchId, prescreened_at: ps?.prescreened_at || '', items: [] });
            }
            groups.get(batchId)!.items.push(item);
        }

        // Sort groups by prescreened_at descending (most recent first)
        const sorted = [...groups.values()].sort((a, b) => {
            if (!a.prescreened_at && !b.prescreened_at) return 0;
            if (!a.prescreened_at) return 1;
            if (!b.prescreened_at) return -1;
            return new Date(b.prescreened_at).getTime() - new Date(a.prescreened_at).getTime();
        });

        // Append items without batch at the end
        if (noBatch.length > 0) {
            sorted.push({ batch_id: '__no_batch__', prescreened_at: '', items: noBatch });
        }

        return sorted;
    }, [filteredItems, isPrescreenTab, prescreenedPaths]);

    // IntersectionObserver to auto-load more items on scroll
    useEffect(() => {
        const node = loadMoreRef.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && visibleCount < filteredItems.length) {
                    setVisibleCount(prev => Math.min(prev + PAGE_SIZE, filteredItems.length));
                }
            },
            { threshold: 0.1 }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [visibleCount, filteredItems.length]);

    // Reset visible count when tab or filter changes
    useEffect(() => {
        setVisibleCount(PAGE_SIZE);
    }, [tab, activeFolder, query, sort]);

    const unannotatedCount = useMemo(
        () => rawItems.filter(v => !annotatedPaths.has(v.path) && !skippedPaths.has(v.path) && !prescreenedPaths.has(v.path)).length,
        [rawItems, annotatedPaths, skippedPaths, prescreenedPaths]
    );
    const trainCount = useMemo(
        () => rawItems.filter(v => {
            const ps = prescreenedPaths.get(v.path);
            if (!ps || ps.status !== 'passed') return false;
            if (annotatedPaths.has(v.path) || skippedPaths.has(v.path)) return false;
            return ps.category !== 'face_nsfw' && ps.category !== 'watermark';
        }).length,
        [rawItems, prescreenedPaths, annotatedPaths, skippedPaths]
    );
    const faceCount = useMemo(
        () => rawItems.filter(v => {
            const ps = prescreenedPaths.get(v.path);
            if (!ps || ps.status !== 'passed') return false;
            if (annotatedPaths.has(v.path) || skippedPaths.has(v.path)) return false;
            return ps.category === 'face_nsfw';
        }).length,
        [rawItems, prescreenedPaths, annotatedPaths, skippedPaths]
    );
    const rejectedCount = useMemo(
        () => rawItems.filter(v => {
            if (annotatedPaths.has(v.path)) return false;
            if (skippedPaths.has(v.path)) return true;
            return prescreenedPaths.has(v.path) &&
                prescreenedPaths.get(v.path)!.status === 'rejected';
        }
        ).length,
        [rawItems, prescreenedPaths, annotatedPaths, skippedPaths]
    );
    const watermarkCount = useMemo(
        () => rawItems.filter(v => {
            const ps = prescreenedPaths.get(v.path);
            if (!ps || ps.status !== 'passed') return false;
            if (annotatedPaths.has(v.path) || skippedPaths.has(v.path)) return false;
            return ps.category === 'watermark';
        }).length,
        [rawItems, prescreenedPaths, annotatedPaths, skippedPaths]
    );
    const annotatedCount = useMemo(
        () => rawItems.filter(v => annotatedPaths.has(v.path)).length,
        [rawItems, annotatedPaths]
    );

    // Per-category annotated counts (intersect annotatedPaths with prescreen category)
    const annotatedFaceCount = useMemo(
        () => rawItems.filter(v => {
            if (!annotatedPaths.has(v.path)) return false;
            const ps = prescreenedPaths.get(v.path);
            return ps?.category === 'face_nsfw';
        }).length,
        [rawItems, annotatedPaths, prescreenedPaths]
    );
    const annotatedWatermarkCount = useMemo(
        () => rawItems.filter(v => {
            if (!annotatedPaths.has(v.path)) return false;
            const ps = prescreenedPaths.get(v.path);
            return ps?.category === 'watermark';
        }).length,
        [rawItems, annotatedPaths, prescreenedPaths]
    );
    const annotatedTrainCount = useMemo(
        () => rawItems.filter(v => {
            if (!annotatedPaths.has(v.path)) return false;
            const ps = prescreenedPaths.get(v.path);
            // Annotated images without prescreen record, or prescreened as non-face/non-watermark, count as training
            if (!ps) return true;
            return ps.category !== 'face_nsfw' && ps.category !== 'watermark';
        }).length,
        [rawItems, annotatedPaths, prescreenedPaths]
    );

    // Category totals (annotated + pending) — "已标注 + 待标注" 守恒
    const trainTotal = annotatedTrainCount + trainCount;
    const faceTotal = annotatedFaceCount + faceCount;
    const watermarkTotal = annotatedWatermarkCount + watermarkCount;
    const grandAnnotated = annotatedTrainCount + annotatedFaceCount + annotatedWatermarkCount;

    // Handle image click - show annotation detail
    const handleImageClick = useCallback(async (img: RemoteImage) => {
        setSelectedImage(img);
        setAnalyzeError(null);
        onPick?.(img);
        if (annotatedPaths.has(img.path)) {
            setAnnotationLoading(true);
            try {
                const res = await fetch(`/api/image/annotation?path=${encodeURIComponent(img.path)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.success) setAnnotation(data.data);
                    else setAnnotation(null);
                } else {
                    setAnnotation(null);
                }
            } catch {
                setAnnotation(null);
            } finally {
                setAnnotationLoading(false);
            }
        } else {
            setAnnotation(null);
        }
    }, [annotatedPaths, onPick]);

    // Single image AI analysis
    const handleAnalyzeSingle = useCallback(async (img: RemoteImage) => {
        setAnalyzingPath(img.path);
        setAnalyzeError(null);
        try {
            const res = await fetch('/api/image/analyze/single', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: img.path, model: selectedModel, thinking: thinkingEnabled }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                setAnalyzeError(json.error || `分析失败 (HTTP ${res.status})`);
            } else if (json.skipped) {
                // AI decided to skip this image
                setSkippedPaths(prev => new Set([...prev, img.path]));
                setAnnotatedPaths(prev => { const n = new Set(prev); n.delete(img.path); return n; });
                setSkipReasons(prev => ({ ...prev, [img.path]: json.skip_reason || 'AI auto-skip' }));
                setAnnotation(null);
            } else {
                // Update annotated paths set
                setAnnotatedPaths(prev => new Set([...prev, img.path]));
                setSkippedPaths(prev => { const n = new Set(prev); n.delete(img.path); return n; });
                // Show annotation result
                setAnnotation(json.data);
            }
        } catch (err: any) {
            setAnalyzeError(err?.message || '网络错误');
        } finally {
            setAnalyzingPath(null);
        }
    }, [selectedModel, thinkingEnabled]);

    // Toggle selection of an image (with optional shift-range selection)
    const toggleSelect = useCallback((path: string, shiftKey: boolean) => {
        setSelectedSet(prev => {
            const next = new Set(prev);
            if (shiftKey && lastClickedRef.current && lastClickedRef.current !== path) {
                const visiblePaths = filteredItems.map(it => it.path);
                const a = visiblePaths.indexOf(lastClickedRef.current);
                const b = visiblePaths.indexOf(path);
                if (a >= 0 && b >= 0) {
                    const [lo, hi] = a < b ? [a, b] : [b, a];
                    for (let i = lo; i <= hi; i++) next.add(visiblePaths[i]);
                    lastClickedRef.current = path;
                    return next;
                }
            }
            if (next.has(path)) next.delete(path); else next.add(path);
            lastClickedRef.current = path;
            return next;
        });
    }, [filteredItems]);

    const handleSelectAll = useCallback(() => {
        setSelectedSet(new Set(filteredItems.map(it => it.path)));
    }, [filteredItems]);

    const handleClearSelection = useCallback(() => {
        setSelectedSet(new Set());
        lastClickedRef.current = null;
    }, []);

    // Reset selection when leaving selectable tabs
    useEffect(() => {
        if (tab !== 'unannotated' && tab !== 'train' && tab !== 'face' && tab !== 'watermark' && selectedSet.size > 0) {
            setSelectedSet(new Set());
            lastClickedRef.current = null;
        }
    }, [tab, selectedSet.size]);

    // Batch reject selected images
    const handleBatchReject = useCallback(async () => {
        const paths = [...selectedSet];
        if (paths.length === 0) return;
        try {
            const res = await fetch('/api/image/skip/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths }),
            });
            const json = await res.json();
            if (json.success) {
                CreateAlert(`已跳过 ${paths.length} 张图片`);
                setSkippedPaths(prev => {
                    const n = new Set(prev);
                    paths.forEach(p => n.add(p));
                    return n;
                });
                setAnnotatedPaths(prev => {
                    const n = new Set(prev);
                    paths.forEach(p => n.delete(p));
                    return n;
                });
                setSkipReasons(prev => {
                    const n = { ...prev };
                    paths.forEach(p => { n[p] = 'Manual reject'; });
                    return n;
                });
                setSelectedSet(new Set());
                lastClickedRef.current = null;
                onPrescreenChange?.();
            }
        } catch { CreateAlert("批量跳过失败，请重试"); }
    }, [selectedSet, onPrescreenChange]);

    // Batch move selected images to a category
    const handleBatchMove = useCallback(async (targetCategory: string) => {
        const paths = [...selectedSet];
        if (paths.length === 0) return;
        try {
            await Promise.all(paths.map(p => {
                const existing = prescreenedPaths.get(p);
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
            setPrescreenedPaths(prev => {
                const next = new Map(prev);
                paths.forEach(p => {
                    const existing = next.get(p);
                    if (existing) {
                        next.set(p, { ...existing, status: 'passed', category: targetCategory });
                    } else {
                        next.set(p, { status: 'passed', category: targetCategory } as any);
                    }
                });
                return next;
            });
            setSelectedSet(new Set());
            lastClickedRef.current = null;
            onPrescreenChange?.();
        } catch { /* ignore */ }
    }, [selectedSet, prescreenedPaths, onPrescreenChange]);

    // Keyboard: Delete/Backspace triggers batch reject
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (!(e.key === 'Delete' || e.key === 'Backspace')) return;
            const target = e.target as HTMLElement | null;
            if (!target) return;
            const tagName = target.tagName?.toLowerCase();
            if (tagName === 'input' || tagName === 'textarea' || target.isContentEditable) return;
            if (selectedSet.size === 0) return;
            e.preventDefault();
            handleBatchReject();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [selectedSet, handleBatchReject]);

    // Manual skip
    const handleSkip = useCallback(async (img: RemoteImage) => {
        try {
            const res = await fetch('/api/image/skip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: img.path }),
            });
            const json = await res.json();
            if (json.success) {
                CreateAlert(`已跳过 ${img.name}`);
                setSkippedPaths(prev => new Set([...prev, img.path]));
                setAnnotatedPaths(prev => { const n = new Set(prev); n.delete(img.path); return n; });
                setSkipReasons(prev => ({ ...prev, [img.path]: 'Manual skip' }));
                setAnnotation(null);
            }
        } catch { CreateAlert("跳过失败，请重试"); }
    }, []);

    // Unskip
    const handleUnskip = useCallback(async (img: RemoteImage) => {
        try {
            const res = await fetch('/api/image/unskip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: img.path }),
            });
            const json = await res.json();
            if (json.success) {
                CreateAlert(`已恢复 ${img.name}`);
                setSkippedPaths(prev => { const n = new Set(prev); n.delete(img.path); return n; });
                setSkipReasons(prev => { const n = { ...prev }; delete n[img.path]; return n; });
            }
        } catch { CreateAlert("恢复失败，请重试"); }
    }, []);

    const handleLinkCharacter = useCallback(async () => {
        if (!selectedImage || !annotation) return;
        try {
            const res = await fetch('http://localhost:9091/api/characters/list');
            const chars: { id: number; name: string; category: string }[] = await res.json();
            const options = chars.map((c, i) => `${i + 1}. ${c.name} (${c.category})`).join('\n');
            const input = prompt(`选择角色 (输入序号):\n${options}`);
            if (!input) return;
            const idx = parseInt(input) - 1;
            if (isNaN(idx) || idx < 0 || idx >= chars.length) { alert('无效序号'); return; }
            const char = chars[idx];
            const linkRes = await fetch('http://localhost:9091/api/ref-images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    character_id: char.id,
                    image_url: `http://localhost:8899/api/images/serve?path=${encodeURIComponent(selectedImage.path)}`,
                    prompt: annotation.prompt || '',
                    dimensions: annotation.dimensions || {},
                    tags: annotation.tags || [],
                    style: '',
                    description: annotation.description || '',
                }),
            });
            const linkJson = await linkRes.json();
            if (linkJson.status === 'ok') {
                alert(`已关联到 ${char.name}`);
            } else {
                alert('关联失败: ' + (linkJson.error || 'unknown'));
            }
        } catch (e: any) {
            alert('CM 连接失败: ' + e.message);
        }
    }, [selectedImage, annotation]);

    // Prescreen override: reject a passed image (with optional feedback)
    const handlePrescreenOverride = useCallback(async (path: string, errorCategory?: string, description?: string) => {
        try {
            const body: Record<string, unknown> = { path, should_annotate: false };
            if (errorCategory) body.error_category = errorCategory;
            if (description) body.feedback_description = description;
            const res = await fetch('/api/image/prescreen/override', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                setPrescreenedPaths(prev => {
                    const next = new Map(prev);
                    const existing = next.get(path);
                    if (existing) next.set(path, { ...existing, status: 'rejected' });
                    return next;
                });
                onPrescreenChange?.();
            }
        } catch { /* ignore */ }
    }, [onPrescreenChange]);

    // Prescreen restore: restore a rejected image to passed with category
    const handlePrescreenRestore = useCallback(async (path: string, category: string) => {
        try {
            const res = await fetch('/api/image/prescreen/override', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, should_annotate: true, category }),
            });
            if (res.ok) {
                setPrescreenedPaths(prev => {
                    const next = new Map(prev);
                    const existing = next.get(path);
                    if (existing) next.set(path, { ...existing, status: 'passed', category });
                    return next;
                });
                onPrescreenChange?.();
            }
        } catch { /* ignore */ }
        setRestoreMenuPath(null);
    }, [onPrescreenChange]);

    // Category switch: move between train and face
    const handleCategorySwitch = useCallback(async (path: string, newCategory: string) => {
        try {
            const res = await fetch('/api/image/prescreen/override', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, should_annotate: true, category: newCategory }),
            });
            if (res.ok) {
                setPrescreenedPaths(prev => {
                    const next = new Map(prev);
                    const existing = next.get(path);
                    if (existing) next.set(path, { ...existing, category: newCategory });
                    return next;
                });
                onPrescreenChange?.();
            }
        } catch { /* ignore */ }
    }, [onPrescreenChange]);

    // Feedback modal handlers
    const openFeedbackModal = (path: string, currentPassed: boolean) => {
        setFeedbackTarget({ path, currentPassed });
        setFeedbackCategory("");
        setFeedbackDesc("");
    };
    const handleFeedbackConfirm = async () => {
        if (!feedbackTarget) return;
        const cat = feedbackCategory || undefined;
        const desc = feedbackDesc.trim() || undefined;
        const finalCat = cat === 'other' && !desc ? undefined : cat;
        await handlePrescreenOverride(feedbackTarget.path, finalCat, desc);
        setFeedbackTarget(null);
    };
    const handleFeedbackSkip = async () => {
        if (!feedbackTarget) return;
        await handlePrescreenOverride(feedbackTarget.path);
        setFeedbackTarget(null);
    };

    // Dimension display name mapping
    const dimensionLabels: Record<string, string> = {
        '01_scene': '01 场景',
        '02_shot': '02 镜头',
        '03_subject_count': '03 人数',
        '04_gender': '04 性别',
        '05_body': '05 体型',
        '06_skin': '06 肤色',
        '07_expression': '07 表情眼神',
        '08_hair': '08 发型',
        '09_clothing': '09 服饰',
        '10_pose': '10 姿态',
        '11_action': '11 动作',
        '12_interaction': '12 互动',
        '13_style': '13 风格',
        '14_persona': '14 人设',
    };

    return (
        <section className="ib-shell" aria-label="Image archive">
            <header className="ib-mast">
                <div>
                    <div className="ib-eyebrow">Image Archive · /images</div>
                    <h2 className="ib-title">The <em>gallery</em>.</h2>
                </div>
                <div className="ib-meta">
                    {data ? <>
                        <b>{String(data.count).padStart(4, "0")}</b> images indexed{"\n"}
                        <b>{fmtBytes(data.totalSize)}</b> total weight{"\n"}
                        <b>{data.groups.length}</b> folders
                    </> : loading ? <>
                        <span className="ib-pulse" />scanning images…
                    </> : null}
                </div>
            </header>

            <div className="ib-stat-strip" role="group" aria-label="分类统计摘要">
                <div className="ib-stat-strip-label">分类统计</div>
                <div className="ib-stat-segments">
                    <div className="ib-stat-seg ib-stat-seg--face">
                        <span className="ib-stat-seg-icon" aria-hidden="true">🎭</span>
                        <span className="ib-stat-seg-name">换脸素材</span>
                        <span className="ib-stat-seg-num">{fmtNum(annotatedFaceCount)}</span>
                        <span className="ib-stat-seg-suffix">已标注 / 总 {fmtNum(faceTotal)}</span>
                    </div>
                    <div className="ib-stat-seg ib-stat-seg--train">
                        <span className="ib-stat-seg-icon" aria-hidden="true">🔥</span>
                        <span className="ib-stat-seg-name">训练素材</span>
                        <span className="ib-stat-seg-num">{fmtNum(annotatedTrainCount)}</span>
                        <span className="ib-stat-seg-suffix">已标注 / 总 {fmtNum(trainTotal)}</span>
                    </div>
                    <div className="ib-stat-seg ib-stat-seg--watermark">
                        <span className="ib-stat-seg-icon" aria-hidden="true">💧</span>
                        <span className="ib-stat-seg-name">待去水印</span>
                        <span className="ib-stat-seg-num">{fmtNum(annotatedWatermarkCount)}</span>
                        <span className="ib-stat-seg-suffix">已标注 / 总 {fmtNum(watermarkTotal)}</span>
                    </div>
                </div>
                <div className="ib-stat-grand">
                    <span className="ib-stat-grand-label">总计已标注</span>
                    <span className="ib-stat-grand-num">{fmtNum(grandAnnotated)}</span>
                </div>
            </div>

            <div className="ib-toolbar">
                <div className="ib-tab-bar">
                    <button
                        className={tab === "unannotated" ? "active" : ""}
                        onClick={() => setTab("unannotated")}
                        title="尚未进入预筛选流程的原始图片"
                    >
                        未标注 ({fmtNum(unannotatedCount)})
                    </button>
                    <button
                        className={tab === "train" ? "active" : ""}
                        onClick={() => setTab("train")}
                        title={`训练素材 · 已标注 ${fmtNum(annotatedTrainCount)} / 总 ${fmtNum(trainTotal)}`}
                    >
                        🔥 训练素材 (待标注 {fmtNum(trainCount)} / 总 {fmtNum(trainTotal)})
                    </button>
                    <button
                        className={tab === "face" ? "active" : ""}
                        onClick={() => setTab("face")}
                        title={`换脸素材 · 已标注 ${fmtNum(annotatedFaceCount)} / 总 ${fmtNum(faceTotal)}`}
                    >
                        🎭 换脸素材 (待标注 {fmtNum(faceCount)} / 总 {fmtNum(faceTotal)})
                    </button>
                    <button
                        className={tab === "rejected" ? "active" : ""}
                        onClick={() => setTab("rejected")}
                    >
                        已拒绝 ({fmtNum(rejectedCount)})
                    </button>
                    <button
                        className={tab === "watermark" ? "active" : ""}
                        onClick={() => setTab("watermark")}
                        title={`待去水印 · 已标注 ${fmtNum(annotatedWatermarkCount)} / 总 ${fmtNum(watermarkTotal)}`}
                    >
                        💧 待去水印 (待标注 {fmtNum(watermarkCount)} / 总 {fmtNum(watermarkTotal)})
                    </button>
                    <button
                        className={tab === "annotated" ? "active" : ""}
                        onClick={() => setTab("annotated")}
                    >
                        已标注 ({fmtNum(annotatedCount)})
                    </button>

                </div>
                <label className="ib-search">
                    <span className="ib-search-glyph">⌕</span>
                    <input
                        type="text"
                        placeholder="filter by filename…"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        spellCheck={false}
                    />
                </label>
                <div className="ib-sort" role="tablist" aria-label="Sort">
                    <button data-active={sort === "recent"} onClick={() => setSort("recent")}>Recent</button>
                    <button data-active={sort === "size"} onClick={() => setSort("size")}>Size</button>
                    <button data-active={sort === "name"} onClick={() => setSort("name")}>A → Z</button>
                </div>
                <button className="ib-refresh" onClick={load} disabled={loading}>
                    {loading ? "scanning…" : "↻ rescan"}
                </button>
            </div>

            {(tab === 'unannotated' || tab === 'train' || tab === 'face' || tab === 'watermark') && selectedSet.size > 0 && (
                <div className="ib-select-bar" role="toolbar" aria-label="Batch selection">
                    <span className="ib-select-count">已选 <b>{selectedSet.size}</b> 张</span>
                    <span className="ib-select-sep">·</span>
                    <button className="ib-select-btn" onClick={handleSelectAll}>全选当前页</button>
                    <button className="ib-select-btn" onClick={handleClearSelection}>清除选择</button>
                    <button className="ib-reject-btn" onClick={handleBatchReject}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                        排除选中 ({selectedSet.size})
                        <kbd>Del</kbd>
                    </button>
                    {tab !== 'face' && (
                        <button className="ib-batch-move-btn ib-move-face" onClick={() => handleBatchMove('face_nsfw')}>
                            🎭 移到换脸素材
                        </button>
                    )}
                    {tab !== 'train' && (
                        <button className="ib-batch-move-btn ib-move-train" onClick={() => handleBatchMove('body_nsfw')}>
                            🔥 移到训练素材
                        </button>
                    )}
                    {tab !== 'watermark' && (
                        <button className="ib-batch-move-btn ib-move-watermark" onClick={() => handleBatchMove('watermark')}>
                            💧 移到待去水印
                        </button>
                    )}
                </div>
            )}

            <div className="ib-body">
                <aside className="ib-sidebar">
                    <h3>Folders</h3>
                    <div
                        className="ib-folder"
                        data-active={activeFolder === FOLDER_ALL}
                        onClick={() => setActiveFolder(FOLDER_ALL)}
                    >
                        <span className="ib-folder-name">All folders</span>
                        <span className="ib-folder-count">{data?.count ?? "—"}</span>
                    </div>
                    {data?.groups.map(g => (
                        <div
                            key={g.folder}
                            className="ib-folder"
                            data-active={activeFolder === g.folder}
                            onClick={() => setActiveFolder(g.folder)}
                            title={g.folder}
                        >
                            <span className="ib-folder-name">{g.folder}</span>
                            <span className="ib-folder-count">{g.count}</span>
                        </div>
                    ))}
                </aside>

                <div className="ib-divider" aria-hidden="true" />

                <div className="ib-grid-area">
                    {error ? (
                        <div className="ib-state">
                            <b>offline</b><br />
                            <code>{error}</code>
                        </div>
                    ) : loading && !data ? (
                        <div className="ib-state">
                            <span className="ib-pulse" /> scanning images…
                        </div>
                    ) : filteredItems.length === 0 ? (
                        <div className="ib-state">
                            <b>暂无图片</b><br />
                            {tab === "annotated"
                                ? "当前没有已标注的图片。"
                                : tab === "rejected"
                                    ? "当前没有被拒绝的图片。"
                                    : tab === "train"
                                        ? "当前没有通过预筛选的训练素材。"
                                        : tab === "face"
                                            ? "当前没有通过预筛选的换脸素材。"
                                            : tab === "watermark"
                                                ? "当前没有待去水印的图片。"
                                                : "调整过滤条件或选择其他文件夹。"}
                        </div>
                    ) : (
                        <div className="ib-grid">
                            {isPrescreenTab && groupedByBatch.length > 0 ? (
                                <>
                                    {groupedByBatch.map(group => (
                                        <React.Fragment key={group.batch_id}>
                                            <div className="ib-batch-separator">
                                                <span className="ib-batch-time">
                                                    {group.batch_id === '__no_batch__' ? '未分类批次' : `批次 ${formatBatchTime(group.prescreened_at)}`}
                                                </span>
                                                <span className="ib-batch-count">{group.items.length} 张</span>
                                            </div>
                                            {group.items.map(img => {
                                                const isChecked = selectedSet.has(img.path);
                                                const showCheck = tab === 'unannotated' || tab === 'train' || tab === 'face' || tab === 'watermark';
                                                return (
                                                    <div
                                                        key={img.path}
                                                        className={`ib-card ${selectedImage?.path === img.path ? 'ib-card-selected' : ''} ${isChecked ? 'ib-card-checked' : ''}`}
                                                        onClick={(e) => {
                                                            if (showCheck && (e.ctrlKey || e.metaKey)) {
                                                                e.preventDefault();
                                                                toggleSelect(img.path, e.shiftKey);
                                                                return;
                                                            }
                                                            handleImageClick(img);
                                                        }}
                                                        onDoubleClick={() => setLightboxPath(img.path)}
                                                        title={img.path}
                                                        role="button"
                                                        tabIndex={0}
                                                        onKeyDown={e => {
                                                            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleImageClick(img); }
                                                        }}
                                                    >
                                                        {showCheck && (
                                                            <div
                                                                className={`ib-card-check ${isChecked ? 'is-checked' : ''}`}
                                                                onClick={(e) => { e.stopPropagation(); toggleSelect(img.path, e.shiftKey); }}
                                                                title="选中以批量操作（Shift+点击 范围选中）"
                                                            >
                                                                <span className="ib-check-x">×</span>
                                                            </div>
                                                        )}
                                                        <img
                                                            className="ib-thumb"
                                                            src={`/api/images/serve?path=${encodeURIComponent(img.path)}`}
                                                            alt={img.name}
                                                            loading="lazy"
                                                        />
                                                        <div className="ib-card-info">
                                                            <span className="ib-card-name">{img.name}</span>
                                                            <span className="ib-card-size">{fmtBytes(img.size)}</span>
                                                        </div>
                                                        {(tab === 'train' || tab === 'face' || tab === 'rejected' || tab === 'watermark') && (() => {
                                                            const ps = prescreenedPaths.get(img.path);
                                                            if (!ps || !ps.reason) return null;
                                                            return <div className="ib-card-reason">{ps.reason}</div>;
                                                        })()}
                                                        {annotatedPaths.has(img.path) && <div className="ib-card-badge">✓</div>}
                                                        {skippedPaths.has(img.path) && (
                                                            <div className={`ib-card-badge ${skipReasons[img.path]?.startsWith('[AI]') ? 'skip-badge-ai' : 'skip-badge-manual'}`}>
                                                                {skipReasons[img.path]?.startsWith('[AI]') ? '🤖' : '👤'}
                                                            </div>
                                                        )}
                                                        {(tab === 'train' || tab === 'face' || tab === 'watermark') && (() => {
                                                            const ps = prescreenedPaths.get(img.path);
                                                            if (!ps || ps.status !== 'passed') return null;
                                                            if (ps.category === 'face_nsfw') {
                                                                return <div className="ib-card-cat-badge ib-cat-face" title={`换脸素材·${ps.reason || ''}`}>🎭</div>;
                                                            }
                                                            return <div className="ib-card-cat-badge ib-cat-train" title={`NSFW素材·${ps.reason || ''}`}>🔥</div>;
                                                        })()}
                                                    </div>
                                                );
                                            })}
                                        </React.Fragment>
                                    ))}
                                </>
                            ) : (
                                <>
                                    {visibleItems.map(img => {
                                        const isChecked = selectedSet.has(img.path);
                                        const showCheck = tab === 'unannotated' || tab === 'train' || tab === 'face' || tab === 'watermark';
                                        return (
                                            <div
                                                key={img.path}
                                                className={`ib-card ${selectedImage?.path === img.path ? 'ib-card-selected' : ''} ${isChecked ? 'ib-card-checked' : ''}`}
                                                onClick={(e) => {
                                                    if (showCheck && (e.ctrlKey || e.metaKey)) {
                                                        e.preventDefault();
                                                        toggleSelect(img.path, e.shiftKey);
                                                        return;
                                                    }
                                                    handleImageClick(img);
                                                }}
                                                onDoubleClick={() => setLightboxPath(img.path)}
                                                title={img.path}
                                                role="button"
                                                tabIndex={0}
                                                onKeyDown={e => {
                                                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleImageClick(img); }
                                                }}
                                            >
                                                {showCheck && (
                                                    <div
                                                        className={`ib-card-check ${isChecked ? 'is-checked' : ''}`}
                                                        onClick={(e) => { e.stopPropagation(); toggleSelect(img.path, e.shiftKey); }}
                                                        title="选中以批量操作（Shift+点击 范围选中）"
                                                    >
                                                        <span className="ib-check-x">×</span>
                                                    </div>
                                                )}
                                                <img
                                                    className="ib-thumb"
                                                    src={`/api/images/serve?path=${encodeURIComponent(img.path)}`}
                                                    alt={img.name}
                                                    loading="lazy"
                                                />
                                                <div className="ib-card-info">
                                                    <span className="ib-card-name">{img.name}</span>
                                                    <span className="ib-card-size">{fmtBytes(img.size)}</span>
                                                </div>
                                                {(tab === 'train' || tab === 'face' || tab === 'rejected' || tab === 'watermark') && (() => {
                                                    const ps = prescreenedPaths.get(img.path);
                                                    if (!ps || !ps.reason) return null;
                                                    return <div className="ib-card-reason">{ps.reason}</div>;
                                                })()}
                                                {annotatedPaths.has(img.path) && <div className="ib-card-badge">✓</div>}
                                                {skippedPaths.has(img.path) && (
                                                    <div className={`ib-card-badge ${skipReasons[img.path]?.startsWith('[AI]') ? 'skip-badge-ai' : 'skip-badge-manual'}`}>
                                                        {skipReasons[img.path]?.startsWith('[AI]') ? '🤖' : '👤'}
                                                    </div>
                                                )}
                                                {(tab === 'train' || tab === 'face' || tab === 'watermark') && (() => {
                                                    const ps = prescreenedPaths.get(img.path);
                                                    if (!ps || ps.status !== 'passed') return null;
                                                    if (ps.category === 'face_nsfw') {
                                                        return <div className="ib-card-cat-badge ib-cat-face" title={`换脸素材·${ps.reason || ''}`}>🎭</div>;
                                                    }
                                                    return <div className="ib-card-cat-badge ib-cat-train" title={`NSFW素材·${ps.reason || ''}`}>🔥</div>;
                                                })()}
                                            </div>
                                        );
                                    })}
                                    {visibleCount < filteredItems.length && (
                                        <div ref={loadMoreRef} className="ib-load-more">
                                            已显示 {visibleCount} / {filteredItems.length} · 滚动加载更多…
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Annotation Detail Panel */}
            {selectedImage && (
                <div className="ib-detail-panel">
                    <div className="ib-detail-header">
                        <div className="ib-detail-preview">
                            <img src={`/api/images/serve?path=${encodeURIComponent(selectedImage.path)}`} alt={selectedImage.name} />
                        </div>
                        <div className="ib-detail-meta">
                            <h3>{selectedImage.name}</h3>
                            <span className="ib-detail-path">{selectedImage.folder}/{selectedImage.name}</span>
                            <div className="ib-detail-actions">
                                <select
                                    className="ib-model-select"
                                    value={selectedModel}
                                    onChange={e => setSelectedModel(e.target.value)}
                                    disabled={analyzingPath === selectedImage.path}
                                >
                                    <option value="kimi">Kimi K2.6</option>
                                    <option value="qwen">Qwen 3.6+</option>
                                </select>
                                <label className="ib-thinking-toggle">
                                    <input
                                        type="checkbox"
                                        checked={thinkingEnabled}
                                        onChange={e => setThinkingEnabled(e.target.checked)}
                                        disabled={analyzingPath === selectedImage.path}
                                    />
                                    <span>思考</span>
                                </label>
                                <button
                                    className="ib-analyze-btn"
                                    onClick={(e) => { e.stopPropagation(); handleAnalyzeSingle(selectedImage); }}
                                    disabled={analyzingPath === selectedImage.path}
                                >
                                    {analyzingPath === selectedImage.path
                                        ? '⏳ 分析中…'
                                        : annotatedPaths.has(selectedImage.path)
                                            ? '🔄 重新打标'
                                            : '🤖 AI 打标'}
                                </button>
                                {skippedPaths.has(selectedImage.path) ? (
                                    <button
                                        className="ib-skip-btn ib-unskip-btn"
                                        onClick={(e) => { e.stopPropagation(); handleUnskip(selectedImage); }}
                                    >
                                        ↩️ 取消跳过
                                    </button>
                                ) : (
                                    <button
                                        className="ib-skip-btn"
                                        onClick={(e) => { e.stopPropagation(); handleSkip(selectedImage); }}
                                        disabled={analyzingPath === selectedImage.path}
                                    >
                                        ⏭ Skip
                                    </button>
                                )}
                                {annotation && (
                                    <button
                                        className="ib-skip-btn"
                                        style={{ background: '#8e44ad' }}
                                        onClick={(e) => { e.stopPropagation(); handleLinkCharacter(); }}
                                    >
                                        🔗 关联角色
                                    </button>
                                )}
                                <button className="ib-detail-close" onClick={() => { setSelectedImage(null); setAnnotation(null); setAnalyzeError(null); }}>✕ 关闭</button>
                            </div>
                        </div>
                    </div>
                    {/* Prescreen info & feedback actions */}
                    {prescreenedPaths.has(selectedImage.path) && (() => {
                        const ps = prescreenedPaths.get(selectedImage.path)!;
                        return (
                            <div className="ib-prescreen-info">
                                <div className="ib-prescreen-status">
                                    <span className={`ib-prescreen-badge ${ps.status === 'passed' ? 'ib-prescreen-passed' : 'ib-prescreen-rejected'}`}>
                                        {ps.status === 'passed' ? '✓ 通过预筛选' : '✗ 预筛选拒绝'}
                                    </span>
                                    {ps.category && ps.category !== 'none' && (
                                        <span className="ib-prescreen-category">
                                            {ps.category === 'face_nsfw' ? '🎭 换脸素材' : '🔥 训练素材'}
                                        </span>
                                    )}
                                    {ps.confidence && (
                                        <span className={`ib-prescreen-conf ib-prescreen-conf-${ps.confidence}`}>
                                            {ps.confidence}
                                        </span>
                                    )}
                                </div>
                                {ps.reason && <div className="ib-prescreen-reason">{ps.reason}</div>}
                                <div className="ib-prescreen-actions">
                                    {ps.status === 'passed' ? (<>
                                        <button
                                            className="ib-prescreen-override-btn"
                                            onClick={() => openFeedbackModal(selectedImage.path, true)}
                                        >
                                            ❌ 推翻为拒绝
                                        </button>
                                        {ps.category === 'face_nsfw' ? (
                                            <button
                                                className="ib-prescreen-switch-btn"
                                                onClick={() => handleCategorySwitch(selectedImage.path, 'body_nsfw')}
                                            >
                                                🔥 移到训练素材
                                            </button>
                                        ) : (
                                            <button
                                                className="ib-prescreen-switch-btn"
                                                onClick={() => handleCategorySwitch(selectedImage.path, 'face_nsfw')}
                                            >
                                                🎭 移到换脸素材
                                            </button>
                                        )}
                                    </>) : (
                                        <span className="ib-prescreen-restore-group">
                                            <button
                                                className="ib-prescreen-restore-btn"
                                                onClick={() => setRestoreMenuPath(restoreMenuPath === selectedImage.path ? null : selectedImage.path)}
                                            >
                                                ✅ 恢复为通过
                                            </button>
                                            {restoreMenuPath === selectedImage.path && (
                                                <span className="ib-prescreen-restore-menu">
                                                    <button onClick={() => handlePrescreenRestore(selectedImage.path, 'body_nsfw')}>训练素材</button>
                                                    <button onClick={() => handlePrescreenRestore(selectedImage.path, 'face_nsfw')}>换脸素材</button>
                                                </span>
                                            )}
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })()}
                    {analyzeError && (
                        <div className="ib-analyze-error">❌ {analyzeError}</div>
                    )}
                    {skippedPaths.has(selectedImage.path) && skipReasons[selectedImage.path] && (
                        <div className={`ib-skip-reason ${skipReasons[selectedImage.path].startsWith('[AI]') ? 'ib-skip-reason-ai' : 'ib-skip-reason-manual'}`}>
                            <span className={`ib-skip-source-tag ${skipReasons[selectedImage.path].startsWith('[AI]') ? 'skip-badge-ai' : 'skip-badge-manual'}`}>
                                {skipReasons[selectedImage.path].startsWith('[AI]') ? '🤖 AI 跳过' : '👤 手动跳过'}
                            </span>
                            {skipReasons[selectedImage.path].startsWith('[AI]')
                                ? skipReasons[selectedImage.path].replace(/^\[AI\]\s*/, '')
                                : skipReasons[selectedImage.path]}
                        </div>
                    )}
                    {analyzingPath === selectedImage.path ? (
                        <div className="ib-detail-loading">🤖 AI 正在分析图片，请稍候…</div>
                    ) : annotationLoading ? (
                        <div className="ib-detail-loading">加载标注结果…</div>
                    ) : annotation ? (
                        <div className="ib-detail-content">
                            {annotation.prompt && (
                                <div className="ib-detail-section">
                                    <h4>Prompt</h4>
                                    <p className="ib-detail-text">{annotation.prompt}</p>
                                </div>
                            )}
                            {annotation.description && (
                                <div className="ib-detail-section">
                                    <h4>描述</h4>
                                    <p className="ib-detail-text">{annotation.description}</p>
                                </div>
                            )}
                            <div className="ib-detail-section">
                                <h4>14 维度标签</h4>
                                <div className="ib-dimensions">
                                    {Object.entries(annotation.dimensions).sort(([a], [b]) => a.localeCompare(b)).map(([key, tags]) => (
                                        <div key={key} className="ib-dim-row">
                                            <span className="ib-dim-label">{dimensionLabels[key] || key}</span>
                                            <div className="ib-dim-tags">
                                                {Array.isArray(tags) && tags.length > 0 ? tags.map((t, i) => (
                                                    <span key={i} className="ib-dim-tag">{t}</span>
                                                )) : <span className="ib-dim-empty">—</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {annotation.video_prompt && (
                                <div className="ib-detail-section">
                                    <h4>🎬 图生视频提示词</h4>
                                    <p className="ib-detail-text" style={{ 
                                        whiteSpace: 'pre-wrap', 
                                        color: '#4ade80',
                                        fontSize: '13px',
                                        lineHeight: '1.5',
                                        maxHeight: '200px',
                                        overflowY: 'auto',
                                        background: 'rgba(0,0,0,0.3)',
                                        padding: '8px 12px',
                                        borderRadius: '6px'
                                    }}>
                                        {annotation.video_prompt}
                                    </p>
                                    {annotation.video_prompt_model && (
                                        <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                                            模型: {annotation.video_prompt_model}
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="ib-detail-footer">
                                <span>模型: {annotation.model_id || 'unknown'}</span>
                                <span>时间: {annotation.created_at ? new Date(annotation.created_at).toLocaleString() : '—'}</span>
                            </div>
                        </div>
                    ) : annotatedPaths.has(selectedImage.path) ? (
                        <div className="ib-detail-loading">未找到标注数据</div>
                    ) : (
                        <div className="ib-detail-loading">此图片尚未标注，点击上方「AI 打标」按钮开始分析</div>
                    )}
                </div>
            )}

            <div className="ib-caption">
                <span>{data ? `${filteredItems.length} shown · ${fmtBytes(data.totalSize)}` : "— · —"}</span>
            </div>

            {/* Prescreen Feedback Modal */}
            {feedbackTarget && (
                <div
                    className="ib-feedback-overlay"
                    onClick={(e) => { if (e.target === e.currentTarget) setFeedbackTarget(null); }}
                    role="presentation"
                >
                    <div className="ib-feedback-modal" role="dialog" aria-modal="true">
                        <h4>AI判断错误原因</h4>
                        <p className="ib-feedback-hint">
                            选择错误类别可帮助AI在下次预筛选中避免同类错误
                        </p>
                        <div className="ib-feedback-categories">
                            {PRESCREEN_ERROR_CATEGORIES.map(cat => (
                                <label
                                    key={cat.value}
                                    className={`ib-feedback-cat-option ${feedbackCategory === cat.value ? 'selected' : ''}`}
                                >
                                    <input
                                        type="radio"
                                        name="ib_error_category"
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
                                className="ib-feedback-desc-input"
                                placeholder="请描述具体错误模式…"
                                value={feedbackDesc}
                                onChange={e => setFeedbackDesc(e.target.value)}
                                autoFocus
                            />
                        )}
                        <div className="ib-feedback-actions">
                            <button className="ib-feedback-btn-skip" onClick={handleFeedbackSkip}>
                                跳过反馈直接推翻
                            </button>
                            <button
                                className="ib-feedback-btn-confirm"
                                onClick={handleFeedbackConfirm}
                                disabled={feedbackCategory === 'other' && !feedbackDesc.trim()}
                            >
                                确认推翻
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Lightbox modal */}
            {lightboxPath && (
                <div
                    className="ib-lightbox-overlay"
                    onClick={() => setLightboxPath(null)}
                    onKeyDown={e => { if (e.key === 'Escape') setLightboxPath(null); }}
                    tabIndex={0}
                    role="dialog"
                    aria-modal="true"
                >
                    <img
                        className="ib-lightbox-img"
                        src={`/api/images/serve?path=${encodeURIComponent(lightboxPath)}`}
                        alt="放大预览"
                        onClick={e => e.stopPropagation()}
                    />
                    <button className="ib-lightbox-close" onClick={() => setLightboxPath(null)}>✕</button>
                </div>
            )}
        </section>
    );
}
