import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList as List } from "react-window";
import "./VideoBrowser.css";

/**
 * One video file as returned by GET /api/videos.
 */
export interface RemoteVideo {
    path: string;     // relative path inside VIDEOS_ROOT
    name: string;     // file name
    folder: string;   // parent folder, posix-style. Empty for root.
    group: string;    // top-level folder
    size: number;
    mtime: number;
    ext: string;
}

interface FolderInfo {
    folder: string;
    count: number;
    size: number;
}

interface Catalogue {
    root: string;
    count: number;
    totalSize: number;
    totalFiltered: number;
    page: number;
    limit: number;
    totalPages: number;
    groups: FolderInfo[];
    items: RemoteVideo[];
    status?: string; // "scanning" when cache not ready
}

interface ScanStatus {
    status: "idle" | "scanning" | "ready";
    cached: boolean;
    fileCount: number;
    progress: { scanned: number; total: number; elapsed: number };
}

interface Props {
    /**
     * Triggered when the user activates a row from the catalogue.
     * Receives the picked video together with the current filtered list
     * and the row index, so the host app can support prev/next navigation.
     * Optionally includes the current tab name for tab state memory.
     */
    onPick: (video: RemoteVideo, list: RemoteVideo[], index: number, tab?: string) => void;
    /**
     * Monotonic counter incremented by the host app whenever a new video
     * annotation has been persisted. Bumping it forces a refetch of the
     * annotated-paths set so freshly-labeled videos move into the
     * "已标注" tab without a manual rescan.
     */
    annotationsVersion?: number;
    /** Optional initial tab to display (restored from URL). */
    initialTab?: string;
}

const FOLDER_ALL = "__ALL__";
const VIRTUAL_ROW_HEIGHT = 42; // px per row for virtual scroll

