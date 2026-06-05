import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Header from "./Components/Header";
import Card from "./Components/Card";
import MainVideoUI from "./Components/MainVideoUI";
import ImageButton from "./Components/ImageButton";
import Settings from "./Components/Settings";
import UpdateTheme from "./Scripts/UpdateTheme";
import { lang, usedBrowserLang } from "./Scripts/Translations";
import { createRoot } from "react-dom/client";
import Alert from "./Components/Alert";
import CreateAlert from "./Scripts/CreateAlert";
import VideoBrowser, { type RemoteVideo } from "./Components/VideoBrowser";
import VideoNav from "./Components/VideoNav";
import TagReview, { PendingTagsBadge } from "./Components/TagReview";
import BatchAnalysis from "./Components/BatchAnalysis";
import ImageBrowser from "./Components/ImageBrowser";
import ImageBatchAnalysis from "./Components/ImageBatchAnalysis";
import ImagePreScreen from "./Components/ImagePreScreen";
import ImagePipeline from "./Components/ImagePipeline";
import VideoPreScreen from "./Components/VideoPreScreen";
import PromptConverter from "./Components/PromptConverter";

// Bump every time MainVideoUI persists a new AI annotation so VideoBrowser
// can refetch the annotated-paths set and move the freshly-labeled video
// from the "未标注" tab into "已标注" without a manual rescan.

declare global {
  interface Window {
    version: string
  }
}