function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(digits)} ${units[i]}`;
}

/** Highlight matched substring inside the file name with <mark>. */
function highlight(name: string, query: string) {
    if (!query) return name;
    const idx = name.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return name;
    const before = name.slice(0, idx);
    const hit = name.slice(idx, idx + query.length);
    const after = name.slice(idx + query.length);
    return <>{before}<mark>{hit}</mark>{after}</>;
}

type SortMode = "recent" | "size" | "name";
type TabMode = "unannotated" | "prescreened" | "annotated" | "skipped";

export default function VideoBrowser({ onPick, annotationsVersion = 0, initialTab }: Props) {
    const [data, setData] = useState<Catalogue | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [activeFolder, setActiveFolder] = useState<string>(FOLDER_ALL);
    const [sort, setSort] = useState<SortMode>("recent");
    const [scanInfo, setScanInfo] = useState<ScanStatus | null>(null);

    // Tab state: unannotated / prescreened / annotated / skipped
    const [tab, setTab] = useState<TabMode>(() => {
        if (initialTab === "annotated" || initialTab === "skipped" || initialTab === "prescreened") return initialTab;
        return "unannotated";
    });
    const [annotatedPaths, setAnnotatedPaths] = useState<Set<string>>(new Set());
    const [skippedPaths, setSkippedPaths] = useState<Set<string>>(new Set());
    const [prescreenedPaths, setPrescreenedPaths] = useState<Map<string, { status: string; reason: string; confidence: string; category: string }>>(new Map());

    // Measure list container height for FixedSizeList
    const listContainerRef = useRef<HTMLDivElement>(null);
    const [listHeight, setListHeight] = useState(600);

    // Fetch annotated video paths. Re-runs whenever `annotationsVersion`
    // changes so that a video freshly labeled in MainVideoUI is reflected
    // in the unannotated/annotated tabs as soon as the user returns here.
    useEffect(() => {
        let cancelled = false;
        fetch("/api/frames/annotated-videos")
            .then(r => r.json())
            .then(d => {
                if (cancelled) return;
                if (d.success) {
                    setAnnotatedPaths(new Set(d.data.map((v: { video_path: string }) => v.video_path)));
                }
            })
            .catch(() => { /* ignore */ });
        return () => { cancelled = true; };
    }, [annotationsVersion]);

    // Fetch skipped video paths in lockstep with annotatedPaths so the three
    // tabs (unannotated / annotated / skipped) always reflect the same
    // server snapshot.
    useEffect(() => {
        let cancelled = false;
        fetch("/api/frames/skipped-videos")
            .then(r => r.json())
            .then(d => {
                if (cancelled) return;
                if (d.success && Array.isArray(d.data)) {
                    setSkippedPaths(new Set(d.data.map((v: { video_path: string }) => v.video_path)));
                }
            })
            .catch(() => { /* ignore */ });
        return () => { cancelled = true; };
    }, [annotationsVersion]);

    // Fetch prescreened video paths so the "通过筛选/已跳过" tabs can
    // surface results from saved_frames format='video_prescreen'.
    useEffect(() => {
        let cancelled = false;
        fetch("/api/videos/prescreened")
            .then(r => r.json())
            .then(d => {
                if (cancelled) return;
                if (d.success && Array.isArray(d.data)) {
                    const map = new Map<string, { status: string; reason: string; confidence: string; category: string }>();
                    d.data.forEach((item: { path: string; status: string; reason: string; confidence: string; category?: string }) => {
                        map.set(item.path, { status: item.status, reason: item.reason, confidence: item.confidence, category: item.category || 'none' });
                    });
                    setPrescreenedPaths(map);
                }
            })
            .catch(() => { /* ignore */ });
        return () => { cancelled = true; };
    }, [annotationsVersion]);

    // Poll scan status while scanning
    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;

        async function pollStatus() {
            try {
                const res = await fetch("/api/videos/status");
                if (res.ok) {
                    const status: ScanStatus = await res.json();
                    setScanInfo(status);
                    if (status.status === "ready" && !data) {
                        // Cache ready, load the catalogue
                        load();
                        if (interval) { clearInterval(interval); interval = null; }
                    }
                }
            } catch { /* ignore poll errors */ }
        }

        if (loading && !data) {
            pollStatus();
            interval = setInterval(pollStatus, 800);
        }

        return () => { if (interval) clearInterval(interval); };
    }, [loading, data]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (activeFolder !== FOLDER_ALL) params.set("folder", activeFolder);
            if (query.trim()) params.set("q", query.trim());
            params.set("sort", sort);
            const res = await fetch(`/api/videos?${params.toString()}`, { cache: "no-store" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: Catalogue = await res.json();

            if (json.status === "scanning") {
                setData(null);
            } else {
                setData(json);
            }
        } catch (e: any) {
            setError(e?.message || "Failed to reach the catalogue API.");
        } finally {
            setLoading(false);
        }
    }, [activeFolder, query, sort]);

    useEffect(() => { load(); }, [load]);

    // Reset scroll position when filters change
    useEffect(() => { /* no-op: react-window handles scroll internally */ }, [activeFolder, query, sort, tab]);

    // Measure list container height via ResizeObserver
    useEffect(() => {
        const el = listContainerRef.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setListHeight(entry.contentRect.height);
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // The items to show — already filtered/sorted server-side
    const rawItems = data?.items ?? [];

    // Filter by annotated/unannotated/skipped tab. A skipped video is
    // intentionally pulled out of the "已标注" bucket even though it has a
    // sentinel row in saved_frames — reviewers want it filed under "已跳过".
    const filteredItems = useMemo(() => {
        switch (tab) {
            case "skipped":
                return rawItems.filter(v =>
                    skippedPaths.has(v.path) ||
                    (prescreenedPaths.has(v.path) && prescreenedPaths.get(v.path)!.status === 'rejected' && !annotatedPaths.has(v.path))
                );
            case "prescreened":
                return rawItems.filter(v =>
                    prescreenedPaths.has(v.path) &&
                    prescreenedPaths.get(v.path)!.status === 'passed' &&
                    !annotatedPaths.has(v.path) &&
                    !skippedPaths.has(v.path)
                );
            case "annotated":
                return rawItems.filter(v => annotatedPaths.has(v.path) && !skippedPaths.has(v.path));
            case "unannotated":
            default:
                return rawItems.filter(v => !annotatedPaths.has(v.path) && !skippedPaths.has(v.path) && !prescreenedPaths.has(v.path));
        }
    }, [rawItems, tab, annotatedPaths, skippedPaths, prescreenedPaths]);

    // Counts for tab badges
    const unannotatedCount = useMemo(
        () => rawItems.filter(v => !annotatedPaths.has(v.path) && !skippedPaths.has(v.path) && !prescreenedPaths.has(v.path)).length,
        [rawItems, annotatedPaths, skippedPaths, prescreenedPaths]
    );
    const prescreenedCount = useMemo(
        () => rawItems.filter(v =>
            prescreenedPaths.has(v.path) &&
            prescreenedPaths.get(v.path)!.status === 'passed' &&
            !annotatedPaths.has(v.path) &&
            !skippedPaths.has(v.path)
        ).length,
        [rawItems, prescreenedPaths, annotatedPaths, skippedPaths]
    );
    const annotatedCount = useMemo(
        () => rawItems.filter(v => annotatedPaths.has(v.path) && !skippedPaths.has(v.path)).length,
        [rawItems, annotatedPaths, skippedPaths]
    );
    const skippedCount = useMemo(
        () => rawItems.filter(v =>
            skippedPaths.has(v.path) ||
            (prescreenedPaths.has(v.path) && prescreenedPaths.get(v.path)!.status === 'rejected' && !annotatedPaths.has(v.path))
        ).length,
        [rawItems, skippedPaths, prescreenedPaths, annotatedPaths]
    );

    const totalCount = data?.totalFiltered ?? rawItems.length;

    const handleRescan = async () => {
        setLoading(true);
        setData(null);
        setScanInfo(null);
        try {
            await fetch("/api/videos/rescan", { method: "GET" });
        } catch { /* ignore */ }
        // Polling will pick up progress
    };

    const progressPct = scanInfo?.progress?.total
        ? Math.round((scanInfo.progress.scanned / scanInfo.progress.total) * 100)
        : 0;

    return (
        <section className="vb-shell" aria-label="Local video archive">
            <header className="vb-mast">
                <div>
                    <div className="vb-eyebrow">Local Archive · /videos</div>
                    <h2 className="vb-title">The <em>dossier</em>.</h2>
                </div>
                <div style={{ alignSelf: "end", color: "var(--vb-mute)", fontSize: 12.5, lineHeight: 1.6, fontFamily: '"Fraunces", serif', fontStyle: "italic", maxWidth: 540 }}>
                    A direct readout of every clip mounted under the project's
                    <code style={{ fontStyle: "normal", margin: "0 6px", padding: "1px 6px", border: "1px solid var(--vb-line-strong)", fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>videos/</code>
                    directory. Pick one — it streams in over <code style={{ fontStyle: "normal", margin: "0 6px", padding: "1px 6px", border: "1px solid var(--vb-line-strong)", fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>HTTP Range</code> and lands in the extractor below.
                </div>
                <div className="vb-meta">
                    {data ? <>
                        <b>{String(data.count).padStart(4, "0")}</b> files indexed{"\n"}
                        <b>{fmtBytes(data.totalSize)}</b> total weight{"\n"}
                        <b>{data.groups.length}</b> collections
                        {scanInfo?.progress?.elapsed ? <>{"\n"}<span style={{ fontSize: 11, opacity: 0.7 }}>scanned in {scanInfo.progress.elapsed}ms</span></> : null}
                    </> : scanInfo?.status === "scanning" ? <>
                        <span className="vb-pulse" />scanning filesystem…
                        <div className="vb-progress-bar">
                            <div className="vb-progress-fill" style={{ width: `${progressPct}%` }} />
                        </div>
                        <span style={{ fontSize: 11 }}>
                            {scanInfo.progress.scanned}/{scanInfo.progress.total} files · {progressPct}%
                        </span>
                    </> : <>
                        <span className="vb-pulse" />reading filesystem…
                    </>}
                </div>
            </header>

            <div className="vb-toolbar">
                <div className="vb-tab-bar">
                    <button
                        className={tab === "unannotated" ? "active" : ""}
                        onClick={() => setTab("unannotated")}
                    >
                        未标注 ({unannotatedCount})
                    </button>
                    <button
                        className={tab === "prescreened" ? "active" : ""}
                        onClick={() => setTab("prescreened")}
                        title="AI 预筛选已通过、待人工细标的视频"
                    >
                        通过筛选 ({prescreenedCount})
                    </button>
                    <button
                        className={tab === "annotated" ? "active" : ""}
                        onClick={() => setTab("annotated")}
                    >
                        已标注 ({annotatedCount})
                    </button>
                    <button
                        className={tab === "skipped" ? "active" : ""}
                        onClick={() => setTab("skipped")}
                        title="已跳过的视频——不进行标注"
                    >
                        已跳过 ({skippedCount})
                    </button>
                </div>
                <label className="vb-search">
                    <span className="vb-search-glyph">⌕</span>
                    <input
                        type="text"
                        placeholder="filter by filename or folder…"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        spellCheck={false}
                    />
                </label>
                <div className="vb-sort" role="tablist" aria-label="Sort">
                    <button data-active={sort === "recent"} onClick={() => setSort("recent")}>Recent</button>
                    <button data-active={sort === "size"} onClick={() => setSort("size")}>Size</button>
                    <button data-active={sort === "name"} onClick={() => setSort("name")}>A → Z</button>
                </div>
                <button className="vb-refresh" onClick={handleRescan} disabled={loading}>
                    {loading && !data ? "scanning…" : "↻ rescan"}
                </button>
            </div>

            <div className="vb-body">
                <aside className="vb-sidebar">
                    <h3>Collections</h3>
                    <div
                        className="vb-folder"
                        data-active={activeFolder === FOLDER_ALL}
                        onClick={() => setActiveFolder(FOLDER_ALL)}
                    >
                        <span className="vb-folder-name">All folders</span>
                        <span className="vb-folder-count">{data?.count ?? "—"}</span>
                    </div>
                    {data?.groups.map(g => (
                        <div
                            key={g.folder}
                            className="vb-folder"
                            data-active={activeFolder === g.folder}
                            onClick={() => setActiveFolder(g.folder)}
                            title={g.folder}
                        >
                            <span className="vb-folder-name">{g.folder}</span>
                            <span className="vb-folder-count">{g.count} · {fmtBytes(g.size)}</span>
                        </div>
                    ))}
                </aside>

                <div className="vb-divider" aria-hidden="true" />

                <div className="vb-list" ref={listContainerRef}>
                    {error ? (
                        <div className="vb-state">
                            <b>archive offline</b>
                            The catalogue endpoint did not respond.
                            <br />
                            <code>{error}</code>
                            <br /><br />
                            <span style={{ fontSize: 13 }}>Start the API with <code>npm run server</code> or run <code>npm run dev:all</code>.</span>
                        </div>
                    ) : loading && !data ? (
                        <div className="vb-state">
                            <b>scanning</b>
                            {scanInfo?.status === "scanning" ? (
                                <>
                                    <div className="vb-progress-bar" style={{ width: "200px", margin: "12px auto" }}>
                                        <div className="vb-progress-fill" style={{ width: `${progressPct}%` }} />
                                    </div>
                                    <span>{scanInfo.progress.scanned} / {scanInfo.progress.total} files indexed</span>
                                </>
                            ) : (
                                <><span className="vb-pulse" /> walking the directory tree…</>
                            )}
                        </div>
                    ) : filteredItems.length === 0 ? (
                        <div className="vb-state">
                            <b>暂无视频</b>
                            {tab === "annotated"
                                ? "当前没有已标注的视频。"
                                : tab === "skipped"
                                    ? "还没有被跳过的视频。"
                                    : tab === "prescreened"
                                        ? "暂无通过 AI 预筛选的视频。"
                                        : "调整过滤条件、选择其他集合，或重新扫描文件夹。"}
                        </div>
                    ) : (
                        <List
                            height={listHeight}
                            itemCount={filteredItems.length}
                            itemSize={VIRTUAL_ROW_HEIGHT}
                            width="100%"
                            overscanCount={15}
                        >
                            {({ index, style }) => {
                                const v = filteredItems[index];
                                return (
                                    <div
                                        style={style}
                                        key={v.path}
                                        className="vb-row"
                                        onClick={() => onPick(v, filteredItems, index, tab)}
                                        title={v.path}
                                        role="button"
                                        tabIndex={0}
                                        onKeyDown={e => {
                                            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(v, filteredItems, index, tab); }
                                        }}
                                    >
                                        <div className="vb-rownum">{String(index + 1).padStart(3, "0")}</div>
                                        <div className="vb-rowmain">
                                            <div className="vb-rowname">{highlight(v.name, query)}</div>
                                            <div className="vb-rowfolder">{v.folder || "(root)"}</div>
                                        </div>
                                        <div className="vb-rowsize">{v.size > 0 ? fmtBytes(v.size) : "…"}</div>
                                        <div className="vb-rowext">{v.ext || "?"}</div>
                                    </div>
                                );
                            }}
                        </List>
                    )}
                </div>
            </div>

            <div className="vb-caption">
                <span>{data ? `${totalCount} shown · ${fmtBytes(data.totalSize)}` : "— · —"}</span>
                <span>stream → http range → frame extractor</span>
            </div>
        </section>
    );
}