export default function App() {
  const [videoFile, updateVideoFile] = useState<File>();
  // When the user picks a remote file, we hand MainVideoUI a streaming URL
  // pointing at the local API instead of an in-memory ObjectURL.
  const [remoteUrl, updateRemoteUrl] = useState<string | null>(null);
  // Server-side path of the chosen video; needed by the cloud-save endpoint.
  // For local picks (no remote backing file) this stays null.
  const [videoPath, updateVideoPath] = useState<string | null>(null);

  // Snapshot of the filtered VideoBrowser list at the moment of pick,
  // plus the index of the currently displayed video. Used for prev/next.
  const [videoList, updateVideoList] = useState<RemoteVideo[]>([]);
  const [currentIndex, updateCurrentIndex] = useState<number>(-1);

  // Track which tab the user was on when they picked a video.
  // Used to restore the correct tab when returning to the list.
  const [activeTab, setActiveTab] = useState<string>("unannotated");
  const [showTagReview, setShowTagReview] = useState(false);
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  const [showVideoPreScreen, setShowVideoPreScreen] = useState(false);
  const [unannotatedCount, setUnannotatedCount] = useState(0);

  // Mode switch: video or image
  const [mode, setMode] = useState<'video' | 'image'>('video');
  const [showImageBatchPanel, setShowImageBatchPanel] = useState(false);
  const [showImagePreScreen, setShowImagePreScreen] = useState(false);
  const [showImagePipeline, setShowImagePipeline] = useState(false);
  const [showPromptConverter, setShowPromptConverter] = useState(false);
  const [imageUnannotatedCount, setImageUnannotatedCount] = useState(0);
  const [imageFolders, setImageFolders] = useState<string[]>([]);
  const [imageAnnotationsVersion, setImageAnnotationsVersion] = useState(0);
  const [initialImagePath, setInitialImagePath] = useState<string | null>(null);

  // Counter incremented after a successful AI annotation; VideoBrowser
  // watches this and refetches /api/frames/annotated-videos on change.
  const [annotationsVersion, updateAnnotationsVersion] = useState<number>(0);
  function handleAnnotated() {
    updateAnnotationsVersion(v => v + 1);
    // Refresh the navigation list since the video moved tabs
    // ("未标注" -> "已标注"), so prev/next stays in sync.
    if (videoPath) {
      fetchAndSetVideoList(videoPath);
    }
  }

  /**
   * Fetch the video catalogue + annotation status, filter by tab,
   * and set videoList + currentIndex for prev/next navigation.
   */
  async function fetchAndSetVideoList(vPath: string) {
    try {
      // Fetch full catalogue
      const catalogRes = await fetch("/api/videos?sort=recent");
      if (!catalogRes.ok) return;
      const catalog = await catalogRes.json();
      const allItems: RemoteVideo[] = catalog.items ?? [];

      // Fetch annotated paths
      const annoRes = await fetch("/api/frames/annotated-videos");
      const annoData = await annoRes.json();
      const annotatedSet = new Set<string>(
        annoData.success ? annoData.data.map((v: { video_path: string }) => v.video_path) : []
      );

      // Fetch skipped paths
      const skipRes = await fetch("/api/frames/skipped-videos");
      const skipData = await skipRes.json();
      const skippedSet = new Set<string>(
        skipData.success && Array.isArray(skipData.data) ? skipData.data.map((v: { video_path: string }) => v.video_path) : []
      );

      // Determine which tab this video belongs to
      let tab: "unannotated" | "annotated" | "skipped" = "unannotated";
      if (skippedSet.has(vPath)) tab = "skipped";
      else if (annotatedSet.has(vPath)) tab = "annotated";

      // Filter items by tab
      let filtered: RemoteVideo[];
      switch (tab) {
        case "skipped":
          filtered = allItems.filter(v => skippedSet.has(v.path));
          break;
        case "annotated":
          filtered = allItems.filter(v => annotatedSet.has(v.path) && !skippedSet.has(v.path));
          break;
        default:
          filtered = allItems.filter(v => !annotatedSet.has(v.path) && !skippedSet.has(v.path));
      }

      // Find index of current video
      const idx = filtered.findIndex(v => v.path === vPath);
      if (idx >= 0) {
        updateVideoList(filtered);
        updateCurrentIndex(idx);
      } else {
        // Video not in the tab filter — fall back to full list
        const fullIdx = allItems.findIndex(v => v.path === vPath);
        if (fullIdx >= 0) {
          updateVideoList(allItems);
          updateCurrentIndex(fullIdx);
        }
      }
    } catch (err) {
      console.warn("[fetchAndSetVideoList] failed:", err);
    }
  }

  /**
   * Apply a RemoteVideo as the currently displayed video.
   * Shared by initial pick (from VideoBrowser) and prev/next navigation.
   * @param pushHistory  Whether to push a new history entry (default true).
   *                     Pass false when restoring from URL or popstate.
   */
  function applyRemote(v: RemoteVideo, pushHistory = true) {
    // MainVideoUI only reads `.name` from the File prop, so a 0-byte File
    // with the right filename is enough to keep all download/zip logic happy.
    const placeholder = new File([], v.name, { type: `video/${v.ext || "mp4"}` });
    const url = `/api/video?path=${encodeURIComponent(v.path)}`;
    updateRemoteUrl(url);
    updateVideoPath(v.path);
    updateVideoFile(placeholder);
    // Sync URL so user can bookmark / use back-forward.
    if (pushHistory) {
      const tabSuffix = activeTab && activeTab !== "unannotated" ? `&tab=${activeTab}` : "";
      window.history.pushState({ videoPath: v.path }, "", `?v=${encodeURIComponent(v.path)}${tabSuffix}`);
    }
  }

  function pickRemote(v: RemoteVideo, list: RemoteVideo[], index: number, tab?: string) {
    updateVideoList(list);
    updateCurrentIndex(index);
    if (tab) setActiveTab(tab);
    applyRemote(v);
  }

  function goNext() {
    if (currentIndex < 0 || currentIndex >= videoList.length - 1) return;
    const nextIdx = currentIndex + 1;
    updateCurrentIndex(nextIdx);
    applyRemote(videoList[nextIdx]);
  }

  function goPrev() {
    if (currentIndex <= 0) return;
    const prevIdx = currentIndex - 1;
    updateCurrentIndex(prevIdx);
    applyRemote(videoList[prevIdx]);
  }

  function restore(pushHistory = true) {
    updateVideoFile(undefined);
    updateRemoteUrl(null);
    updateVideoPath(null);
    updateVideoList([]);
    updateCurrentIndex(-1);
    if (pushHistory) {
      window.history.pushState(null, "", "/");
    }
  }

  // --- URL-based routing ---
  const initialLoadDone = useRef(false);

  // On mount: if URL has ?v=<path>, auto-load that video; if ?mode=image, switch to image mode.
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const vPath = params.get("v");
    const modeParam = params.get("mode");
    const imgPath = params.get("img");
    if (vPath) {
      // Restore tab from URL if present
      const tabParam = params.get("tab");
      if (tabParam) setActiveTab(tabParam);
      // Build a minimal RemoteVideo from the path.
      const name = vPath.split("/").pop() || vPath;
      const ext = name.split(".").pop() || "mp4";
      const minimal: RemoteVideo = {
        path: vPath,
        name,
        folder: vPath.substring(0, vPath.lastIndexOf("/")),
        group: vPath.split("/")[0] || "",
        size: 0,
        mtime: 0,
        ext,
      };
      applyRemote(minimal, false);
      // Fetch the full list so prev/next navigation works
      fetchAndSetVideoList(vPath);
    } else if (modeParam === "image") {
      setMode('image');
      const panel = params.get("panel");
      if (panel === "prescreen") setShowImagePreScreen(true);
      else if (panel === "batch") setShowImageBatchPanel(true);
      else if (panel === "pipeline") setShowImagePipeline(true);
      else if (panel === "prompt-converter") setShowPromptConverter(true);
      if (imgPath) setInitialImagePath(imgPath);
    }
  }, []);

  // Listen for browser back/forward.
  useEffect(() => {
    function onPopState(_e: PopStateEvent) {
      const params = new URLSearchParams(window.location.search);
      const vPath = params.get("v");
      const modeParam = params.get("mode");
      const imgPath = params.get("img");
      if (vPath) {
        setMode('video');
        const tabParam = params.get("tab");
        if (tabParam) setActiveTab(tabParam);
        const name = vPath.split("/").pop() || vPath;
        const ext = name.split(".").pop() || "mp4";
        const minimal: RemoteVideo = {
          path: vPath,
          name,
          folder: vPath.substring(0, vPath.lastIndexOf("/")),
          group: vPath.split("/")[0] || "",
          size: 0,
          mtime: 0,
          ext,
        };
        applyRemote(minimal, false);
        fetchAndSetVideoList(vPath);
      } else if (modeParam === "image") {
        setMode('image');
        const panel = params.get("panel");
        setShowImagePreScreen(panel === "prescreen");
        setShowImageBatchPanel(panel === "batch");
        setShowImagePipeline(panel === "pipeline");
        setShowPromptConverter(panel === "prompt-converter");
        setInitialImagePath(imgPath);
      } else {
        setMode('video');
        setInitialImagePath(null);
        restore(false);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useLayoutEffect(() => {
    const customTheme = JSON.parse(localStorage.getItem("VideoFrameExtractor-Theme") ?? "{}");
    for (const key in customTheme) {
      /^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/.test(customTheme[key]) && document.body.style.setProperty(`--${key}`, customTheme[key]);
    }
    UpdateTheme();
  }, [])
  // Fetch unannotated count for batch panel
  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      try {
        const [catalogRes, annoRes, skipRes, prescreenRes] = await Promise.all([
          fetch("/api/videos?sort=recent"),
          fetch("/api/frames/annotated-videos"),
          fetch("/api/frames/skipped-videos"),
          fetch("/api/videos/prescreened"),
        ]);
        const catalog = await catalogRes.json();
        const annoData = await annoRes.json();
        const skipData = await skipRes.json();
        const prescreenData = await prescreenRes.json();
        const annotatedPaths = new Set<string>(
          annoData.success ? annoData.data.map((v: { video_path: string }) => v.video_path) : []
        );
        const skippedPaths = new Set<string>(
          skipData.success && Array.isArray(skipData.data) ? skipData.data.map((v: { video_path: string }) => v.video_path) : []
        );
        const prescreenedPaths = new Set<string>(
          prescreenData.success && Array.isArray(prescreenData.data) ? prescreenData.data.map((v: { path: string }) => v.path) : []
        );
        const items: Array<{ path: string }> = catalog.items || [];
        const count = items.filter(
          v => !annotatedPaths.has(v.path) && !skippedPaths.has(v.path) && !prescreenedPaths.has(v.path)
        ).length;
        if (!cancelled) setUnannotatedCount(count);
      } catch { /* ignore */ }
    }
    fetchCount();
    return () => { cancelled = true; };
  }, [annotationsVersion]);

  // Fetch image stats for batch panel
  useEffect(() => {
    if (mode !== 'image') return;
    let cancelled = false;
    async function fetchImageStats() {
      try {
        const [catalogRes, annoRes, skipRes, prescreenRes] = await Promise.all([
          fetch("/api/images?limit=0"),
          fetch("/api/images/annotated"),
          fetch("/api/images/skipped"),
          fetch("/api/images/prescreened"),
        ]);
        const catalog = await catalogRes.json();
        const annoData = await annoRes.json();
        const skipData = await skipRes.json();
        const prescreenData = await prescreenRes.json();
        const annotatedPaths = new Set<string>(
          annoData.success ? annoData.data.map((v: { video_path: string }) => v.video_path) : []
        );
        const skippedPaths = new Set<string>(
          skipData.success ? skipData.data.map((v: { path: string }) => v.path) : []
        );
        const prescreenedPaths = new Set<string>(
          prescreenData.success ? prescreenData.data.map((v: { path: string }) => v.path) : []
        );
        const items: Array<{ path: string }> = catalog.items || [];
        const count = items.filter(v => !annotatedPaths.has(v.path) && !skippedPaths.has(v.path) && !prescreenedPaths.has(v.path)).length;
        const folders = (catalog.groups || []).map((g: { folder: string }) => g.folder);
        if (!cancelled) {
          setImageUnannotatedCount(count);
          setImageFolders(folders);
        }
      } catch { /* ignore */ }
    }
    fetchImageStats();
    return () => { cancelled = true; };
  }, [mode, imageAnnotationsVersion]);

  useEffect(() => {
    if (usedBrowserLang && !localStorage.getItem("VideoFrameExtractor-ShownCustomLang")) {
      CreateAlert(<span>Applied custom language. You can change it from the {lang("Settings")} ("Settings") link at the end of the page.</span>)
      localStorage.setItem("VideoFrameExtractor-ShownCustomLang", "a");
    }
  }, [])
  return <>
    <Header restoreEverything={restore}></Header>
    {!videoFile ? <>
      {/* Mode switch tabs */}
      <div style={{ display: "flex", gap: "0", margin: "12px 0 4px", borderBottom: "1px solid #222" }}>
        <button
          onClick={() => { setMode('video'); setShowImageBatchPanel(false); setInitialImagePath(null); window.history.pushState(null, "", "/"); }}
          style={{
            padding: "8px 20px",
            border: "1px solid #333",
            borderBottom: mode === 'video' ? "2px solid #d99454" : "1px solid transparent",
            borderRadius: "6px 6px 0 0",
            background: mode === 'video' ? "rgba(217,148,84,0.08)" : "transparent",
            color: mode === 'video' ? "#d99454" : "#666",
            fontSize: "13px",
            fontWeight: mode === 'video' ? 600 : 400,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          🎬 视频
        </button>
        <button
          onClick={() => { setMode('image'); setShowBatchPanel(false); window.history.pushState(null, "", "?mode=image"); }}
          style={{
            padding: "8px 20px",
            border: "1px solid #333",
            borderBottom: mode === 'image' ? "2px solid #6366f1" : "1px solid transparent",
            borderRadius: "6px 6px 0 0",
            background: mode === 'image' ? "rgba(99,102,241,0.08)" : "transparent",
            color: mode === 'image' ? "#6366f1" : "#666",
            fontSize: "13px",
            fontWeight: mode === 'image' ? 600 : 400,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          🖼️ 图片
        </button>
      </div>

      {mode === 'video' ? (
        /* ===== VIDEO MODE ===== */
        showTagReview ? (
          <TagReview onBack={() => setShowTagReview(false)} />
        ) : (
          <>
            <PendingTagsBadge onClick={() => setShowTagReview(true)} />
            <div style={{ display: "flex", gap: "8px", margin: "8px 0" }}>
              <button
                onClick={() => {
                  setShowVideoPreScreen(p => !p);
                  setShowBatchPanel(false);
                }}
                style={{
                  padding: "6px 14px",
                  border: showVideoPreScreen ? "1px solid #d99454" : "1px solid #333",
                  borderRadius: "6px",
                  background: showVideoPreScreen ? "rgba(217,148,84,0.12)" : "transparent",
                  color: showVideoPreScreen ? "#d99454" : "#aaa",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                视频预筛选
              </button>
              <button
                onClick={() => {
                  setShowBatchPanel(p => !p);
                  setShowVideoPreScreen(false);
                }}
                style={{
                  padding: "6px 14px",
                  border: showBatchPanel ? "1px solid #d99454" : "1px solid #333",
                  borderRadius: "6px",
                  background: showBatchPanel ? "rgba(217,148,84,0.12)" : "transparent",
                  color: showBatchPanel ? "#d99454" : "#aaa",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                批量 AI 分析
              </button>
            </div>
            {showVideoPreScreen && (
              <VideoPreScreen
                unannotatedCount={unannotatedCount}
                onComplete={() => updateAnnotationsVersion(v => v + 1)}
                onClose={() => setShowVideoPreScreen(false)}
              />
            )}
            {showBatchPanel && (
              <BatchAnalysis
                unannotatedCount={unannotatedCount}
                onComplete={() => updateAnnotationsVersion(v => v + 1)}
                onClose={() => setShowBatchPanel(false)}
              />
            )}
            <VideoBrowser onPick={pickRemote} annotationsVersion={annotationsVersion} initialTab={activeTab} />
          </>
        )
      ) : (
        /* ===== IMAGE MODE ===== */
        showTagReview ? (
          <TagReview onBack={() => setShowTagReview(false)} />
        ) : (
          <>
            <PendingTagsBadge onClick={() => setShowTagReview(true)} />
            <div style={{ display: "flex", gap: "8px", margin: "8px 0" }}>
              <button
                onClick={() => {
                  const next = !showImagePreScreen;
                  setShowImagePreScreen(next);
                  setShowImageBatchPanel(false);
                  setShowImagePipeline(false);
                  setShowPromptConverter(false);
                  window.history.pushState(null, "", next ? "?mode=image&panel=prescreen" : "?mode=image");
                }}
                style={{
                  padding: "6px 14px",
                  border: showImagePreScreen ? "1px solid #6366f1" : "1px solid #333",
                  borderRadius: "6px",
                  background: showImagePreScreen ? "rgba(99,102,241,0.12)" : "transparent",
                  color: showImagePreScreen ? "#6366f1" : "#aaa",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                预筛选
              </button>
              <button
                onClick={() => {
                  const next = !showImageBatchPanel;
                  setShowImageBatchPanel(next);
                  setShowImagePreScreen(false);
                  setShowImagePipeline(false);
                  setShowPromptConverter(false);
                  window.history.pushState(null, "", next ? "?mode=image&panel=batch" : "?mode=image");
                }}
                style={{
                  padding: "6px 14px",
                  border: showImageBatchPanel ? "1px solid #6366f1" : "1px solid #333",
                  borderRadius: "6px",
                  background: showImageBatchPanel ? "rgba(99,102,241,0.12)" : "transparent",
                  color: showImageBatchPanel ? "#6366f1" : "#aaa",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Prompt 标注
              </button>
              <button
                onClick={() => {
                  const next = !showImagePipeline;
                  setShowImagePipeline(next);
                  setShowImagePreScreen(false);
                  setShowImageBatchPanel(false);
                  setShowPromptConverter(false);
                  window.history.pushState(null, "", next ? "?mode=image&panel=pipeline" : "?mode=image");
                }}
                style={{
                  padding: "6px 14px",
                  border: showImagePipeline ? "1px solid #6366f1" : "1px solid #333",
                  borderRadius: "6px",
                  background: showImagePipeline ? "rgba(99,102,241,0.12)" : "transparent",
                  color: showImagePipeline ? "#6366f1" : "#aaa",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                预筛选 + 标注
              </button>
              <button
                onClick={() => {
                  const next = !showPromptConverter;
                  setShowPromptConverter(next);
                  setShowImagePreScreen(false);
                  setShowImageBatchPanel(false);
                  setShowImagePipeline(false);
                  window.history.pushState(null, "", next ? "?mode=image&panel=prompt-converter" : "?mode=image");
                }}
                style={{
                  padding: "6px 14px",
                  border: showPromptConverter ? "1px solid #6366f1" : "1px solid #333",
                  borderRadius: "6px",
                  background: showPromptConverter ? "rgba(99,102,241,0.12)" : "transparent",
                  color: showPromptConverter ? "#6366f1" : "#aaa",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                提示词转换
              </button>
            </div>
            {showImageBatchPanel && (
              <ImageBatchAnalysis
                unannotatedCount={imageUnannotatedCount}
                folders={imageFolders}
                onComplete={() => setImageAnnotationsVersion(v => v + 1)}
                onClose={() => { setShowImageBatchPanel(false); window.history.pushState(null, "", "?mode=image"); }}
              />
            )}
            {showImagePreScreen && (
              <ImagePreScreen
                unannotatedCount={imageUnannotatedCount}
                folders={imageFolders}
                onComplete={() => setImageAnnotationsVersion(v => v + 1)}
                onClose={() => { setShowImagePreScreen(false); window.history.pushState(null, "", "?mode=image"); }}
                prescreenVersion={imageAnnotationsVersion}
              />
            )}
            {showImagePipeline && (
              <ImagePipeline
                unannotatedCount={imageUnannotatedCount}
                folders={imageFolders}
                onComplete={() => setImageAnnotationsVersion(v => v + 1)}
                onClose={() => { setShowImagePipeline(false); window.history.pushState(null, "", "?mode=image"); }}
              />
            )}
            {showPromptConverter && (
              <PromptConverter />
            )}
            <ImageBrowser
              annotationsVersion={imageAnnotationsVersion}
              initialImagePath={initialImagePath}
              onPrescreenChange={() => setImageAnnotationsVersion(v => v + 1)}
              onPick={(img) => {
                window.history.pushState(
                  { imagePath: img.path },
                  "",
                  `?mode=image&img=${encodeURIComponent(img.path)}`
                );
              }}
            />
          </>
        )
      )}
      <Card>
        <h2>{lang("Open a file")}</h2>
        <p>{lang("Click on the button below to open a video file. Don't worry, everything will be elaborated locally and nothing will be sent to a server.")}</p>
        <ImageButton img="videoClip" onClick={() => {
          const input = Object.assign(document.createElement("input"), {
            type: "file",
            accept: "video/*",
            onchange: () => {
              if (input.files) {
                updateRemoteUrl(null);
                updateVideoPath(null);
                updateVideoList([]);
                updateCurrentIndex(-1);
                updateVideoFile(input.files[0]);
              }
            }
          });
          input.click();
        }}>{lang("Pick file")}</ImageButton>
      </Card>
    </> : <>
      <VideoNav
        currentIndex={currentIndex}
        total={videoList.length}
        currentName={videoFile.name}
        onReturn={restore}
        onPrev={goPrev}
        onNext={goNext}
        sourceTab={activeTab}
      />
      <MainVideoUI key={remoteUrl ?? "MainVideoUI"} video={videoFile} videoBlobUrl={remoteUrl ?? URL.createObjectURL(videoFile)} videoPath={videoPath ?? videoFile.name} onAnnotated={handleAnnotated}></MainVideoUI>
    </>}
    <br></br><br></br>
    <div className="flex gap" style={{ flexWrap: "wrap" }}>
      <a className="pointer" href="https://github.com/dinoosauro/video-frame-extractor" target="_blank">{lang("View on GitHub")}</a>
      <Settings></Settings>
      <span style={{ textDecoration: "underline" }}>{lang("Version")} {window.version}</span>
    </div>
  </>

}
