// High-performance video catalogue + streaming server.
// Uses fdir for fast directory crawling + chokidar for live file watching.
// Serves the local /mnt/cypher/project/asset_manager/videos tree to the
// Video Frame Extractor frontend through these endpoints:
//   GET /api/videos            -> JSON catalogue (cached, paginated)
//   GET /api/videos/status     -> scan progress / cache status
//   GET /api/videos/folder     -> list items in a specific folder only
//   GET /api/video?path=...    -> byte-range streaming of one specific file
//   GET /api/health            -> liveness probe
//   POST /api/frames/save      -> save frame to OSS + PostgreSQL
//   GET /api/frames            -> list saved frames (paginated)
//   GET /api/frames/annotated-videos -> list videos with saved frames
//   GET /api/frames/:id        -> get single frame detail
//
// Run directly:  node server/index.mjs
// or via npm:    npm run server

import 'dotenv/config';
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import os from "node:os";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
import { fdir } from "fdir";
import chokidar from "chokidar";
import express from "express";
import OSS from "ali-oss";
import pg from "pg";
import multer from "multer";
import { generateDescription, generateDescriptionMultiVote, generateVideoDescription, generateReversePrompt, getActiveModelName, loadPendingTags, savePendingTags, DIMENSION_FILE_MAP, CYPHER_DIR, preScreenImage, preScreenImageBatch, preScreenVideo, generateFeedbackRules, getAvailableModels, preScreenImageMultiVote, preScreenImageBatchMultiVote, createLoadBalancer, convertImagePromptToVideo, getVideoPromptModels } from "./kimi.mjs";
import { extractFrameAtTimestamp, checkFfmpegAvailable } from "./ffmpeg.mjs";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------- configuration -------------------------------------------------------
const VIDEOS_ROOT = path.resolve(
    process.env.VIDEOS_ROOT ||
    path.join(__dirname, "..", "..", "videos"),
);
const IMAGES_ROOT = path.resolve(
    process.env.IMAGES_ROOT ||
    path.join(__dirname, "..", "..", "images"),
);
const PORT = Number(process.env.PORT || 8899);

// -------- PostgreSQL ----------------------------------------------------------
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS saved_frames (
            id SERIAL PRIMARY KEY,
            video_path TEXT NOT NULL,
            video_name TEXT NOT NULL,
            timestamp FLOAT NOT NULL,
            oss_url TEXT NOT NULL,
            oss_key TEXT NOT NULL,
            prompt TEXT,
            pose TEXT,
            pose_en TEXT,
            tags JSONB DEFAULT '[]',
            style TEXT,
            description TEXT,
            format TEXT DEFAULT 'jpeg',
            width INT,
            height INT,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);
    // Lightweight migration: track whether a video has been explicitly skipped
    // by the user (reviewed but rejected). 'labeled' is the legacy/default
    // value so existing rows continue to surface in the "已标注" tab.
    await pool.query(
        `ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'labeled'`
    );
    // Migration: video_prompt (text-to-video) and i2v_prompt (image-to-video)
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS video_prompt TEXT`);
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS i2v_prompt TEXT`);
    // Migration: long-video segmentation metadata. NULL for short videos
    // (analyzed as a single pass) and for legacy rows.
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS segment_index INTEGER`);
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS segment_start REAL`);
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS segment_end REAL`);
    // Migration: capture which AI model produced the annotation, plus its
    // wall-clock execution window. Useful for debugging slow runs and
    // attributing quality differences to specific models.
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS model_id TEXT`);
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS analyze_started_at TIMESTAMP`);
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS analyze_ended_at TIMESTAMP`);
    // Migration: frame-level quality feedback from human reviewers.
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS feedback TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS feedback_note TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMP DEFAULT NULL`);
    // Migration: 14-dimension structured annotations from AI analysis.
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS dimensions JSONB DEFAULT '{}'`);
    // Migration: prescreen batch identifier — groups all rows produced by a
    // single batch run so the client can roll back the most recent batch.
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS batch_id TEXT`);
    // Migration: record which model generated the video_prompt
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS video_prompt_model TEXT`);
    // Migration: distinguish spicy vs normal source material so the UI can
    // render different annotation flows (14-dim tagging vs reverse prompt).
    await pool.query(`ALTER TABLE saved_frames ADD COLUMN IF NOT EXISTS material_type TEXT DEFAULT 'spicy'`);
    // One-shot backfill: classify existing rows by their video_path top-level
    // directory, consistent with inferMaterialType()/SPICY_DIRS below. We first
    // reset any legacy/default rows to 'normal', then promote rows whose
    // top-level directory is a known spicy source to 'spicy'.
    await pool.query(`
        UPDATE saved_frames SET material_type = 'normal'
        WHERE material_type IS NULL OR material_type IN ('normal', 'spicy')
    `);
    await pool.query(`
        UPDATE saved_frames SET material_type = 'spicy'
        WHERE video_path LIKE 'spicy_frames_4s/%'
           OR video_path LIKE 'video_frames/%'
           OR video_path LIKE 'clothoff_naked/%'
           OR video_path LIKE 'clothoff_popular/%'
           OR video_path LIKE 'clothoff_realism/%'
           OR video_path LIKE 'clothoff_showing_butt/%'
           OR video_path LIKE 'clothoff_small_boobs/%'
           OR video_path LIKE 'createhottie/%'
           OR video_path LIKE 'fapify_frames/%'
           OR video_path LIKE 'fapify_thumbs/%'
           OR video_path LIKE 'jason_photo/%'
           OR video_path LIKE 'nudiva_feed/%'
           OR video_path LIKE 'playbox_images/%'
           OR video_path LIKE 'undress_previews/%'
           OR video_path LIKE '123av_poster/%'
           OR video_path LIKE 'candy_ai_photo_data/%'
    `);
    // Prescreen batch history: lightweight audit trail for image/video
    // prescreen runs. Allows the UI to surface the last run summary and to
    // reset (delete) either the most recent batch or the entire history.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prescreen_history (
            batch_id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            started_at TIMESTAMP DEFAULT NOW(),
            completed_at TIMESTAMP,
            confirmed_at TIMESTAMP,
            count_passed INT DEFAULT 0,
            count_rejected INT DEFAULT 0,
            count_error INT DEFAULT 0,
            note TEXT DEFAULT ''
        );
    `);
    await pool.query(`ALTER TABLE prescreen_history ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP`);
    // Prescreen feedback: structured human corrections fed back into the
    // prompt for future runs. Each row is a single override event; the
    // batch prescreen aggregates them into concise textual rules.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prescreen_feedback (
            id SERIAL PRIMARY KEY,
            image_path TEXT NOT NULL,
            original_status TEXT NOT NULL,
            corrected_status TEXT NOT NULL,
            error_category TEXT NOT NULL,
            description TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_prescreen_feedback_created_at ON prescreen_feedback (created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_prescreen_feedback_category ON prescreen_feedback (error_category)`);
    // Performance indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_frames_format_video ON saved_frames (format, video_path)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_frames_status ON saved_frames (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_frames_created_at ON saved_frames (created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_frames_format_desc ON saved_frames (format, description)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_frames_feedback ON saved_frames (feedback)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_frames_batch_id ON saved_frames (batch_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_prescreen_history_type_started ON prescreen_history (type, started_at DESC)`);
    await pool.query(`ALTER TABLE prescreen_history ADD COLUMN IF NOT EXISTS batch_config JSONB`);
    await pool.query(`ALTER TABLE prescreen_history ADD COLUMN IF NOT EXISTS progress_snapshot JSONB`);
    await pool.query(`ALTER TABLE prescreen_history ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running'`);
}
initDB().catch(err => console.error('DB init failed:', err));

// -------- Alibaba Cloud OSS ---------------------------------------------------
const ossClient = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
    endpoint: process.env.OSS_ENDPOINT,
});

// -------- Multer (memory storage) ---------------------------------------------
const upload = multer({ storage: multer.memoryStorage() });
const VIDEO_EXTENSIONS = new Set([
    ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ogv", ".ogg", ".ts",
]);
const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff",
]);
const MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".ogv": "video/ogg",
    ".ogg": "video/ogg",
    ".ts": "video/mp2t",
};

// -------- helpers -------------------------------------------------------------
function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, POST");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
}

function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
    });
    res.end(body);
}

/** Resolve a user-supplied relative path safely under VIDEOS_ROOT. */
function safeResolve(relPath) {
    if (typeof relPath !== "string" || !relPath.length) return null;
    if (relPath.includes("\0")) return null;
    const cleaned = relPath.replace(/^[\\/]+/, "");
    const abs = path.resolve(VIDEOS_ROOT, cleaned);
    const rel = path.relative(VIDEOS_ROOT, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return abs;
}

function isVideoFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}

function isImageFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

/** Resolve a user-supplied relative path safely under IMAGES_ROOT. */
function safeResolveImage(relPath) {
    if (typeof relPath !== "string" || !relPath.length) return null;
    if (relPath.includes("\0")) return null;
    const cleaned = relPath.replace(/^[\\/]+/, "");
    const abs = path.resolve(IMAGES_ROOT, cleaned);
    const rel = path.relative(IMAGES_ROOT, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return abs;
}

/**
 * Process items with bounded concurrency. Returns Promise.allSettled results.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} processor
 * @returns {Promise<PromiseSettledResult<R>[]>}
 */
async function processWithConcurrency(items, concurrency, processor) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
            batch.map((item, idx) => processor(item, i + idx))
        );
        results.push(...batchResults);
    }
    return results;
}

/** Sanitize a filename for use within an OSS key. */
function sanitizeForKey(name) {
    return String(name).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
}

/** Format a Date as YYYYMMDD (UTC). */
function formatDateYYYYMMDD(d = new Date()) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

// -------- Simple TTL cache for DB query results --------------------------------
class SimpleCache {
    constructor(ttlMs = 30000) {
        this.ttlMs = ttlMs;
        this.store = new Map();
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > this.ttlMs) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value) {
        this.store.set(key, { value, ts: Date.now() });
    }
    invalidate(key) {
        if (key) this.store.delete(key);
        else this.store.clear();
    }
}
const queryCache = new SimpleCache(30000); // 30s TTL

// -------- Long-video analysis progress tracking ------------------------------
const analysisProgress = new Map();
// key: videoPath, value: { current: number, total: number, status: 'analyzing'|'done'|'error' }

// -------- Batch analysis state -----------------------------------------------
let batchRunning = false;
let batchAborted = false;
let batchProgress = { total: 0, current: 0, annotated: 0, skipped: 0, errors: 0, currentVideo: '' };

// -------- Long-video segmentation helpers ------------------------------------

/** Long-video trigger thresholds. */
const SEGMENT_SIZE_THRESHOLD = 80 * 1024 * 1024; // 80MB
const SEGMENT_DURATION_THRESHOLD = 120;          // 120 seconds
const SEGMENT_DURATION = 60;                     // each segment ~60s
const SEGMENT_SLEEP_MS = 1500;                   // throttle between segments

/**
 * Get the duration of a video in seconds via ffprobe.
 * @param {string} videoPath absolute path
 * @returns {Promise<number>}
 */
async function getVideoDuration(videoPath) {
    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        videoPath,
    ]);
    const duration = parseFloat(String(stdout).trim());
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`Could not determine video duration for: ${videoPath}`);
    }
    return duration;
}

/**
 * Split a video into fixed-duration MP4 segments using stream copy.
 * Caller is responsible for cleaning up the returned tempDir.
 * @param {string} videoPath absolute path
 * @param {number} segmentDuration seconds per segment
 * @returns {Promise<{segments: Array<{index:number,start:number,end:number,path:string}>, tempDir:string, totalDuration:number}>}
 */
async function splitVideoByDuration(videoPath, segmentDuration = SEGMENT_DURATION) {
    const totalDuration = await getVideoDuration(videoPath);
    const segmentCount = Math.ceil(totalDuration / segmentDuration);
    const tempDir = path.join(os.tmpdir(), `vfe-segments-${randomUUID()}`);
    await fsp.mkdir(tempDir, { recursive: true });

    const segments = [];
    for (let i = 0; i < segmentCount; i++) {
        const start = i * segmentDuration;
        const end = Math.min((i + 1) * segmentDuration, totalDuration);
        const segPath = path.join(tempDir, `segment_${i}.mp4`);

        await execFileAsync('ffmpeg', [
            '-y',
            '-ss', String(start),
            '-i', videoPath,
            '-t', String(segmentDuration),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            segPath,
        ]);

        segments.push({ index: i, start, end, path: segPath });
    }

    return { segments, tempDir, totalDuration };
}


// -------- In-Memory Cache + Scanner ------------------------------------------

/** @type {{ items: Map<string, object>, groups: Map<string, object>, totalSize: number } | null} */
let cache = null;
let scanStatus = "idle"; // "idle" | "scanning" | "ready"
let scanProgress = { scanned: 0, total: 0, startTime: 0, endTime: 0 };
let scanPromise = null;

/**
 * Build a single video item object from a file path (without stat).
 * Size/mtime will be 0 until stat info is backfilled.
 */
function buildItem(filePath, statInfo = null) {
    const rel = path.relative(VIDEOS_ROOT, filePath);
    const segs = rel.split(path.sep);
    const fileName = segs.at(-1);
    const folder = segs.length > 1 ? segs.slice(0, -1).join("/") : "";
    return {
        path: segs.join("/"),
        name: fileName,
        folder,
        group: segs[0] || "",
        size: statInfo?.size ?? 0,
        mtime: statInfo?.mtimeMs ?? 0,
        ext: path.extname(fileName).toLowerCase().slice(1),
    };
}

/**
 * Fast initial scan using fdir - only gets file paths (no stat).
 * Then backfills stat info in batches asynchronously.
 */
async function performScan() {
    if (scanStatus === "scanning") return scanPromise;

    scanStatus = "scanning";
    scanProgress = { scanned: 0, total: 0, startTime: Date.now(), endTime: 0 };

    scanPromise = (async () => {
        try {
            // Phase 1: Fast path-only crawl with fdir
            const crawler = new fdir()
                .withFullPaths()
                .filter((filePath) => isVideoFile(filePath))
                .crawl(VIDEOS_ROOT);

            const allPaths = await crawler.withPromise();
            scanProgress.total = allPaths.length;

            // Phase 2: Build item map without stat (instant)
            const items = new Map();
            for (const filePath of allPaths) {
                const item = buildItem(filePath);
                items.set(item.path, item);
            }

            // Update cache immediately with path-only data (fast response)
            cache = { items, groups: computeGroups(items), totalSize: 0 };
            scanStatus = "ready";

            // Phase 3: Backfill stat info in parallel batches
            const BATCH_SIZE = 500;
            const paths = [...items.keys()];
            let totalSize = 0;

            for (let i = 0; i < paths.length; i += BATCH_SIZE) {
                const batch = paths.slice(i, i + BATCH_SIZE);
                const results = await Promise.allSettled(
                    batch.map(async (relPath) => {
                        const abs = path.join(VIDEOS_ROOT, relPath);
                        const s = await fsp.stat(abs);
                        return { relPath, size: s.size, mtime: s.mtimeMs };
                    })
                );

                for (const r of results) {
                    if (r.status === "fulfilled") {
                        const item = items.get(r.value.relPath);
                        if (item) {
                            item.size = r.value.size;
                            item.mtime = r.value.mtime;
                            totalSize += r.value.size;
                        }
                    }
                }
                scanProgress.scanned = Math.min(i + BATCH_SIZE, paths.length);
            }

            // Final update with complete stat data
            cache.totalSize = totalSize;
            cache.groups = computeGroups(items);
            // Pre-sort for fast API response
            const allItems = [...items.values()];
            cache.sortedByRecent = allItems.slice().sort((a, b) => b.mtime - a.mtime);
            cache.sortedBySize = allItems.slice().sort((a, b) => b.size - a.size);
            cache.sortedByName = allItems.slice().sort((a, b) => a.name.localeCompare(b.name));
            scanProgress.endTime = Date.now();

            const elapsed = scanProgress.endTime - scanProgress.startTime;
            console.log(`[video-server] scan complete: ${items.size} videos in ${elapsed}ms`);
        } catch (err) {
            console.error("[video-server] scan error:", err);
            scanStatus = cache ? "ready" : "idle";
        }
    })();

    return scanPromise;
}

function computeGroups(items) {
    const groupMap = new Map();
    let totalSize = 0;
    for (const item of items.values()) {
        totalSize += item.size;
        const key = item.folder || "(root)";
        if (!groupMap.has(key)) groupMap.set(key, { folder: key, count: 0, size: 0 });
        const g = groupMap.get(key);
        g.count++;
        g.size += item.size;
    }
    return groupMap;
}

// -------- Chokidar file watcher -----------------------------------------------
let watcher = null;

function startWatcher() {
    watcher = chokidar.watch(VIDEOS_ROOT, {
        ignored: (filePath, stats) => {
            // Ignore non-video files (but allow directories)
            if (stats?.isFile() && !isVideoFile(filePath)) return true;
            return false;
        },
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        depth: 10,
    });

    watcher.on("add", async (filePath) => {
        if (!isVideoFile(filePath) || !cache) return;
        try {
            const s = await fsp.stat(filePath);
            const item = buildItem(filePath, s);
            cache.items.set(item.path, item);
            cache.totalSize += item.size;
            cache.groups = computeGroups(cache.items);
            console.log(`[watcher] added: ${item.path}`);
        } catch { /* file may have been removed before stat */ }
    });

    watcher.on("unlink", (filePath) => {
        if (!isVideoFile(filePath) || !cache) return;
        const rel = path.relative(VIDEOS_ROOT, filePath).split(path.sep).join("/");
        const item = cache.items.get(rel);
        if (item) {
            cache.totalSize -= item.size;
            cache.items.delete(rel);
            cache.groups = computeGroups(cache.items);
            console.log(`[watcher] removed: ${rel}`);
        }
    });

    watcher.on("change", async (filePath) => {
        if (!isVideoFile(filePath) || !cache) return;
        const rel = path.relative(VIDEOS_ROOT, filePath).split(path.sep).join("/");
        try {
            const s = await fsp.stat(filePath);
            const existing = cache.items.get(rel);
            if (existing) {
                cache.totalSize -= existing.size;
                existing.size = s.size;
                existing.mtime = s.mtimeMs;
                cache.totalSize += s.size;
                cache.groups = computeGroups(cache.items);
            }
        } catch { /* ignore */ }
    });

    watcher.on("error", (err) => {
        console.error("[watcher] error:", err.message);
    });

    console.log(`[video-server] watching: ${VIDEOS_ROOT}`);
}

// -------- Image Cache + Scanner -----------------------------------------------

/** @type {{ items: Map<string, object>, groups: Map<string, object>, totalSize: number } | null} */
let imageCache = null;
let imageScanStatus = "idle";
let imageBatchRunning = false;
let imageBatchAborted = false;
let imageBatchProgress = { total: 0, processed: 0, annotated: 0, skipped: 0, errors: 0 };

let prescreenBatchRunning = false;
let prescreenBatchAborted = false;
let prescreenBatchProgress = null;

let pipelineBatchRunning = false;
let pipelineBatchAborted = false;
let pipelineBatchProgress = null;

let videoPrescreenBatchRunning = false;
let videoPrescreenBatchAborted = false;
let videoPrescreenBatchProgress = null;

// Material classification: top-level directories that are "spicy" assets
// (use the 14-dimension annotation flow). Anything else is treated as
// "normal" (reverse-prompt annotation).
const SPICY_DIRS = new Set([
    'spicy_frames_4s',
    'video_frames',
    'clothoff_naked',
    'clothoff_popular',
    'clothoff_realism',
    'clothoff_showing_butt',
    'clothoff_small_boobs',
    'createhottie',
    'fapify_frames',
    'fapify_thumbs',
    'jason_photo',
    'nudiva_feed',
    'playbox_images',
    'undress_previews',
    '123av_poster',
    'candy_ai_photo_data',
]);

function inferMaterialType(relativePath) {
    if (!relativePath) return 'normal';
    // Accept both POSIX and platform separators; extract the first segment.
    const normalized = String(relativePath).replace(/\\/g, '/');
    const topDir = normalized.split('/')[0] || '';
    return SPICY_DIRS.has(topDir) ? 'spicy' : 'normal';
}

/**
 * Merge AI-returned top-level basic attributes (skin_color / age_range)
 * into the dimensions JSONB payload so that both spicy (14-dimension) and
 * normal (reverse-prompt) annotations expose them under the same key path.
 * Always returns a fresh object — callers can pass the merged value to
 * JSON.stringify() before INSERT without worrying about mutation.
 */
function mergeBasicAttrsIntoDimensions(aiResult) {
    const dims = (aiResult && typeof aiResult.dimensions === 'object' && aiResult.dimensions)
        ? { ...aiResult.dimensions }
        : {};
    const skin = aiResult?.skin_color;
    const age = aiResult?.age_range;
    if (typeof skin === 'string' && skin.trim()) {
        dims.skin_color = [skin.trim()];
    } else if (Array.isArray(skin) && skin.length > 0) {
        dims.skin_color = skin;
    }
    if (typeof age === 'string' && age.trim()) {
        dims.age_range = [age.trim()];
    } else if (Array.isArray(age) && age.length > 0) {
        dims.age_range = age;
    }
    return dims;
}

function buildImageItem(filePath) {
    const rel = path.relative(IMAGES_ROOT, filePath);
    const segs = rel.split(path.sep);
    const fileName = segs.at(-1);
    const folder = segs.length > 1 ? segs.slice(0, -1).join("/") : "";
    const relPosix = segs.join("/");
    return {
        path: relPosix,
        name: fileName,
        folder,
        group: segs[0] || "",
        materialType: inferMaterialType(relPosix),
        size: 0,
        mtime: 0,
        ext: path.extname(fileName).toLowerCase().slice(1),
    };
}

async function performImageScan() {
    if (imageScanStatus === "scanning") return;
    imageScanStatus = "scanning";
    try {
        const crawler = new fdir()
            .withFullPaths()
            .filter((filePath) => isImageFile(filePath))
            .crawl(IMAGES_ROOT);
        const allPaths = await crawler.withPromise();

        const items = new Map();
        for (const filePath of allPaths) {
            const item = buildImageItem(filePath);
            items.set(item.path, item);
        }
        imageCache = { items, groups: computeGroups(items), totalSize: 0 };
        imageScanStatus = "ready";

        // Backfill stat in batches
        const BATCH_SIZE = 500;
        const paths = [...items.keys()];
        let totalSize = 0;
        for (let i = 0; i < paths.length; i += BATCH_SIZE) {
            const batch = paths.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(async (relPath) => {
                    const abs = path.join(IMAGES_ROOT, relPath);
                    const s = await fsp.stat(abs);
                    return { relPath, size: s.size, mtime: s.mtimeMs };
                })
            );
            for (const r of results) {
                if (r.status === "fulfilled") {
                    const item = items.get(r.value.relPath);
                    if (item) {
                        item.size = r.value.size;
                        item.mtime = r.value.mtime;
                        totalSize += r.value.size;
                    }
                }
            }
        }
        imageCache.totalSize = totalSize;
        imageCache.groups = computeGroups(items);
        // Pre-sort for fast API response (avoid re-sorting on every request)
        const allItems = [...items.values()];
        imageCache.sortedByRecent = allItems.slice().sort((a, b) => b.mtime - a.mtime);
        imageCache.sortedBySize = allItems.slice().sort((a, b) => b.size - a.size);
        imageCache.sortedByName = allItems.slice().sort((a, b) => a.name.localeCompare(b.name));
        console.log(`[image-server] scan complete: ${items.size} images`);
    } catch (err) {
        console.error("[image-server] scan error:", err);
        imageScanStatus = imageCache ? "ready" : "idle";
    }
}

// -------- API handlers --------------------------------------------------------

function getCatalogue(url) {
    if (!cache) return null;

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(5000, Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10)));
    const folder = url.searchParams.get("folder") || null;
    const sortBy = url.searchParams.get("sort") || "recent"; // recent | size | name
    const search = (url.searchParams.get("q") || "").trim().toLowerCase();

    // Build items array from cache (use pre-sorted arrays when no filter)
    const hasFilter = (folder && folder !== "__ALL__") || search;
    let items;
    if (!hasFilter) {
        switch (sortBy) {
            case "size": items = cache.sortedBySize || [...cache.items.values()]; break;
            case "name": items = cache.sortedByName || [...cache.items.values()]; break;
            case "recent":
            default: items = cache.sortedByRecent || [...cache.items.values()]; break;
        }
    } else {
        items = [...cache.items.values()];
        if (folder && folder !== "__ALL__") {
            items = items.filter(v => {
                const itemFolder = v.folder || "(root)";
                return itemFolder === folder || itemFolder.startsWith(folder + "/");
            });
        }
        if (search) {
            items = items.filter(v =>
                v.name.toLowerCase().includes(search) ||
                v.folder.toLowerCase().includes(search)
            );
        }
        switch (sortBy) {
            case "size": items.sort((a, b) => b.size - a.size); break;
            case "name": items.sort((a, b) => a.name.localeCompare(b.name)); break;
            case "recent":
            default: items.sort((a, b) => b.mtime - a.mtime); break;
        }
    }

    const totalFiltered = items.length;

    // Pagination (limit=0 means return all — backward compatible)
    if (limit > 0) {
        const start = (page - 1) * limit;
        items = items.slice(start, start + limit);
    }

    const groups = [...cache.groups.values()].sort((a, b) => a.folder.localeCompare(b.folder));

    return {
        root: VIDEOS_ROOT,
        count: cache.items.size,
        totalSize: cache.totalSize,
        totalFiltered,
        page: limit > 0 ? page : 1,
        limit: limit > 0 ? limit : totalFiltered,
        totalPages: limit > 0 ? Math.ceil(totalFiltered / limit) : 1,
        groups,
        items,
    };
}

function getStatus() {
    return {
        status: scanStatus,
        cached: cache !== null,
        fileCount: cache?.items.size ?? 0,
        progress: {
            scanned: scanProgress.scanned,
            total: scanProgress.total,
            elapsed: scanProgress.endTime
                ? scanProgress.endTime - scanProgress.startTime
                : scanStatus === "scanning"
                    ? Date.now() - scanProgress.startTime
                    : 0,
        },
    };
}

function streamVideo(req, res, abs) {
    fs.stat(abs, (err, stat) => {
        if (err || !stat || !stat.isFile()) {
            sendJson(res, 404, { error: "not_found" });
            return;
        }
        const total = stat.size;
        const ext = path.extname(abs).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        const range = req.headers.range;

        if (!range) {
            res.writeHead(200, {
                "Content-Type": type,
                "Content-Length": total,
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
            });
            if (req.method === "HEAD") return res.end();
            const stream = fs.createReadStream(abs);
            stream.on("error", () => res.destroy());
            stream.pipe(res);
            return;
        }

        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) {
            res.writeHead(416, { "Content-Range": `bytes */${total}` });
            return res.end();
        }
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
            res.writeHead(416, { "Content-Range": `bytes */${total}` });
            return res.end();
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
            "Content-Type": type,
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Cache-Control": "no-store",
        });
        if (req.method === "HEAD") return res.end();
        const stream = fs.createReadStream(abs, { start, end });
        stream.on("error", () => res.destroy());
        stream.pipe(res);
    });
}

// -------- Express app + request router ----------------------------------------
const app = express();

// CORS middleware
app.use((req, res, next) => {
    setCors(res);
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }
    next();
});

// --- Existing video routes (preserved) ---

app.get("/api/health", (req, res) => {
    sendJson(res, 200, { ok: true, root: VIDEOS_ROOT, cacheReady: scanStatus === "ready" });
});

app.get("/api/videos/status", (req, res) => {
    sendJson(res, 200, getStatus());
});

app.get("/api/videos/rescan", (req, res) => {
    cache = null;
    performScan();
    sendJson(res, 202, { message: "rescan_started", ...getStatus() });
});

app.get("/api/videos", async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        if (cache) {
            const catalogue = getCatalogue(url);
            return sendJson(res, 200, catalogue);
        }
        if (scanStatus === "scanning") {
            return sendJson(res, 202, {
                status: "scanning",
                ...getStatus(),
                root: VIDEOS_ROOT,
                count: 0,
                totalSize: 0,
                groups: [],
                items: [],
            });
        }
        await performScan();
        const catalogue = getCatalogue(url);
        sendJson(res, 200, catalogue);
    } catch (err) {
        console.error("[video-server] error:", err);
        sendJson(res, 500, { error: "internal", message: String(err && err.message) });
    }
});

// Video streaming (supports both /api/video?path=... and /api/video/...)
app.get("/api/video", (req, res) => {
    const rel = req.query.path || null;
    const abs = rel ? safeResolve(rel) : null;
    if (!abs) return sendJson(res, 400, { error: "invalid_path" });
    streamVideo(req, res, abs);
});

// Fast frame-rate probe via ffprobe — must be registered BEFORE the
// `/api/video/*splat` wildcard route so the precise path wins.
app.get("/api/video/fps", (req, res) => {
    const rel = req.query.path;
    if (!rel) return sendJson(res, 400, { error: "missing_path" });
    const abs = safeResolve(rel);
    if (!abs) return sendJson(res, 403, { error: "forbidden" });

    execFile(
        "ffprobe",
        [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate",
            "-of", "csv=p=0",
            abs,
        ],
        { timeout: 5000 },
        (err, stdout) => {
            if (err) return sendJson(res, 500, { error: "ffprobe_failed", details: err.message });
            const raw = String(stdout || "").trim();
            const parts = raw.split("/");
            let fps;
            if (parts.length === 2) {
                const num = parseInt(parts[0], 10);
                const den = parseInt(parts[1], 10);
                fps = den ? Math.round(num / den) : NaN;
            } else {
                fps = parseInt(parts[0], 10);
            }
            sendJson(res, 200, { fps: Number.isFinite(fps) && fps > 0 ? fps : 30, raw });
        }
    );
});

// --- Video-level AI annotation routes (must precede /api/video/*splat) ---

/**
 * Run AI description + key-frame extraction for one analysis pass.
 * Used for both the whole-video flow and each long-video segment.
 *
 * Frame timestamps stored in DB are mapped to the *original* video timeline
 * by adding `segmentStart` to the (segment-local) timestamp returned by Kimi.
 *
 * @param {object} ctx
 * @param {string} ctx.sourcePath        Absolute path of the file actually fed to Kimi/ffmpeg
 *                                       (the segment file for long videos, the original file otherwise).
 * @param {string} ctx.videoPath         Logical (relative) video path stored in saved_frames.
 * @param {string} ctx.videoName         Display name (basename of original video).
 * @param {number|null} ctx.segmentIndex 0-based index when running on a segment, else null.
 * @param {number|null} ctx.segmentStart Segment start (seconds in original timeline), else null.
 * @param {number|null} ctx.segmentEnd   Segment end (seconds), else null.
 * @returns {Promise<{videoRow:object, frameRows:object[], frameWarning:string|null}>}
 */
async function analyzeOneSegment({
    sourcePath,
    videoPath,
    videoName,
    segmentIndex = null,
    segmentStart = null,
    segmentEnd = null,
}) {
    const tag = segmentIndex !== null
        ? `[video-analyze][seg ${segmentIndex}]`
        : '[video-analyze]';

    // Mark step `probing` for short-video flow. The long-video caller has
    // already pushed an `analyzing/calling_ai` snapshot for this segment, so
    // we only set `probing` when no segmentation context is present.
    if (videoPath && segmentIndex === null) {
        analysisProgress.set(videoPath, {
            current: 1, total: 1, status: 'analyzing', step: 'probing',
        });
    }

    const analyzeStartedAt = new Date();
    if (videoPath) {
        const prev = analysisProgress.get(videoPath) || {};
        analysisProgress.set(videoPath, {
            current: prev.current ?? 1,
            total: prev.total ?? 1,
            status: 'analyzing',
            step: 'calling_ai',
        });
    }
    console.log(`${tag} calling generateVideoDescription on`, sourcePath);
    // Load feedback history for AI prompt injection
    let feedbackHistory = [];
    try {
        const fbResult = await pool.query(
            `SELECT description, feedback, feedback_note FROM saved_frames WHERE feedback = 'bad' ORDER BY feedback_at DESC LIMIT 10`
        );
        feedbackHistory = fbResult.rows;
    } catch (err) {
        console.warn(`${tag} failed to load feedback history:`, err.message);
    }
    const aiResult = await generateVideoDescription(sourcePath, undefined, { feedbackHistory });
    const analyzeEndedAt = new Date();

    // Handle AI skip recommendation
    if (aiResult?.skip === true) {
        console.log(`${tag} AI recommends SKIP: ${aiResult.skip_reason}`);
        // Mark video as skipped in DB
        if (videoPath) {
            await pool.query('DELETE FROM saved_frames WHERE video_path = $1', [videoPath]);
            await pool.query(
                `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, model_id)
                 VALUES ($1, $2, -1, '', '', 'skipped', 'skip', $3, $4)`,
                [videoPath, videoName, `[AI] ${aiResult.skip_reason}`, aiResult.modelId || null]
            );
            analysisProgress.set(videoPath, {
                current: 1, total: 1, status: 'done', step: 'skipped',
            });
        }
        return { skipped: true, skip_reason: aiResult.skip_reason, modelId: aiResult.modelId };
    }

    if (videoPath) {
        const prev = analysisProgress.get(videoPath) || {};
        analysisProgress.set(videoPath, {
            current: prev.current ?? 1,
            total: prev.total ?? 1,
            status: 'analyzing',
            step: 'extracting_frames',
        });
    }
    console.log(`${tag} AI result summary:`, {
        hasPrompt: !!aiResult?.prompt,
        pose: aiResult?.pose,
        tagsCount: Array.isArray(aiResult?.tags) ? aiResult.tags.length : 0,
        keyFramesCount: Array.isArray(aiResult?.keyFrames) ? aiResult.keyFrames.length : 0,
    });

    const insertResult = await pool.query(
        `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, style, description, format, width, height, video_prompt, i2v_prompt, segment_index, segment_start, segment_end, model_id, analyze_started_at, analyze_ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING *`,
        [
            videoPath,
            videoName,
            -1,
            '',
            '',
            aiResult?.prompt || null,
            aiResult?.pose || null,
            aiResult?.pose_en || null,
            JSON.stringify(aiResult?.tags || []),
            aiResult?.style || null,
            aiResult?.description || null,
            'video',
            null,
            null,
            aiResult?.video_prompt || null,
            aiResult?.i2v_prompt || null,
            segmentIndex,
            segmentStart,
            segmentEnd,
            aiResult?.modelId || null,
            analyzeStartedAt,
            analyzeEndedAt,
        ]
    );

    // ---- Frame extraction pipeline ----
    const keyFrames = Array.isArray(aiResult?.keyFrames) ? aiResult.keyFrames : [];
    const frameRows = [];
    let frameWarning = null;

    if (keyFrames.length === 0) {
        if (videoPath) {
            const prev = analysisProgress.get(videoPath) || {};
            analysisProgress.set(videoPath, {
                current: prev.current ?? 1,
                total: prev.total ?? 1,
                status: 'analyzing',
                step: 'saving',
            });
        }
        return { videoRow: insertResult.rows[0], frameRows, frameWarning };
    }

    console.log(`${tag} starting frame extraction for`, keyFrames.length, 'key frames');
    const ffmpegOk = await checkFfmpegAvailable();
    if (!ffmpegOk) {
        frameWarning = 'ffmpeg not available; skipped frame extraction';
        console.warn(tag, frameWarning);
        return { videoRow: insertResult.rows[0], frameRows, frameWarning };
    }

    const tempDir = path.join(os.tmpdir(), `vfe-frames-${randomUUID()}`);
    await fsp.mkdir(tempDir, { recursive: true });
    const dateStr = formatDateYYYYMMDD();
    const baseName = sanitizeForKey(videoName);
    const offset = segmentStart || 0;

    try {
        const settled = await processWithConcurrency(keyFrames, 3, async (kf, idx) => {
            const localTs = Number(kf?.timestamp);
            if (!Number.isFinite(localTs) || localTs < 0) {
                throw new Error(`Invalid timestamp at index ${idx}: ${kf?.timestamp}`);
            }
            // Timestamp stored in DB is mapped to original video timeline.
            const globalTs = localTs + offset;
            console.log(`${tag} extracting frame ${idx + 1}/${keyFrames.length} local@${localTs.toFixed(1)}s -> global@${globalTs.toFixed(1)}s`);
            const tempOutputPath = path.join(tempDir, `frame_${idx}_${globalTs.toFixed(1)}.jpg`);
            try {
                // Extract from sourcePath using the segment-local timestamp.
                await extractFrameAtTimestamp(sourcePath, localTs, tempOutputPath);
                const buffer = await fsp.readFile(tempOutputPath);
                const base64 = buffer.toString('base64');

                const ossKey = `video-frames/${dateStr}/${baseName}_${globalTs.toFixed(1)}s.jpg`;
                const ossResult = await ossClient.put(ossKey, buffer, { mime: 'image/jpeg' });
                const ossUrl = ossResult.url;

                let frameAi = null;
                try {
                    frameAi = await generateDescription(base64, 'jpeg');
                } catch (aiErr) {
                    console.error(`${tag} frame AI failed @${globalTs}s:`, aiErr.message);
                }

                await pool.query(
                    'DELETE FROM saved_frames WHERE video_path = $1 AND timestamp = $2',
                    [videoPath, globalTs]
                );

                const frameInsert = await pool.query(
                    `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, style, description, format, width, height, segment_index, segment_start, segment_end, model_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'jpeg', $12, $13, $14, $15, $16, $17) RETURNING *`,
                    [
                        videoPath,
                        videoName,
                        globalTs,
                        ossUrl,
                        ossKey,
                        frameAi?.prompt || kf?.description || null,
                        frameAi?.pose || null,
                        frameAi?.pose_en || null,
                        JSON.stringify(frameAi?.tags || []),
                        frameAi?.style || null,
                        frameAi?.description || kf?.description || null,
                        null,
                        null,
                        segmentIndex,
                        segmentStart,
                        segmentEnd,
                        aiResult?.modelId || null,
                    ]
                );
                return frameInsert.rows[0];
            } finally {
                try { await fsp.unlink(tempOutputPath); } catch { /* ignore */ }
            }
        });

        for (const r of settled) {
            if (r.status === 'fulfilled' && r.value) {
                frameRows.push(r.value);
            } else if (r.status === 'rejected') {
                console.error(`${tag} frame pipeline failed:`, r.reason?.message || r.reason);
            }
        }
    } finally {
        try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    if (videoPath) {
        const prev = analysisProgress.get(videoPath) || {};
        analysisProgress.set(videoPath, {
            current: prev.current ?? 1,
            total: prev.total ?? 1,
            status: 'analyzing',
            step: 'saving',
        });
    }

    return { videoRow: insertResult.rows[0], frameRows, frameWarning, modelId: aiResult?.modelId || null, analyzeStartedAt, analyzeEndedAt };
}

app.post('/api/video/analyze', express.json(), async (req, res) => {
    try {
        const { videoPath } = req.body || {};
        console.log('[video-analyze] start, videoPath=', videoPath);
        if (!videoPath || typeof videoPath !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid videoPath' });
        }

        const fullPath = safeResolve(videoPath);
        if (!fullPath) {
            console.warn('[video-analyze] forbidden path:', videoPath);
            return res.status(403).json({ error: 'Forbidden path' });
        }
        if (!fs.existsSync(fullPath)) {
            console.warn('[video-analyze] file not found:', fullPath);
            return res.status(404).json({ error: 'Video file not found' });
        }

        const stat = fs.statSync(fullPath);
        const videoName = path.basename(videoPath);

        // Probe duration so we can decide whether to segment. Failure to
        // determine duration falls back to the short-video path (and surfaces
        // a 413 only if Kimi itself rejects the upload).
        let duration = 0;
        try {
            duration = await getVideoDuration(fullPath);
        } catch (e) {
            console.warn('[video-analyze] duration probe failed, treating as short:', e?.message);
        }

        const needsSegmentation =
            stat.size > SEGMENT_SIZE_THRESHOLD || duration > SEGMENT_DURATION_THRESHOLD;
        console.log('[video-analyze] resolved fullPath=', fullPath,
            'size=', stat.size, 'duration=', duration,
            'segmented=', needsSegmentation);

        // -------- Short-video path (unchanged behaviour) ---------------------
        if (!needsSegmentation) {
            await pool.query(
                'DELETE FROM saved_frames WHERE video_path = $1 AND timestamp = -1',
                [videoPath]
            );

            analysisProgress.set(videoPath, {
                current: 1, total: 1, status: 'analyzing', step: 'probing',
            });

            const segResult = await analyzeOneSegment({
                sourcePath: fullPath,
                videoPath,
                videoName,
                segmentIndex: null,
                segmentStart: null,
                segmentEnd: null,
            });

            // Handle AI skip
            if (segResult.skipped) {
                analysisProgress.set(videoPath, {
                    current: 1, total: 1, status: 'done', step: 'skipped',
                });
                setTimeout(() => analysisProgress.delete(videoPath), 5000);
                return res.json({
                    success: true,
                    skipped: true,
                    skip_reason: segResult.skip_reason,
                });
            }

            const { videoRow, frameRows, frameWarning, modelId, analyzeStartedAt, analyzeEndedAt } = segResult;

            analysisProgress.set(videoPath, {
                current: 1, total: 1, status: 'done', step: 'done',
            });
            setTimeout(() => analysisProgress.delete(videoPath), 5000);

            console.log('[video-analyze] done (short). frames=', frameRows.length, 'frameWarning=', frameWarning);
            return res.json({
                success: true,
                data: videoRow,
                frames: frameRows,
                segmented: false,
                aiGenerated: true,
                modelId: modelId || getActiveModelName(),
                analyzeStartedAt,
                analyzeEndedAt,
                ...(frameWarning ? { frameWarning } : {}),
            });
        }

        // -------- Long-video path (segmented analysis) -----------------------
        const ffmpegOk = await checkFfmpegAvailable();
        if (!ffmpegOk) {
            return res.status(500).json({ error: 'ffmpeg not available; cannot segment long video' });
        }

        let segInfo = null;
        try {
            segInfo = await splitVideoByDuration(fullPath, SEGMENT_DURATION);
        } catch (e) {
            console.error('[video-analyze] split failed:', e);
            return res.status(500).json({ error: 'Failed to split video', details: e?.message || String(e) });
        }

        const { segments, tempDir } = segInfo;
        console.log('[video-analyze] split into', segments.length, 'segments, tempDir=', tempDir);

        try {
            // Drop prior segmented annotations for this video (full reset).
            await pool.query(
                'DELETE FROM saved_frames WHERE video_path = $1 AND segment_index IS NOT NULL',
                [videoPath]
            );
            // Also clear any prior whole-video annotation so the segmented
            // result is the single source of truth.
            await pool.query(
                'DELETE FROM saved_frames WHERE video_path = $1 AND timestamp = -1 AND segment_index IS NULL',
                [videoPath]
            );

            const segmentRows = [];
            const allFrameRows = [];
            const warnings = [];
            let firstModelId = null;
            let runStartedAt = null;
            let runEndedAt = null;

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                analysisProgress.set(videoPath, { current: i + 1, total: segments.length, status: 'analyzing', step: 'calling_ai' });
                console.log(`[video-analyze] === segment ${i + 1}/${segments.length} (${seg.start}s..${seg.end}s) ===`);
                try {
                    const { videoRow, frameRows, frameWarning, modelId, analyzeStartedAt, analyzeEndedAt } = await analyzeOneSegment({
                        sourcePath: seg.path,
                        videoPath,
                        videoName,
                        segmentIndex: seg.index,
                        segmentStart: seg.start,
                        segmentEnd: seg.end,
                    });
                    segmentRows.push(videoRow);
                    allFrameRows.push(...frameRows);
                    if (!firstModelId && modelId) firstModelId = modelId;
                    if (!runStartedAt && analyzeStartedAt) runStartedAt = analyzeStartedAt;
                    if (analyzeEndedAt) runEndedAt = analyzeEndedAt;
                    if (frameWarning) warnings.push(`seg${i}: ${frameWarning}`);
                } catch (segErr) {
                    console.error(`[video-analyze] segment ${i} failed:`, segErr?.message || segErr);
                    warnings.push(`seg${i} failed: ${segErr?.message || segErr}`);
                    analysisProgress.set(videoPath, { current: i + 1, total: segments.length, status: 'error' });
                    setTimeout(() => analysisProgress.delete(videoPath), 10000);
                }

                // Throttle between segments to avoid Kimi rate limits.
                if (i < segments.length - 1) {
                    await sleep(SEGMENT_SLEEP_MS);
                }
            }

            analysisProgress.set(videoPath, { current: segments.length, total: segments.length, status: 'done', step: 'done' });
            setTimeout(() => analysisProgress.delete(videoPath), 5000);

            console.log('[video-analyze] done (segmented). segments=', segmentRows.length,
                'frames=', allFrameRows.length, 'warnings=', warnings.length);

            return res.json({
                success: true,
                data: segmentRows[0] || null,
                segments: segmentRows,
                frames: allFrameRows,
                segmented: true,
                aiGenerated: true,
                modelId: firstModelId || getActiveModelName(),
                analyzeStartedAt: runStartedAt,
                analyzeEndedAt: runEndedAt,
                ...(warnings.length ? { frameWarning: warnings.join('; ') } : {}),
            });
        } finally {
            try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch (cleanupErr) {
                console.warn('[video-analyze] failed to clean tempDir:', tempDir, cleanupErr?.message);
            }
        }
    } catch (error) {
        console.error('[video-analyze] error.message:', error?.message);
        console.error('[video-analyze] error.stack:', error?.stack);
        res.status(500).json({ error: 'Failed to analyze video', details: error?.message || String(error) });
    }
});

// SSE-based streaming variant of /api/video/analyze. Pushes step + log
// events while running, then a single `result` event with the same payload
// shape as the JSON endpoint. The classic POST endpoint above is preserved
// untouched as a fallback for clients that haven't migrated yet.
app.post('/api/video/analyze/stream', express.json(), async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    function sendEvent(type, data) {
        try {
            res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        } catch (e) {
            console.warn('[video-analyze][stream] write failed:', e?.message);
        }
    }

    try {
        const { videoPath } = req.body || {};
        if (!videoPath || typeof videoPath !== 'string') {
            sendEvent('error', { message: 'Missing or invalid videoPath' });
            return res.end();
        }

        const fullPath = safeResolve(videoPath);
        if (!fullPath) {
            sendEvent('error', { message: 'Forbidden path' });
            return res.end();
        }
        if (!fs.existsSync(fullPath)) {
            sendEvent('error', { message: 'Video file not found' });
            return res.end();
        }

        const stat = fs.statSync(fullPath);
        const videoName = path.basename(videoPath);

        // Step 1: Probing
        sendEvent('step', { step: 'probing' });
        sendEvent('log', { message: '正在探测视频信息...' });
        analysisProgress.set(videoPath, {
            current: 1, total: 1, status: 'analyzing', step: 'probing',
        });

        let duration = 0;
        try {
            duration = await getVideoDuration(fullPath);
            sendEvent('log', { message: `视频时长 ${duration.toFixed(1)}s，大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB` });
        } catch (e) {
            sendEvent('log', { message: '无法探测视频时长，按短视频处理' });
        }

        const needsSegmentation =
            stat.size > SEGMENT_SIZE_THRESHOLD || duration > SEGMENT_DURATION_THRESHOLD;

        if (needsSegmentation) {
            sendEvent('log', { message: `视频较长，将分段分析（阈值 ${SEGMENT_DURATION_THRESHOLD}s）` });
        }

        // -------- Short-video path ---------------------
        if (!needsSegmentation) {
            await pool.query(
                'DELETE FROM saved_frames WHERE video_path = $1 AND timestamp = -1',
                [videoPath]
            );

            sendEvent('step', { step: 'calling_ai' });
            sendEvent('log', { message: '正在调用 AI 模型分析视频...' });
            analysisProgress.set(videoPath, {
                current: 1, total: 1, status: 'analyzing', step: 'calling_ai',
            });

            // Load feedback history for prompt injection
            let sseFeeback = [];
            try {
                const fbRes = await pool.query(
                    `SELECT description, feedback, feedback_note FROM saved_frames WHERE feedback = 'bad' ORDER BY feedback_at DESC LIMIT 10`
                );
                sseFeeback = fbRes.rows;
            } catch { /* ignore */ }

            const analyzeStartedAt = new Date();
            const aiResult = await generateVideoDescription(fullPath, undefined, { feedbackHistory: sseFeeback });
            const analyzeEndedAt = new Date();
            const elapsed = ((analyzeEndedAt - analyzeStartedAt) / 1000).toFixed(1);
            sendEvent('log', { message: `AI 分析完成（耗时 ${elapsed}s）` });

            // Handle AI skip
            if (aiResult?.skip === true) {
                sendEvent('log', { message: `AI 建议跳过此视频：${aiResult.skip_reason}` });
                sendEvent('step', { step: 'skipped' });
                // Mark as skipped in DB
                await pool.query('DELETE FROM saved_frames WHERE video_path = $1', [videoPath]);
                await pool.query(
                    `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, model_id)
                     VALUES ($1, $2, -1, '', '', 'skipped', 'skip', $3, $4)`,
                    [videoPath, videoName, `[AI] ${aiResult.skip_reason}`, aiResult.modelId || null]
                );
                analysisProgress.set(videoPath, { current: 1, total: 1, status: 'done', step: 'skipped' });
                setTimeout(() => analysisProgress.delete(videoPath), 5000);
                sendEvent('result', { success: true, skipped: true, skip_reason: aiResult.skip_reason });
                return res.end();
            }

            if (aiResult?.dimensions && typeof aiResult.dimensions === 'object') {
                const dimCount = Object.keys(aiResult.dimensions).length;
                sendEvent('log', { message: `识别到 ${dimCount} 个维度标注` });
                let newCount = 0;
                for (const tags of Object.values(aiResult.dimensions)) {
                    if (Array.isArray(tags)) {
                        newCount += tags.filter(t => typeof t === 'string' && t.startsWith('[NEW]')).length;
                    }
                }
                if (newCount > 0) {
                    sendEvent('log', { message: `发现 ${newCount} 个新标签 [NEW]` });
                }
            }
            if (Array.isArray(aiResult?.keyFrames) && aiResult.keyFrames.length > 0) {
                sendEvent('log', { message: `AI 推荐 ${aiResult.keyFrames.length} 个关键帧` });
            }

            sendEvent('step', { step: 'extracting_frames' });
            sendEvent('log', { message: '正在提取关键帧...' });
            analysisProgress.set(videoPath, {
                current: 1, total: 1, status: 'analyzing', step: 'extracting_frames',
            });

            // Flatten dimensions to tags array for backward compatibility
            const flatTags = [];
            if (aiResult?.dimensions && typeof aiResult.dimensions === 'object') {
                for (const dimTags of Object.values(aiResult.dimensions)) {
                    if (Array.isArray(dimTags)) {
                        flatTags.push(...dimTags.map(t => typeof t === 'string' ? t.replace(/^\[NEW\]\s*/, '') : t));
                    }
                }
            }

            const insertResult = await pool.query(
                `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, dimensions, style, description, format, width, height, video_prompt, i2v_prompt, segment_index, segment_start, segment_end, model_id, analyze_started_at, analyze_ended_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
                [
                    videoPath, videoName, -1, '', '',
                    aiResult?.prompt || null,
                    aiResult?.pose || null,
                    aiResult?.pose_en || null,
                    JSON.stringify(flatTags),
                    JSON.stringify(mergeBasicAttrsIntoDimensions(aiResult)),
                    aiResult?.style || null,
                    aiResult?.description || null,
                    'video',
                    null, null,
                    aiResult?.video_prompt || null,
                    aiResult?.i2v_prompt || null,
                    null, null, null,
                    aiResult?.modelId || null,
                    analyzeStartedAt, analyzeEndedAt,
                ]
            );
            const videoRow = insertResult.rows[0];

            const keyFrames = Array.isArray(aiResult?.keyFrames) ? aiResult.keyFrames : [];
            const frameRows = [];
            let frameWarning = null;

            if (keyFrames.length > 0) {
                const ffmpegOk = await checkFfmpegAvailable();
                if (!ffmpegOk) {
                    frameWarning = 'ffmpeg not available; skipped frame extraction';
                    sendEvent('log', { message: '⚠ ffmpeg 不可用，跳过帧提取' });
                } else {
                    const tempDir = path.join(os.tmpdir(), `vfe-frames-${randomUUID()}`);
                    await fsp.mkdir(tempDir, { recursive: true });
                    const dateStr = formatDateYYYYMMDD();
                    const baseName = sanitizeForKey(videoName);

                    try {
                        for (let idx = 0; idx < keyFrames.length; idx++) {
                            const kf = keyFrames[idx];
                            const ts = Number(kf?.timestamp);
                            if (!Number.isFinite(ts) || ts < 0) continue;

                            sendEvent('log', { message: `提取帧 ${idx + 1}/${keyFrames.length} @${ts.toFixed(1)}s` });
                            const tempOutputPath = path.join(tempDir, `frame_${idx}_${ts.toFixed(1)}.jpg`);
                            try {
                                await extractFrameAtTimestamp(fullPath, ts, tempOutputPath);
                                const buffer = await fsp.readFile(tempOutputPath);
                                const base64 = buffer.toString('base64');
                                const ossKey = `video-frames/${dateStr}/${baseName}_${ts.toFixed(1)}s.jpg`;
                                const ossResult = await ossClient.put(ossKey, buffer, { mime: 'image/jpeg' });

                                let frameAi = null;
                                try {
                                    frameAi = await generateDescription(base64, 'jpeg');
                                } catch (aiErr) {
                                    console.error(`[video-analyze][stream] frame AI failed @${ts}s:`, aiErr.message);
                                }

                                await pool.query(
                                    'DELETE FROM saved_frames WHERE video_path = $1 AND timestamp = $2',
                                    [videoPath, ts]
                                );
                                const frameInsert = await pool.query(
                                    `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, style, description, format, width, height, segment_index, segment_start, segment_end, model_id)
                                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'jpeg', $12, $13, $14, $15, $16, $17) RETURNING *`,
                                    [
                                        videoPath, videoName, ts, ossResult.url, ossKey,
                                        frameAi?.prompt || kf?.description || null,
                                        frameAi?.pose || null,
                                        frameAi?.pose_en || null,
                                        JSON.stringify(frameAi?.tags || []),
                                        frameAi?.style || null,
                                        frameAi?.description || kf?.description || null,
                                        null, null, null, null, null,
                                        aiResult?.modelId || null,
                                    ]
                                );
                                frameRows.push(frameInsert.rows[0]);
                            } finally {
                                try { await fsp.unlink(tempOutputPath); } catch { }
                            }
                        }
                    } finally {
                        try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch { }
                    }
                    sendEvent('log', { message: `成功提取 ${frameRows.length} 个关键帧` });
                }
            } else {
                sendEvent('log', { message: 'AI 未推荐关键帧，跳过帧提取' });
            }

            sendEvent('step', { step: 'saving' });
            sendEvent('log', { message: '保存完成' });
            sendEvent('step', { step: 'done' });
            analysisProgress.set(videoPath, {
                current: 1, total: 1, status: 'done', step: 'done',
            });
            setTimeout(() => analysisProgress.delete(videoPath), 5000);

            sendEvent('result', {
                success: true,
                data: videoRow,
                frames: frameRows,
                segmented: false,
                aiGenerated: true,
                modelId: aiResult?.modelId || getActiveModelName(),
                analyzeStartedAt,
                analyzeEndedAt,
                ...(frameWarning ? { frameWarning } : {}),
            });
            return res.end();
        }

        // -------- Long-video (segmented) path ---------------------
        sendEvent('log', { message: '正在分割视频...' });
        const ffmpegOk = await checkFfmpegAvailable();
        if (!ffmpegOk) {
            sendEvent('error', { message: 'ffmpeg not available; cannot segment long video' });
            return res.end();
        }

        let segInfo;
        try {
            segInfo = await splitVideoByDuration(fullPath, SEGMENT_DURATION);
        } catch (e) {
            sendEvent('error', { message: `Failed to split video: ${e?.message}` });
            return res.end();
        }

        const { segments, tempDir } = segInfo;
        sendEvent('log', { message: `分割为 ${segments.length} 段` });

        try {
            await pool.query(
                'DELETE FROM saved_frames WHERE video_path = $1 AND segment_index IS NOT NULL',
                [videoPath]
            );
            await pool.query(
                'DELETE FROM saved_frames WHERE video_path = $1 AND timestamp = -1 AND segment_index IS NULL',
                [videoPath]
            );

            const segmentRows = [];
            const allFrameRows = [];
            const warnings = [];
            let firstModelId = null;
            let runStartedAt = null;
            let runEndedAt = null;

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                sendEvent('step', { step: 'calling_ai', current: i + 1, total: segments.length });
                sendEvent('log', { message: `正在分析第 ${i + 1}/${segments.length} 段 (${seg.start}s ~ ${seg.end}s)...` });
                analysisProgress.set(videoPath, { current: i + 1, total: segments.length, status: 'analyzing', step: 'calling_ai' });

                try {
                    const { videoRow, frameRows, frameWarning, modelId, analyzeStartedAt, analyzeEndedAt } = await analyzeOneSegment({
                        sourcePath: seg.path,
                        videoPath,
                        videoName,
                        segmentIndex: seg.index,
                        segmentStart: seg.start,
                        segmentEnd: seg.end,
                    });
                    segmentRows.push(videoRow);
                    allFrameRows.push(...frameRows);
                    if (!firstModelId && modelId) firstModelId = modelId;
                    if (!runStartedAt && analyzeStartedAt) runStartedAt = analyzeStartedAt;
                    if (analyzeEndedAt) runEndedAt = analyzeEndedAt;
                    if (frameWarning) warnings.push(`seg${i}: ${frameWarning}`);
                    sendEvent('log', { message: `第 ${i + 1} 段完成（关键帧 ${frameRows.length}）` });
                } catch (segErr) {
                    sendEvent('log', { message: `⚠ 第 ${i + 1} 段分析失败: ${segErr?.message}` });
                    warnings.push(`seg${i} failed: ${segErr?.message}`);
                }

                if (i < segments.length - 1) {
                    await sleep(SEGMENT_SLEEP_MS);
                }
            }

            sendEvent('step', { step: 'done' });
            sendEvent('log', { message: `全部完成：${segmentRows.length} 段，${allFrameRows.length} 关键帧` });
            analysisProgress.set(videoPath, { current: segments.length, total: segments.length, status: 'done', step: 'done' });
            setTimeout(() => analysisProgress.delete(videoPath), 5000);

            sendEvent('result', {
                success: true,
                data: segmentRows[0] || null,
                segments: segmentRows,
                frames: allFrameRows,
                segmented: true,
                aiGenerated: true,
                modelId: firstModelId || getActiveModelName(),
                analyzeStartedAt: runStartedAt,
                analyzeEndedAt: runEndedAt,
                ...(warnings.length ? { frameWarning: warnings.join('; ') } : {}),
            });
        } finally {
            try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch { }
        }
        return res.end();
    } catch (error) {
        console.error('[video-analyze][stream] error:', error?.message);
        try {
            sendEvent('error', { message: error?.message || 'Unknown error' });
        } catch { }
        return res.end();
    }
});

app.post('/api/video/analyze/batch', express.json(), async (req, res) => {
    // 防并发
    if (batchRunning) {
        return sendJson(res, 409, { error: 'batch_running', message: 'A batch analysis is already in progress', progress: batchProgress });
    }

    const { count, source } = req.body || {};
    if (count !== 'all' && (!Number.isInteger(count) || count < 1)) {
        return sendJson(res, 400, { error: 'invalid_count', message: 'count must be a positive integer or "all"' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    function sendEvent(type, data) {
        try {
            res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        } catch (e) {
            console.warn('[batch-analyze] write failed:', e?.message);
        }
    }

    batchRunning = true;
    batchAborted = false;

    try {
        // 1. Get annotated + skipped video paths from DB
        const annotatedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE timestamp = -1`
        );
        const annotatedSet = new Set(annotatedRes.rows.map(r => r.video_path));

        // 2. Get all videos from cache, filter out annotated ones
        if (!cache) {
            await performScan();
        }
        if (!cache || !cache.items) {
            sendEvent('error', { message: 'Video cache not available' });
            batchRunning = false;
            return res.end();
        }

        // cache.items is Map<relativePath, {path, name, folder, group, size, mtime, ext}>
        const allVideos = [];
        for (const [relPath, info] of cache.items.entries()) {
            if (!annotatedSet.has(relPath)) {
                allVideos.push({ path: relPath, ...info });
            }
        }

        // If source is prescreened (default), only keep videos that passed prescreen
        if (source !== 'all') {
            const vpRes = await pool.query(
                `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'video_prescreen' AND status = 'passed'`
            );
            const videoPrescreenPassedSet = new Set(vpRes.rows.map(r => r.video_path));
            const filteredVideos = allVideos.filter(v => videoPrescreenPassedSet.has(v.path));
            allVideos.length = 0;
            allVideos.push(...filteredVideos);
        }

        // Sort by mtime descending (newest first)
        allVideos.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

        // 3. Take count
        const limit = count === 'all' ? allVideos.length : Math.min(count, allVideos.length);
        const toProcess = allVideos.slice(0, limit);

        if (toProcess.length === 0) {
            sendEvent('start', { total: 0, current: 0 });
            sendEvent('done', { total: 0, annotated: 0, skipped: 0, errors: 0 });
            batchRunning = false;
            return res.end();
        }

        batchProgress = { total: toProcess.length, current: 0, annotated: 0, skipped: 0, errors: 0, currentVideo: '' };
        const videoBatchId = randomUUID();
        const videoBatchConfig = { count, source };
        await pool.query(
            `INSERT INTO prescreen_history (batch_id, type, started_at, batch_config, status) VALUES ($1, 'video_annotation', NOW(), $2, 'running')`,
            [videoBatchId, JSON.stringify(videoBatchConfig)]
        );
        sendEvent('start', { total: toProcess.length, current: 0, batch_id: videoBatchId });

        // Load feedback history once for the entire batch
        let feedbackHistory = [];
        try {
            const fbRes = await pool.query(
                `SELECT description, feedback, feedback_note FROM saved_frames WHERE feedback = 'bad' ORDER BY feedback_at DESC LIMIT 10`
            );
            feedbackHistory = fbRes.rows;
        } catch { /* ignore */ }

        // 4. Process sequentially
        for (let i = 0; i < toProcess.length; i++) {
            if (batchAborted) {
                sendEvent('aborted', { index: i, total: toProcess.length, annotated: batchProgress.annotated, skipped: batchProgress.skipped, errors: batchProgress.errors });
                break;
            }

            const video = toProcess[i];
            const videoPath = video.path;
            const videoName = path.basename(videoPath);
            batchProgress.current = i + 1;
            batchProgress.currentVideo = videoName;

            sendEvent('item_start', { index: i, videoPath, videoName });

            try {
                const fullPath = safeResolve(videoPath);
                if (!fullPath || !fs.existsSync(fullPath)) {
                    sendEvent('item_done', { index: i, videoPath, videoName, result: 'error', reason: 'File not found' });
                    batchProgress.errors++;
                    continue;
                }

                // Delete existing video-level annotation if any
                await pool.query(
                    'DELETE FROM saved_frames WHERE video_path = $1 AND timestamp = -1',
                    [videoPath]
                );

                // Call AI
                const aiResult = await generateVideoDescription(fullPath, undefined, { feedbackHistory });

                // Handle skip
                if (aiResult?.skip === true) {
                    // Mark as skipped in DB (same logic as single stream endpoint)
                    await pool.query('DELETE FROM saved_frames WHERE video_path = $1', [videoPath]);
                    await pool.query(
                        `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, tags, format, created_at)
                         VALUES ($1, $2, -1, '', '', $3, 'skip', NOW())`,
                        [videoPath, videoName, ['__skipped__']]
                    );
                    sendEvent('item_done', { index: i, videoPath, videoName, result: 'skipped', reason: aiResult.skip_reason || 'No NSFW content' });
                    batchProgress.skipped++;
                    continue;
                }

                // Save annotation (same logic as single stream endpoint)
                if (aiResult) {
                    // Flatten dimensions to tags array for backward compatibility
                    const batchFlatTags = [];
                    if (aiResult.dimensions && typeof aiResult.dimensions === 'object') {
                        for (const dimTags of Object.values(aiResult.dimensions)) {
                            if (Array.isArray(dimTags)) {
                                batchFlatTags.push(...dimTags.map(t => typeof t === 'string' ? t.replace(/^\[NEW\]\s*/, '') : t));
                            }
                        }
                    }

                    await pool.query(
                        `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, dimensions, style, description, video_prompt, i2v_prompt, format, width, height, created_at)
                         VALUES ($1, $2, -1, '', '', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'annotation', $12, $13, NOW())
                         RETURNING id`,
                        [
                            videoPath, videoName,
                            aiResult.prompt || null,
                            aiResult.pose || null,
                            aiResult.pose_en || null,
                            JSON.stringify(batchFlatTags),
                            JSON.stringify(aiResult.dimensions || {}),
                            aiResult.style || null,
                            aiResult.description || null,
                            aiResult.video_prompt || null,
                            aiResult.i2v_prompt || null,
                            aiResult.width || null,
                            aiResult.height || null,
                        ]
                    );
                    sendEvent('item_done', { index: i, videoPath, videoName, result: 'annotated' });
                    batchProgress.annotated++;
                } else {
                    sendEvent('item_done', { index: i, videoPath, videoName, result: 'error', reason: 'AI returned empty result' });
                    batchProgress.errors++;
                }
            } catch (err) {
                console.error(`[batch-analyze] error processing ${videoPath}:`, err?.message);
                sendEvent('item_done', { index: i, videoPath, videoName, result: 'error', reason: err?.message || 'Unknown error' });
                batchProgress.errors++;
            }
            pool.query(`UPDATE prescreen_history SET progress_snapshot = $1 WHERE batch_id = $2`, [JSON.stringify({ ...batchProgress, processed: batchProgress.current }), videoBatchId]).catch(() => { });
        }

        if (batchAborted) {
            // Save as interrupted so user can resume later
            await pool.query(
                `UPDATE prescreen_history SET status = 'interrupted', progress_snapshot = $1 WHERE batch_id = $2`,
                [JSON.stringify({ ...batchProgress, processed: batchProgress.current }), videoBatchId]
            ).catch(() => { });
        } else {
            await pool.query(
                `UPDATE prescreen_history SET completed_at = NOW(), count_passed = $1, count_rejected = $2, count_error = $3, status = 'completed', progress_snapshot = $4 WHERE batch_id = $5`,
                [batchProgress.annotated, batchProgress.skipped, batchProgress.errors, JSON.stringify({ ...batchProgress, processed: batchProgress.current }), videoBatchId]
            ).catch(() => { });
            sendEvent('done', { total: toProcess.length, annotated: batchProgress.annotated, skipped: batchProgress.skipped, errors: batchProgress.errors, batch_id: videoBatchId });
        }
    } catch (err) {
        console.error('[batch-analyze] fatal error:', err);
        sendEvent('error', { message: err?.message || 'Internal error' });
    } finally {
        batchRunning = false;
        batchProgress = { total: 0, current: 0, annotated: 0, skipped: 0, errors: 0, currentVideo: '' };
        res.end();
    }
});

app.get('/api/video/analyze/batch/status', async (req, res) => {
    setCors(res);
    if (batchRunning) {
        return sendJson(res, 200, { running: true, progress: batchProgress });
    }
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'video_annotation' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length > 0) {
            const row = interrupted.rows[0];
            return sendJson(res, 200, {
                running: false, progress: null,
                interrupted: { batch_id: row.batch_id, config: row.batch_config, progress: row.progress_snapshot }
            });
        }
    } catch { }
    sendJson(res, 200, { running: false, progress: null });
});

app.post('/api/video/analyze/batch/resume', async (req, res) => {
    setCors(res);
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'video_annotation' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length === 0) {
            return sendJson(res, 404, { error: '没有可恢复的中断任务' });
        }
        const row = interrupted.rows[0];
        await pool.query(`UPDATE prescreen_history SET status = 'resumed' WHERE batch_id = $1`, [row.batch_id]);
        const config = row.batch_config || { count: 'all', source: '' };
        const progress = row.progress_snapshot || {};
        const processed = progress.processed || progress.current || 0;
        const remaining = config.count === 'all' ? 'all' : Math.max(0, (config.count || 0) - processed);
        sendJson(res, 200, { ok: true, config: { ...config, count: remaining || 'all' } });
    } catch (err) {
        sendJson(res, 500, { error: '恢复任务失败：' + (err?.message || '未知错误') });
    }
});

app.post('/api/video/analyze/batch/stop', (req, res) => {
    setCors(res);
    if (!batchRunning) return sendJson(res, 200, { ok: true, message: 'not_running' });
    batchAborted = true;
    sendJson(res, 200, { ok: true, message: 'stopping' });
});

app.get('/api/video/analyze/progress', (req, res) => {
    const videoPath = req.query.path;
    if (!videoPath) return res.status(400).json({ error: 'path required' });
    const progress = analysisProgress.get(videoPath);
    if (!progress) return res.json({ active: false });
    return res.json({ active: true, ...progress });
});

app.get('/api/video/annotation', async (req, res) => {
    try {
        const videoPath = req.query.path;
        if (!videoPath || typeof videoPath !== 'string') {
            return res.status(400).json({ error: 'Missing path' });
        }
        // Pull every video-level row (timestamp = -1) for this video. For
        // segmented analyses there will be one row per segment (segment_index
        // 0, 1, 2, ...). For short videos there will be exactly one row with
        // segment_index = NULL.
        const result = await pool.query(
            `SELECT * FROM saved_frames
             WHERE video_path = $1 AND timestamp = -1
             ORDER BY segment_index ASC NULLS FIRST, created_at DESC`,
            [videoPath]
        );

        const rows = result.rows;
        if (rows.length === 0) {
            return res.json({ data: null, segmented: false, segments: [] });
        }

        const segmentedRows = rows.filter(r => r.segment_index !== null);
        const segmented = segmentedRows.length > 0;
        const data = segmented ? segmentedRows[0] : rows[0];

        res.json({
            data,
            segmented,
            segments: segmented ? segmentedRows : [],
        });
    } catch (error) {
        console.error('Get video annotation error:', error);
        res.status(500).json({ error: 'Failed to get video annotation', details: error.message });
    }
});

// --- Skip / Unskip API (must precede /api/video/*splat wildcard) ---
//
// A skipped video is one the user reviewed but explicitly chose not to keep.
// We model it as a single sentinel row in saved_frames with timestamp = -1,
// status = 'skipped', format = 'skip'. Skipping a video discards any prior
// annotations for that video_path so the row count stays clean.

app.post('/api/video/skip', express.json(), async (req, res) => {
    try {
        const { videoPath } = req.body || {};
        if (!videoPath || typeof videoPath !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing or invalid videoPath' });
        }
        const abs = safeResolve(videoPath);
        if (!abs) {
            return res.status(403).json({ success: false, error: 'Forbidden path' });
        }
        // Drop any prior annotations for this video — the user is unhappy
        // with them, so we treat skip as a destructive reset.
        await pool.query('DELETE FROM saved_frames WHERE video_path = $1', [videoPath]);
        await pool.query(
            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format)
             VALUES ($1, $2, -1, '', '', 'skipped', 'skip')`,
            [videoPath, path.basename(videoPath)]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('[video-skip] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

app.post('/api/video/unskip', express.json(), async (req, res) => {
    try {
        const { videoPath } = req.body || {};
        if (!videoPath || typeof videoPath !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing or invalid videoPath' });
        }
        await pool.query(
            `DELETE FROM saved_frames WHERE video_path = $1 AND status = 'skipped'`,
            [videoPath]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('[video-unskip] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

app.get('/api/frames/skipped-videos', async (req, res) => {
    try {
        let data = queryCache.get('skipped_videos');
        if (!data) {
            const result = await pool.query(
                `SELECT DISTINCT video_path FROM saved_frames WHERE status = 'skipped'`
            );
            data = result.rows.map(r => ({ video_path: r.video_path }));
            queryCache.set('skipped_videos', data);
        }
        res.json({
            success: true,
            data,
            total: data.length,
        });
    } catch (error) {
        console.error('[skipped-videos] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

// Poster generation: extract a frame at the 1s mark to use as the
// HTML5 <video poster> placeholder. Avoids the black initial frame
// that some videos have. Must be registered BEFORE the
// `/api/video/*splat` wildcard route so the precise path wins.
app.get("/api/video/poster", (req, res) => {
    const rel = req.query.path;
    if (!rel) return sendJson(res, 400, { error: "missing_path" });
    const abs = safeResolve(rel);
    if (!abs) return sendJson(res, 403, { error: "forbidden" });

    execFile(
        "ffmpeg",
        [
            "-ss", "1",
            "-i", abs,
            "-frames:v", "1",
            "-vf", "scale=640:-1",
            "-q:v", "5",
            "-f", "mjpeg",
            "pipe:1",
        ],
        { timeout: 10000, maxBuffer: 5 * 1024 * 1024, encoding: "buffer" },
        (err, stdout) => {
            if (err || !stdout || stdout.length === 0) {
                return res.status(404).end();
            }
            res.writeHead(200, {
                "Content-Type": "image/jpeg",
                "Content-Length": stdout.length,
                "Cache-Control": "public, max-age=86400",
            });
            res.end(stdout);
        }
    );
});

// -------- Video prescreen status/resume (must be before /api/video/*splat) ---
app.get('/api/video/prescreen/batch/status', async (req, res) => {
    setCors(res);
    if (videoPrescreenBatchRunning) {
        return sendJson(res, 200, { running: true, progress: videoPrescreenBatchProgress });
    }
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'video' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length > 0) {
            const row = interrupted.rows[0];
            return sendJson(res, 200, {
                running: false, progress: null,
                interrupted: { batch_id: row.batch_id, config: row.batch_config, progress: row.progress_snapshot }
            });
        }
    } catch { }
    sendJson(res, 200, { running: false, progress: null });
});

app.post('/api/video/prescreen/batch/resume', async (req, res) => {
    setCors(res);
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'video' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length === 0) {
            return sendJson(res, 404, { error: '没有可恢复的中断任务' });
        }
        const row = interrupted.rows[0];
        await pool.query(`UPDATE prescreen_history SET status = 'resumed' WHERE batch_id = $1`, [row.batch_id]);
        const config = row.batch_config || { count: 'all', concurrency: 3 };
        const progress = row.progress_snapshot || {};
        const processed = progress.processed || 0;
        const remaining = config.count === 'all' ? 'all' : Math.max(0, (config.count || 0) - processed);
        sendJson(res, 200, { ok: true, config: { ...config, count: remaining || 'all' } });
    } catch (err) {
        sendJson(res, 500, { error: '恢复任务失败：' + (err?.message || '未知错误') });
    }
});

app.post('/api/video/prescreen/batch/stop', (req, res) => {
    setCors(res);
    if (!videoPrescreenBatchRunning) return sendJson(res, 200, { ok: true, message: 'not_running' });
    videoPrescreenBatchAborted = true;
    sendJson(res, 200, { ok: true, message: 'stopping' });
});

app.get("/api/video/*splat", (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    let rel = url.searchParams.get("path");
    if (!rel) {
        rel = decodeURIComponent(url.pathname.slice("/api/video/".length));
    }
    const abs = rel ? safeResolve(rel) : null;
    if (!abs) return sendJson(res, 400, { error: "invalid_path" });
    streamVideo(req, res, abs);
});

// --- Frame save API routes (OSS + PostgreSQL) ---

app.post('/api/frames/save', upload.single('frame'), async (req, res) => {
    try {
        const { videoPath, videoName, timestamp, format = 'jpeg', width, height } = req.body;
        const file = req.file;

        if (!file || !videoPath || !videoName || timestamp === undefined) {
            return res.status(400).json({ error: 'Missing required fields: frame, videoPath, videoName, timestamp' });
        }

        // Generate OSS key
        const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '/');
        const uniqueId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const ossKey = `video-frames/${dateStr}/${uniqueId}.${format}`;

        // Upload to OSS
        const ossResult = await ossClient.put(ossKey, file.buffer, {
            mime: `image/${format}`,
        });
        const ossUrl = ossResult.url;

        // Call Kimi K2.6 to generate structured description (failure must not block save).
        let aiResult = null;
        try {
            const imageBase64 = file.buffer.toString('base64');
            aiResult = await generateDescription(imageBase64, format);
        } catch (aiError) {
            console.error('Kimi AI generation failed:', aiError.message);
        }

        // Insert into database (with AI fields when available)
        const insertResult = await pool.query(
            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, style, description, format, width, height)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
            [
                videoPath, videoName, parseFloat(timestamp), ossUrl, ossKey,
                aiResult?.prompt || null,
                aiResult?.pose || null,
                aiResult?.pose_en || null,
                JSON.stringify(aiResult?.tags || []),
                aiResult?.style || null,
                aiResult?.description || null,
                format,
                width ? parseInt(width) : null,
                height ? parseInt(height) : null,
            ]
        );

        const saved = insertResult.rows[0];

        res.json({
            success: true,
            data: saved,
            aiGenerated: aiResult !== null,
        });
    } catch (error) {
        console.error('Save frame error:', error);
        res.status(500).json({ error: 'Failed to save frame', details: error.message });
    }
});

app.get('/api/frames', async (req, res) => {
    try {
        const { page = 1, limit = 50, videoPath } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = 'SELECT * FROM saved_frames';
        let params = [];

        if (videoPath) {
            query += ' WHERE video_path = $1';
            params.push(videoPath);
        }

        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(parseInt(limit), offset);

        const result = await pool.query(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) FROM saved_frames';
        let countParams = [];
        if (videoPath) {
            countQuery += ' WHERE video_path = $1';
            countParams.push(videoPath);
        }
        const countResult = await pool.query(countQuery, countParams);

        res.json({
            success: true,
            data: result.rows,
            total: parseInt(countResult.rows[0].count),
            page: parseInt(page),
            limit: parseInt(limit)
        });
    } catch (error) {
        console.error('Query frames error:', error);
        res.status(500).json({ error: 'Failed to query frames', details: error.message });
    }
});

app.get('/api/frames/annotated-videos', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT video_path, COUNT(*) as frame_count FROM saved_frames GROUP BY video_path'
        );
        res.json({
            success: true,
            data: result.rows.map(r => ({ video_path: r.video_path, frame_count: parseInt(r.frame_count) })),
            total: result.rows.length,
        });
    } catch (error) {
        console.error('Query annotated videos error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/frames/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM saved_frames WHERE id = $1', [parseInt(id)]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Frame not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Get frame error:', error);
        res.status(500).json({ error: 'Failed to get frame', details: error.message });
    }
});

// --- Tag Review API (pending [NEW] tags) ---

app.get('/api/tags/pending', (req, res) => {
    try {
        const all = loadPendingTags();
        const pending = all.filter(t => t.status === 'pending');
        // Group by dimension
        const grouped = {};
        for (const tag of pending) {
            if (!grouped[tag.dimension]) grouped[tag.dimension] = [];
            grouped[tag.dimension].push(tag);
        }
        res.json({ success: true, data: grouped, total: pending.length });
    } catch (error) {
        console.error('[tags/pending] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

app.post('/api/tags/approve', express.json(), (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'ids array required' });
        }
        const all = loadPendingTags();
        const idSet = new Set(ids);
        const toApprove = all.filter(t => idSet.has(t.id) && t.status === 'pending');

        // Write approved tags to corresponding cypher .md files
        const byDimension = {};
        for (const t of toApprove) {
            if (!byDimension[t.dimension]) byDimension[t.dimension] = [];
            byDimension[t.dimension].push(t.tag);
        }
        for (const [dimFile, tags] of Object.entries(byDimension)) {
            const filePath = path.join(CYPHER_DIR, dimFile);
            try {
                let content = fs.readFileSync(filePath, 'utf-8');

                // Deduplicate: skip tags already present in file
                const newTags = tags.filter(t => !content.includes(t));
                if (newTags.length === 0) {
                    console.log(`[Tags/approve] All ${tags.length} tag(s) already exist in ${dimFile}, skipping`);
                    continue;
                }

                const sectionHeader = '## 🤖 AI 新增词汇';
                const sectionIndex = content.indexOf(sectionHeader);

                if (sectionIndex !== -1) {
                    // Find the closing ``` of the code block in this section
                    const afterSection = content.slice(sectionIndex);
                    const openFence = afterSection.indexOf('```');
                    if (openFence !== -1) {
                        const closeFence = afterSection.indexOf('```', openFence + 3);
                        if (closeFence !== -1) {
                            // Insert new tags before the closing fence
                            const insertPos = sectionIndex + closeFence;
                            const insertion = newTags.join('\n') + '\n';
                            content = content.slice(0, insertPos) + insertion + content.slice(insertPos);
                        } else {
                            // Malformed: no closing fence, append after open fence line
                            const fenceEnd = afterSection.indexOf('\n', openFence);
                            const insertPos = sectionIndex + fenceEnd + 1;
                            const insertion = newTags.join('\n') + '\n```\n';
                            content = content.slice(0, insertPos) + insertion + content.slice(insertPos);
                        }
                    } else {
                        // Section exists but no code block — add one
                        const sectionEnd = sectionIndex + sectionHeader.length;
                        const insertion = '\n\n```\n' + newTags.join('\n') + '\n```\n';
                        content = content.slice(0, sectionEnd) + insertion + content.slice(sectionEnd);
                    }
                } else {
                    // Section doesn't exist — create it at end of file
                    const section = '\n---\n\n## 🤖 AI 新增词汇\n\n```\n' + newTags.join('\n') + '\n```\n';
                    content = content.trimEnd() + '\n' + section;
                }

                fs.writeFileSync(filePath, content, 'utf-8');
                console.log(`[Tags/approve] Inserted ${newTags.length} tag(s) into ${dimFile} (AI新增词汇 section)`);
            } catch (err) {
                console.error(`[Tags/approve] Failed to write to ${dimFile}:`, err.message);
            }
        }

        // Update status
        for (const t of all) {
            if (idSet.has(t.id) && t.status === 'pending') t.status = 'approved';
        }
        savePendingTags(all);
        res.json({ success: true, approved: toApprove.length });
    } catch (error) {
        console.error('[tags/approve] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

app.post('/api/tags/reject', express.json(), (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'ids array required' });
        }
        const all = loadPendingTags();
        const idSet = new Set(ids);
        let rejected = 0;
        for (const t of all) {
            if (idSet.has(t.id) && t.status === 'pending') {
                t.status = 'rejected';
                rejected++;
            }
        }
        savePendingTags(all);
        res.json({ success: true, rejected });
    } catch (error) {
        console.error('[tags/reject] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

// --- Frame Feedback API (quality review) ---

app.post('/api/frames/:id/feedback', express.json(), async (req, res) => {
    try {
        const { id } = req.params;
        const { feedback, note } = req.body || {};
        if (feedback !== null && feedback !== 'good' && feedback !== 'bad') {
            return res.status(400).json({ success: false, error: 'feedback must be "good", "bad", or null' });
        }
        const result = await pool.query(
            `UPDATE saved_frames SET feedback = $1, feedback_note = $2, feedback_at = NOW() WHERE id = $3 RETURNING id, feedback, feedback_note, feedback_at`,
            [feedback || null, (feedback === 'bad' ? (note || null) : null), parseInt(id)]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Frame not found' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[frames/feedback] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

app.get('/api/frames/feedback-history', async (req, res) => {
    try {
        const { videoPath, feedback: fbFilter, limit = '50' } = req.query;
        let query = `SELECT id, video_path, video_name, timestamp, oss_url, description, feedback, feedback_note, feedback_at FROM saved_frames WHERE feedback IS NOT NULL`;
        const params = [];
        if (videoPath) {
            params.push(videoPath);
            query += ` AND video_path = $${params.length}`;
        }
        if (fbFilter === 'good' || fbFilter === 'bad') {
            params.push(fbFilter);
            query += ` AND feedback = $${params.length}`;
        }
        query += ` ORDER BY feedback_at DESC`;
        params.push(parseInt(limit));
        query += ` LIMIT $${params.length}`;
        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows, total: result.rows.length });
    } catch (error) {
        console.error('[frames/feedback-history] error:', error);
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

// -------- Image API endpoints -------------------------------------------------

app.get('/api/images', async (req, res) => {
    setCors(res);
    if (!imageCache) {
        await performImageScan();
    }
    if (!imageCache) {
        return sendJson(res, 503, { error: 'Image cache not available yet' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === '0' ? 0 : Math.max(1, parseInt(rawLimit || "200", 10));
    const folder = url.searchParams.get("folder") || null;
    const sortBy = url.searchParams.get("sort") || "recent";
    const search = (url.searchParams.get("q") || "").trim().toLowerCase();

    const hasFilter = (folder && folder !== "__ALL__") || search;

    let items;
    if (!hasFilter) {
        // No filter: use pre-sorted array directly (O(1) vs O(n log n))
        switch (sortBy) {
            case "size": items = imageCache.sortedBySize || [...imageCache.items.values()]; break;
            case "name": items = imageCache.sortedByName || [...imageCache.items.values()]; break;
            case "recent":
            default: items = imageCache.sortedByRecent || [...imageCache.items.values()]; break;
        }
    } else {
        // Has filter: must filter first, then sort
        items = [...imageCache.items.values()];
        if (folder && folder !== "__ALL__") {
            items = items.filter(v => {
                const itemFolder = v.folder || "(root)";
                return itemFolder === folder || itemFolder.startsWith(folder + "/");
            });
        }
        if (search) {
            items = items.filter(v =>
                v.name.toLowerCase().includes(search) ||
                v.folder.toLowerCase().includes(search)
            );
        }
        switch (sortBy) {
            case "size": items.sort((a, b) => b.size - a.size); break;
            case "name": items.sort((a, b) => a.name.localeCompare(b.name)); break;
            case "recent":
            default: items.sort((a, b) => b.mtime - a.mtime); break;
        }
    }

    const totalFiltered = items.length;
    if (limit > 0) {
        const start = (page - 1) * limit;
        items = items.slice(start, start + limit);
    }

    const groups = [...imageCache.groups.values()].sort((a, b) => a.folder.localeCompare(b.folder));

    sendJson(res, 200, {
        root: IMAGES_ROOT,
        count: imageCache.items.size,
        totalSize: imageCache.totalSize,
        totalFiltered,
        page,
        limit,
        totalPages: limit > 0 ? Math.ceil(totalFiltered / limit) : 1,
        groups,
        items,
    });
});

app.get('/api/images/annotated', async (req, res) => {
    setCors(res);
    try {
        let data = queryCache.get('images_annotated');
        if (!data) {
            const result = await pool.query(
                `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_annotation'`
            );
            data = result.rows.map(r => r.video_path);
            queryCache.set('images_annotated', data);
        }
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Get skipped image paths
app.get('/api/images/skipped', async (req, res) => {
    setCors(res);
    try {
        let data = queryCache.get('images_skipped');
        if (!data) {
            const result = await pool.query(
                `SELECT DISTINCT video_path, description FROM saved_frames WHERE format = 'image_skip'`
            );
            data = result.rows.map(r => ({ path: r.video_path, reason: r.description }));
            queryCache.set('images_skipped', data);
        }
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Available prescreen models for multi-vote
app.get('/api/prescreen/models', (req, res) => {
    setCors(res);
    sendJson(res, 200, { models: getAvailableModels() });
});

// Get prescreened image paths with status
app.get('/api/images/prescreened', async (req, res) => {
    setCors(res);
    try {
        let data = queryCache.get('images_prescreened');
        if (!data) {
            const result = await pool.query(
                `SELECT DISTINCT ON (video_path) video_path, status, description, batch_id, created_at FROM saved_frames WHERE format = 'image_prescreen' ORDER BY video_path, created_at DESC`
            );
            data = result.rows.map(r => {
                let parsed = {};
                try { parsed = JSON.parse(r.description); } catch { }
                return {
                    path: r.video_path,
                    status: r.status,
                    reason: parsed.reason || '',
                    confidence: parsed.confidence || 'medium',
                    category: parsed.category || 'none',
                    batch_id: r.batch_id || null,
                    prescreened_at: r.created_at || null
                };
            });
            queryCache.set('images_prescreened', data);
        }
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Get prescreen batch summaries
app.get('/api/prescreen/batches', async (req, res) => {
    setCors(res);
    try {
        const result = await pool.query(
            `SELECT batch_id, type, started_at, completed_at, confirmed_at, count_passed, count_rejected, count_error
             FROM prescreen_history
             WHERE type = 'image'
             ORDER BY started_at DESC
             LIMIT 50`
        );
        res.json({ success: true, batches: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Confirm prescreen batch (human approval gate)
app.post('/api/prescreen/batch/confirm', express.json(), async (req, res) => {
    setCors(res);
    try {
        const result = await pool.query(
            `UPDATE prescreen_history SET confirmed_at = NOW()
             WHERE type = 'image' AND confirmed_at IS NULL AND completed_at IS NOT NULL
             RETURNING batch_id`
        );
        res.json({ success: true, confirmed: result.rowCount });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Manual skip an image
app.post('/api/image/skip', express.json(), async (req, res) => {
    setCors(res);
    const { path: imagePath } = req.body || {};
    if (!imagePath) return sendJson(res, 400, { error: 'path required' });
    try {
        await pool.query(
            `DELETE FROM saved_frames WHERE video_path = $1 AND format IN ('image_annotation', 'image_skip')`,
            [imagePath]
        );
        await pool.query(
            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, created_at)
             VALUES ($1, $2, -1, '', '', 'skipped', 'image_skip', 'Manual skip', NOW())`,
            [imagePath, path.basename(imagePath)]
        );
        queryCache.invalidate('images_skipped');
        queryCache.invalidate('images_annotated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Batch skip images (Manual reject)
app.post('/api/image/skip/batch', express.json(), async (req, res) => {
    setCors(res);
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
        return sendJson(res, 400, { error: 'invalid_paths', message: 'paths must be a non-empty array' });
    }
    try {
        let skipped = 0;
        for (const imagePath of paths) {
            if (typeof imagePath !== 'string' || !imagePath.trim()) continue;
            await pool.query(
                `DELETE FROM saved_frames WHERE video_path = $1 AND format IN ('image_annotation', 'image_skip')`,
                [imagePath]
            );
            const imageName = path.basename(imagePath) || imagePath;
            await pool.query(
                `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, created_at)
                 VALUES ($1, $2, -1, '', '', 'skipped', 'image_skip', $3, NOW())`,
                [imagePath, imageName, 'Manual reject']
            );
            skipped++;
        }
        queryCache.invalidate('images_skipped');
        queryCache.invalidate('images_annotated');
        res.json({ success: true, skipped, total: paths.length });
    } catch (err) {
        console.error('[image-skip-batch] error:', err?.message);
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Unskip an image
app.post('/api/image/unskip', express.json(), async (req, res) => {
    setCors(res);
    const { path: imagePath } = req.body || {};
    if (!imagePath) return sendJson(res, 400, { error: 'path required' });
    try {
        await pool.query(
            `DELETE FROM saved_frames WHERE video_path = $1 AND format = 'image_skip'`,
            [imagePath]
        );
        queryCache.invalidate('images_skipped');
        queryCache.invalidate('images_annotated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

// Get annotation details for a specific image
app.get('/api/image/annotation', async (req, res) => {
    setCors(res);
    const imagePath = req.query.path;
    if (!imagePath) return sendJson(res, 400, { error: 'path required' });
    try {
        const result = await pool.query(
            `SELECT id, video_path, video_name, prompt, pose, pose_en, tags, dimensions, style, description, model_id, created_at, video_prompt, video_prompt_model, material_type
             FROM saved_frames WHERE video_path = $1 AND format = 'image_annotation'
             ORDER BY created_at DESC LIMIT 1`,
            [imagePath]
        );
        if (result.rows.length === 0) {
            return sendJson(res, 404, { success: false, error: 'No annotation found' });
        }
        const row = result.rows[0];
        // Parse dimensions and tags from JSONB/text
        let dimensions = row.dimensions;
        if (typeof dimensions === 'string') {
            try { dimensions = JSON.parse(dimensions); } catch { dimensions = {}; }
        }
        let tags = row.tags;
        if (typeof tags === 'string') {
            try { tags = JSON.parse(tags); } catch { tags = []; }
        }
        res.json({
            success: true,
            data: {
                id: row.id,
                path: row.video_path,
                name: row.video_name,
                prompt: row.prompt,
                pose: row.pose,
                pose_en: row.pose_en,
                style: row.style,
                description: row.description,
                dimensions: dimensions || {},
                tags: tags || [],
                model_id: row.model_id,
                created_at: row.created_at,
                video_prompt: row.video_prompt || null,
                video_prompt_model: row.video_prompt_model || null,
                material_type: row.material_type || inferMaterialType(row.video_path) || 'normal',
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message });
    }
});

app.get('/api/images/serve', (req, res) => {
    setCors(res);
    const relPath = req.query.path;
    const abs = safeResolveImage(relPath);
    if (!abs || !fs.existsSync(abs)) {
        return sendJson(res, 404, { error: 'Image not found' });
    }
    const ext = path.extname(abs).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(abs).pipe(res);
});

app.get('/api/image/analyze/batch/status', async (req, res) => {
    setCors(res);
    if (imageBatchRunning) {
        return sendJson(res, 200, { running: true, progress: imageBatchProgress });
    }
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'image_annotation' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length > 0) {
            const row = interrupted.rows[0];
            return sendJson(res, 200, {
                running: false, progress: null,
                interrupted: { batch_id: row.batch_id, config: row.batch_config, progress: row.progress_snapshot }
            });
        }
    } catch { }
    sendJson(res, 200, { running: false, progress: null });
});

app.post('/api/image/analyze/batch/resume', async (req, res) => {
    setCors(res);
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'image_annotation' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length === 0) {
            return sendJson(res, 404, { error: '没有可恢复的中断任务' });
        }
        const row = interrupted.rows[0];
        await pool.query(`UPDATE prescreen_history SET status = 'resumed' WHERE batch_id = $1`, [row.batch_id]);
        const config = row.batch_config || { count: 'all', concurrency: 3 };
        const progress = row.progress_snapshot || {};
        const processed = progress.processed || 0;
        const remaining = config.count === 'all' ? 'all' : Math.max(0, (config.count || 0) - processed);
        sendJson(res, 200, { ok: true, config: { ...config, count: remaining || 'all' } });
    } catch (err) {
        sendJson(res, 500, { error: '恢复任务失败：' + (err?.message || '未知错误') });
    }
});

app.post('/api/image/analyze/batch/stop', (req, res) => {
    setCors(res);
    if (!imageBatchRunning) return sendJson(res, 200, { ok: true, message: 'not_running' });
    imageBatchAborted = true;
    sendJson(res, 200, { ok: true, message: 'stopping' });
});

// -------- Image Pre-screen Endpoints ------------------------------------------
app.get('/api/image/prescreen/batch/status', async (req, res) => {
    setCors(res);
    if (prescreenBatchRunning) {
        return sendJson(res, 200, { running: true, progress: prescreenBatchProgress });
    }
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'image' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length > 0) {
            const row = interrupted.rows[0];
            return sendJson(res, 200, {
                running: false, progress: null,
                interrupted: { batch_id: row.batch_id, config: row.batch_config, progress: row.progress_snapshot }
            });
        }
    } catch { }
    sendJson(res, 200, { running: false, progress: null });
});

app.post('/api/image/prescreen/batch/resume', async (req, res) => {
    setCors(res);
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'image' AND status = 'interrupted' AND completed_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length === 0) {
            return sendJson(res, 404, { error: '没有可恢复的中断任务' });
        }
        const row = interrupted.rows[0];
        await pool.query(`UPDATE prescreen_history SET status = 'resumed' WHERE batch_id = $1`, [row.batch_id]);
        const config = row.batch_config || { count: 'all', concurrency: 3 };
        const progress = row.progress_snapshot || {};
        const processed = progress.processed || 0;
        const remaining = config.count === 'all' ? 'all' : Math.max(0, (config.count || 0) - processed);
        sendJson(res, 200, { ok: true, config: { ...config, count: remaining || 'all' } });
    } catch (err) {
        sendJson(res, 500, { error: '恢复任务失败：' + (err?.message || '未知错误') });
    }
});

app.post('/api/image/prescreen/batch/stop', (req, res) => {
    setCors(res);
    if (!prescreenBatchRunning) return sendJson(res, 200, { ok: true, message: 'not_running' });
    prescreenBatchAborted = true;
    sendJson(res, 200, { ok: true, message: 'stopping' });
});

app.post('/api/image/prescreen/batch', express.json(), async (req, res) => {
    if (prescreenBatchRunning) {
        return sendJson(res, 409, { error: 'prescreen_running', message: 'A prescreen batch is already in progress' });
    }

    // Human confirmation gate: block new batch if last batch not confirmed
    try {
        const lastBatch = await pool.query(
            `SELECT batch_id, confirmed_at FROM prescreen_history
             WHERE type = 'image' AND completed_at IS NOT NULL
             ORDER BY started_at DESC LIMIT 1`
        );
        if (lastBatch.rows.length > 0 && !lastBatch.rows[0].confirmed_at) {
            return sendJson(res, 409, {
                error: 'batch_not_confirmed',
                message: '上次预筛选结果尚未确认清洗完毕，请先确认后再启动新批次'
            });
        }
    } catch (e) { /* query failure should not block */ }

    const { count, folder, concurrency: rawConcurrency, batchSize: rawBatchSize, voters, arbiter, prescreenStrategy: rawPrescreenStrategy, prescreenModels: rawPrescreenModels, prescreenArbiter: rawPrescreenArbiter } = req.body || {};
    if (count !== 'all' && (!Number.isInteger(count) || count < 1)) {
        return sendJson(res, 400, { error: 'invalid_count', message: 'count must be a positive integer or "all"' });
    }
    const concurrency = Math.min(Math.max(parseInt(rawConcurrency) || 1, 1), 20);
    const batchSize = Math.min(Math.max(parseInt(rawBatchSize) || 1, 1), 8);
    // Multi-model strategy params (backward compatible)
    const prescreenStrategy = rawPrescreenStrategy || ((voters && Array.isArray(voters) && voters.length > 0) ? 'vote' : 'single');
    const prescreenModels = rawPrescreenModels || voters || [];
    const prescreenArbiter = rawPrescreenArbiter || arbiter || 'deepseek';

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    function sendEvent(type, data) {
        try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch (e) { /* ignore */ }
    }

    prescreenBatchRunning = true;
    prescreenBatchAborted = false;

    try {
        if (!imageCache) await performImageScan();
        if (!imageCache || !imageCache.items) {
            sendEvent('error', { message: 'Image cache not available' });
            prescreenBatchRunning = false;
            return res.end();
        }

        // Get already-annotated, already-skipped, and already-prescreened image paths
        const annotatedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_annotation'`
        );
        const annotatedSet = new Set(annotatedRes.rows.map(r => r.video_path));

        const skippedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_skip'`
        );
        const skippedSet = new Set(skippedRes.rows.map(r => r.video_path));

        const prescreenedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_prescreen'`
        );
        const prescreenedSet = new Set(prescreenedRes.rows.map(r => r.video_path));

        // Filter: not annotated, not skipped, not already prescreened
        let allImages = [...imageCache.items.values()].filter(
            img => !annotatedSet.has(img.path) && !skippedSet.has(img.path) && !prescreenedSet.has(img.path)
        );

        if (folder && folder !== '__ALL__') {
            allImages = allImages.filter(img => img.folder === folder || img.folder.startsWith(folder + '/'));
        }

        allImages.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

        const limit = count === 'all' ? allImages.length : Math.min(count, allImages.length);
        const toProcess = allImages.slice(0, limit);

        if (toProcess.length === 0) {
            sendEvent('done', { message: 'No images to prescreen', total: 0 });
            prescreenBatchRunning = false;
            return res.end();
        }

        prescreenBatchProgress = { total: toProcess.length, processed: 0, passed: 0, rejected: 0, errors: 0 };
        // Aggregate recent human corrections into concise textual rules and
        // append them to the prescreen prompt for this batch. Token-cheap
        // alternative to image-based few-shot examples.
        let feedbackRules = '';
        try {
            const feedbackRes = await pool.query(
                `SELECT error_category, description FROM prescreen_feedback
                 WHERE created_at > NOW() - INTERVAL '30 days'
                 ORDER BY created_at DESC LIMIT 50`
            );
            feedbackRules = generateFeedbackRules(feedbackRes.rows);
        } catch (e) { /* feedback table missing or query failed; ignore */ }
        // Generate a unique batch identifier and persist a history row so the
        // client can later reset/rollback this specific run.
        const batchId = randomUUID();
        const batchConfig = { count, folder, concurrency, batchSize, prescreenStrategy, prescreenModels, prescreenArbiter };
        await pool.query(
            `INSERT INTO prescreen_history (batch_id, type, started_at, batch_config, status) VALUES ($1, 'image', NOW(), $2, 'running')`,
            [batchId, JSON.stringify(batchConfig)]
        );
        sendEvent('start', { total: toProcess.length, batch_id: batchId });

        const prescreenBalancer = prescreenStrategy === 'loadbalance' ? createLoadBalancer(prescreenModels) : null;

        if (batchSize > 1) {
            // Multi-image batch mode
            const step = batchSize * concurrency;
            for (let i = 0; i < toProcess.length; i += step) {
                if (prescreenBatchAborted) {
                    sendEvent('aborted', { message: 'Prescreen aborted by client', progress: prescreenBatchProgress });
                    break;
                }

                const stepSlice = toProcess.slice(i, Math.min(i + step, toProcess.length));
                const groups = [];
                for (let g = 0; g < stepSlice.length; g += batchSize) {
                    groups.push(stepSlice.slice(g, g + batchSize));
                }

                await Promise.allSettled(groups.map(async (group, gIdx) => {
                    const groupStartIdx = i + gIdx * batchSize;

                    // Send item_start for all images in this group
                    for (let j = 0; j < group.length; j++) {
                        sendEvent('item_start', { index: groupStartIdx + j, imagePath: group[j].path, imageName: group[j].name });
                    }

                    try {
                        // Read all images in the group
                        const imageData = await Promise.all(group.map(async img => {
                            const abs = path.join(IMAGES_ROOT, img.path);
                            const buffer = await fsp.readFile(abs);
                            return { base64: buffer.toString('base64'), format: (img.ext === 'jpg' ? 'jpeg' : (img.ext || 'jpeg')), name: img.name };
                        }));

                        // Call batch pre-screen based on strategy
                        let batchResults;
                        if (prescreenStrategy === 'vote') {
                            // Multi-vote mode: each image goes through multi-vote individually
                            batchResults = await Promise.all(imageData.map(async (img) => {
                                return preScreenImageMultiVote(img.base64, img.format, prescreenModels, prescreenArbiter, feedbackRules);
                            }));
                        } else if (prescreenStrategy === 'loadbalance') {
                            batchResults = await Promise.all(imageData.map(async (img) => {
                                const modelKey = prescreenBalancer.next();
                                const result = await preScreenImage(img.base64, img.format, modelKey, feedbackRules);
                                return { ...result, model_used: modelKey };
                            }));
                        } else {
                            batchResults = await preScreenImageBatch(imageData, undefined, feedbackRules);
                        }

                        // Process each result
                        for (let j = 0; j < group.length; j++) {
                            const img = group[j];
                            const screenResult = batchResults[j] || { should_annotate: true, reason: 'Missing result', confidence: 'low', category: 'none' };

                            await pool.query(
                                `DELETE FROM saved_frames WHERE video_path = $1 AND format = 'image_prescreen'`,
                                [img.path]
                            );
                            await pool.query(
                                `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, model_id, batch_id, created_at)
                                 VALUES ($1, $2, -1, '', '', $3, 'image_prescreen', $4, $5, $6, NOW())`,
                                [img.path, img.name, screenResult.should_annotate ? 'passed' : 'rejected',
                                JSON.stringify({ should_annotate: screenResult.should_annotate, reason: screenResult.reason, confidence: screenResult.confidence, category: screenResult.category || 'none', ...(screenResult.voters ? { voters: screenResult.voters } : {}), ...(screenResult.model_used ? { model_used: screenResult.model_used } : {}) }),
                                screenResult.model_used || null,
                                    batchId]
                            );

                            sendEvent('item_done', {
                                index: groupStartIdx + j, imagePath: img.path, imageName: img.name,
                                should_annotate: screenResult.should_annotate, reason: screenResult.reason,
                                confidence: screenResult.confidence, category: screenResult.category || 'none',
                                ...(screenResult.model_used ? { model_used: screenResult.model_used } : {}),
                            });

                            if (screenResult.should_annotate) prescreenBatchProgress.passed++;
                            else prescreenBatchProgress.rejected++;
                            queryCache.invalidate('images_prescreened');
                        }
                    } catch (err) {
                        // Entire group failed
                        for (let j = 0; j < group.length; j++) {
                            sendEvent('item_done', {
                                index: groupStartIdx + j, imagePath: group[j].path, imageName: group[j].name,
                                should_annotate: true, reason: `Error: ${err?.message || 'Unknown'}`, confidence: 'low', category: 'none', error: true,
                            });
                            prescreenBatchProgress.errors++;
                        }
                    }
                }));

                prescreenBatchProgress.processed = Math.min(i + step, toProcess.length);
                pool.query(`UPDATE prescreen_history SET progress_snapshot = $1 WHERE batch_id = $2`, [JSON.stringify(prescreenBatchProgress), batchId]).catch(() => { });
            }
        } else {
            // Original single-image mode (batchSize === 1)
            for (let i = 0; i < toProcess.length; i += concurrency) {
                if (prescreenBatchAborted) {
                    sendEvent('aborted', { message: 'Prescreen aborted by client', progress: prescreenBatchProgress });
                    break;
                }

                const batch = toProcess.slice(i, Math.min(i + concurrency, toProcess.length));

                await Promise.allSettled(batch.map(async (img, bIdx) => {
                    const idx = i + bIdx;
                    const imagePath = img.path;
                    const imageName = img.name;

                    sendEvent('item_start', { index: idx, imagePath, imageName });

                    try {
                        const abs = path.join(IMAGES_ROOT, imagePath);
                        const buffer = await fsp.readFile(abs);
                        const imageBase64 = buffer.toString('base64');
                        const ext = img.ext || 'jpeg';
                        const format = ext === 'jpg' ? 'jpeg' : ext;

                        let screenResult;
                        let modelUsed;
                        if (prescreenStrategy === 'vote') {
                            screenResult = await preScreenImageMultiVote(imageBase64, format, prescreenModels, prescreenArbiter, feedbackRules);
                        } else if (prescreenStrategy === 'loadbalance') {
                            modelUsed = prescreenBalancer.next();
                            screenResult = await preScreenImage(imageBase64, format, modelUsed, feedbackRules);
                        } else {
                            screenResult = await preScreenImage(imageBase64, format, undefined, feedbackRules);
                        }

                        // Store prescreen result to database
                        await pool.query(
                            `DELETE FROM saved_frames WHERE video_path = $1 AND format = 'image_prescreen'`,
                            [imagePath]
                        );
                        await pool.query(
                            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, model_id, batch_id, created_at)
                             VALUES ($1, $2, -1, '', '', $3, 'image_prescreen', $4, $5, $6, NOW())`,
                            [
                                imagePath,
                                imageName,
                                screenResult.should_annotate ? 'passed' : 'rejected',
                                JSON.stringify({ should_annotate: screenResult.should_annotate, reason: screenResult.reason, confidence: screenResult.confidence, category: screenResult.category || 'none', ...(screenResult.voters ? { voters: screenResult.voters } : {}), ...(modelUsed ? { model_used: modelUsed } : {}) }),
                                modelUsed || null,
                                batchId,
                            ]
                        );

                        sendEvent('item_done', {
                            index: idx, imagePath, imageName,
                            should_annotate: screenResult.should_annotate,
                            reason: screenResult.reason,
                            confidence: screenResult.confidence,
                            category: screenResult.category || 'none',
                            ...(modelUsed ? { model_used: modelUsed } : {}),
                        });

                        if (screenResult.should_annotate) {
                            prescreenBatchProgress.passed++;
                        } else {
                            prescreenBatchProgress.rejected++;
                        }
                        queryCache.invalidate('images_prescreened');
                    } catch (err) {
                        console.error(`[prescreen-batch] error processing ${imagePath}:`, err?.message);
                        sendEvent('item_done', {
                            index: idx, imagePath, imageName,
                            should_annotate: true, // default pass on error
                            reason: `Error: ${err?.message || 'Unknown'}`,
                            confidence: 'low',
                            category: 'none',
                            error: true,
                        });
                        prescreenBatchProgress.errors++;
                    }
                }));

                // Update processed count after batch completes
                prescreenBatchProgress.processed = Math.min(i + concurrency, toProcess.length);
                pool.query(`UPDATE prescreen_history SET progress_snapshot = $1 WHERE batch_id = $2`, [JSON.stringify(prescreenBatchProgress), batchId]).catch(() => { });
            }
        }

        // Finalise history row with completion stats. Done before sending the
        // 'done' event so the client can immediately query history.
        if (prescreenBatchAborted) {
            await pool.query(
                `UPDATE prescreen_history SET status = 'interrupted', progress_snapshot = $1 WHERE batch_id = $2`,
                [JSON.stringify(prescreenBatchProgress), batchId]
            ).catch(() => { });
        } else {
            await pool.query(
                `UPDATE prescreen_history SET completed_at = NOW(), count_passed = $1, count_rejected = $2, count_error = $3, status = 'completed', progress_snapshot = $4 WHERE batch_id = $5`,
                [prescreenBatchProgress.passed, prescreenBatchProgress.rejected, prescreenBatchProgress.errors, JSON.stringify(prescreenBatchProgress), batchId]
            ).catch(() => { });
            sendEvent('done', { progress: prescreenBatchProgress, batch_id: batchId });
        }
    } catch (err) {
        console.error('[prescreen-batch] fatal error:', err?.message);
        sendEvent('error', { message: err?.message || 'Unknown error' });
    } finally {
        prescreenBatchRunning = false;
        res.end();
    }
});

app.get('/api/image/prescreen/results', async (req, res) => {
    setCors(res);
    try {
        const { batch_id } = req.query || {};
        let query, params;
        if (batch_id) {
            query = `SELECT video_path, video_name, status, description, created_at 
                     FROM saved_frames WHERE format = 'image_prescreen' AND batch_id = $1
                     ORDER BY created_at DESC`;
            params = [batch_id];
        } else {
            // Get latest batch's results
            const latestBatch = await pool.query(
                `SELECT batch_id FROM prescreen_history WHERE type = 'image' AND completed_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`
            );
            if (latestBatch.rows.length > 0) {
                query = `SELECT video_path, video_name, status, description, created_at 
                         FROM saved_frames WHERE format = 'image_prescreen' AND batch_id = $1
                         ORDER BY created_at DESC`;
                params = [latestBatch.rows[0].batch_id];
            } else {
                query = `SELECT video_path, video_name, status, description, created_at 
                         FROM saved_frames WHERE format = 'image_prescreen' 
                         ORDER BY created_at DESC LIMIT 500`;
                params = [];
            }
        }
        const rows = await pool.query(query, params);
        const results = rows.rows.map(r => {
            let parsed = {};
            try { parsed = JSON.parse(r.description); } catch { }
            return {
                path: r.video_path,
                name: r.video_name,
                status: r.status,
                should_annotate: parsed.should_annotate ?? (r.status === 'passed'),
                reason: parsed.reason || '',
                confidence: parsed.confidence || 'medium',
                category: parsed.category || 'none',
                created_at: r.created_at,
            };
        });
        sendJson(res, 200, { results, total: results.length });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

app.post('/api/image/prescreen/override', express.json(), async (req, res) => {
    setCors(res);
    const { path: imagePath, should_annotate, category, error_category, feedback_description } = req.body || {};
    if (!imagePath || typeof should_annotate !== 'boolean') {
        return sendJson(res, 400, { error: 'path and should_annotate (boolean) required' });
    }
    try {
        await pool.query(
            `UPDATE saved_frames SET status = $1, description = $2 WHERE video_path = $3 AND format = 'image_prescreen'`,
            [
                should_annotate ? 'passed' : 'rejected',
                JSON.stringify({ should_annotate, reason: 'Manual override', confidence: 'high', category: category || (should_annotate ? 'body_nsfw' : 'none') }),
                imagePath
            ]
        );
        // Capture structured human feedback when an error_category is supplied.
        // Pre-override status is the inverse of the corrected one.
        if (error_category) {
            const correctedStatus = should_annotate ? 'passed' : 'rejected';
            const originalStatus = should_annotate ? 'rejected' : 'passed';
            await pool.query(
                `INSERT INTO prescreen_feedback (image_path, original_status, corrected_status, error_category, description)
                 VALUES ($1, $2, $3, $4, $5)`,
                [imagePath, originalStatus, correctedStatus, error_category, feedback_description || '']
            );
        }
        queryCache.invalidate('images_prescreened');
        sendJson(res, 200, { ok: true });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Prescreen feedback management --------------------------------------
app.get('/api/prescreen/feedback', async (req, res) => {
    setCors(res);
    try {
        const rows = await pool.query(
            `SELECT id, image_path, original_status, corrected_status, error_category, description, created_at
             FROM prescreen_feedback ORDER BY created_at DESC LIMIT 100`
        );
        sendJson(res, 200, { feedback: rows.rows });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

app.get('/api/prescreen/feedback/summary', async (req, res) => {
    setCors(res);
    try {
        const feedbackRes = await pool.query(
            `SELECT error_category, description FROM prescreen_feedback
             WHERE created_at > NOW() - INTERVAL '30 days'
             ORDER BY created_at DESC LIMIT 50`
        );
        const rules = generateFeedbackRules(feedbackRes.rows);
        const statsRes = await pool.query(
            `SELECT error_category, description, COUNT(*) as cnt
             FROM prescreen_feedback
             WHERE created_at > NOW() - INTERVAL '30 days'
             GROUP BY error_category, description
             ORDER BY cnt DESC LIMIT 20`
        );
        sendJson(res, 200, { rules, stats: statsRes.rows, total: feedbackRes.rows.length });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

app.delete('/api/prescreen/feedback/:id', async (req, res) => {
    setCors(res);
    try {
        await pool.query(`DELETE FROM prescreen_feedback WHERE id = $1`, [req.params.id]);
        sendJson(res, 200, { ok: true });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Video prescreen endpoints ------------------------------------------

app.get('/api/videos/prescreened', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DISTINCT ON (video_path) video_path, status, description FROM saved_frames WHERE format = 'video_prescreen' ORDER BY video_path, created_at DESC`
        );
        const items = result.rows.map(r => {
            let parsed = {};
            try { parsed = JSON.parse(r.description || '{}'); } catch { }
            return {
                path: r.video_path,
                status: r.status,
                reason: parsed.reason || '',
                confidence: parsed.confidence || 'medium',
                category: parsed.category || 'none',
            };
        });
        sendJson(res, 200, items);
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

app.post('/api/video/prescreen/batch', express.json(), async (req, res) => {
    if (videoPrescreenBatchRunning) {
        return sendJson(res, 409, { error: 'prescreen_running', message: 'A video prescreen batch is already in progress' });
    }

    const { count, concurrency: rawConcurrency } = req.body || {};
    if (count !== 'all' && (!Number.isInteger(count) || count < 1)) {
        return sendJson(res, 400, { error: 'invalid_count', message: 'count must be a positive integer or "all"' });
    }
    const concurrency = Math.min(Math.max(parseInt(rawConcurrency) || 1, 1), 20);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    function sendEvent(type, data) {
        try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch (e) { /* ignore */ }
    }

    videoPrescreenBatchRunning = true;
    videoPrescreenBatchAborted = false;

    try {
        // Get video cache
        if (!cache) await performScan();
        if (!cache || !cache.items) {
            sendEvent('error', { message: 'Video cache not available' });
            videoPrescreenBatchRunning = false;
            return res.end();
        }

        // Get already-annotated and already-prescreened video paths
        const annotatedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE timestamp = -1 AND format IN ('annotation', 'skip')`
        );
        const annotatedSet = new Set(annotatedRes.rows.map(r => r.video_path));

        const prescreenedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'video_prescreen'`
        );
        const prescreenedSet = new Set(prescreenedRes.rows.map(r => r.video_path));

        // Filter: not annotated, not already prescreened
        let allVideos = [...cache.items.values()].filter(
            v => !annotatedSet.has(v.path) && !prescreenedSet.has(v.path)
        );

        allVideos.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

        const limit = count === 'all' ? allVideos.length : Math.min(count, allVideos.length);
        const toProcess = allVideos.slice(0, limit);

        if (toProcess.length === 0) {
            sendEvent('done', { message: 'No videos to prescreen', total: 0 });
            videoPrescreenBatchRunning = false;
            return res.end();
        }

        videoPrescreenBatchProgress = { total: toProcess.length, processed: 0, passed: 0, rejected: 0, errors: 0 };
        const batchId = randomUUID();
        const batchConfig = { count, concurrency };
        await pool.query(
            `INSERT INTO prescreen_history (batch_id, type, started_at, batch_config, status) VALUES ($1, 'video', NOW(), $2, 'running')`,
            [batchId, JSON.stringify(batchConfig)]
        );
        sendEvent('start', { total: toProcess.length, batch_id: batchId });

        for (let i = 0; i < toProcess.length; i += concurrency) {
            if (videoPrescreenBatchAborted) {
                sendEvent('aborted', { message: 'Prescreen aborted by client', progress: videoPrescreenBatchProgress });
                break;
            }

            const batch = toProcess.slice(i, Math.min(i + concurrency, toProcess.length));

            await Promise.allSettled(batch.map(async (video, bIdx) => {
                const idx = i + bIdx;
                const videoPath = video.path;
                const videoName = video.name || path.basename(videoPath);

                sendEvent('item_start', { index: idx, videoPath, videoName });

                try {
                    const fullPath = safeResolve(videoPath);
                    if (!fullPath || !fs.existsSync(fullPath)) {
                        throw new Error('File not found');
                    }

                    const screenResult = await preScreenVideo(fullPath);

                    // Store prescreen result to database
                    await pool.query(
                        `DELETE FROM saved_frames WHERE video_path = $1 AND format = 'video_prescreen'`,
                        [videoPath]
                    );
                    await pool.query(
                        `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, model_id, batch_id, created_at)
                         VALUES ($1, $2, -1, '', '', $3, 'video_prescreen', $4, NULL, $5, NOW())`,
                        [
                            videoPath,
                            videoName,
                            screenResult.should_annotate ? 'passed' : 'rejected',
                            JSON.stringify({ should_annotate: screenResult.should_annotate, reason: screenResult.reason, confidence: screenResult.confidence, category: screenResult.category || 'none' }),
                            batchId,
                        ]
                    );

                    sendEvent('item_done', {
                        index: idx, videoPath, videoName,
                        should_annotate: screenResult.should_annotate,
                        reason: screenResult.reason,
                        confidence: screenResult.confidence,
                        category: screenResult.category || 'none',
                    });

                    if (screenResult.should_annotate) {
                        videoPrescreenBatchProgress.passed++;
                    } else {
                        videoPrescreenBatchProgress.rejected++;
                    }
                } catch (err) {
                    console.error(`[video-prescreen-batch] error processing ${videoPath}:`, err?.message);
                    sendEvent('item_done', {
                        index: idx, videoPath, videoName,
                        should_annotate: true,
                        reason: `Error: ${err?.message || 'Unknown'}`,
                        confidence: 'low',
                        category: 'none',
                        error: true,
                    });
                    videoPrescreenBatchProgress.errors++;
                }
            }));

            videoPrescreenBatchProgress.processed = Math.min(i + concurrency, toProcess.length);
            pool.query(`UPDATE prescreen_history SET progress_snapshot = $1 WHERE batch_id = $2`, [JSON.stringify(videoPrescreenBatchProgress), batchId]).catch(() => { });
        }

        if (videoPrescreenBatchAborted) {
            await pool.query(
                `UPDATE prescreen_history SET status = 'interrupted', progress_snapshot = $1 WHERE batch_id = $2`,
                [JSON.stringify(videoPrescreenBatchProgress), batchId]
            ).catch(() => { });
        } else {
            await pool.query(
                `UPDATE prescreen_history SET completed_at = NOW(), count_passed = $1, count_rejected = $2, count_error = $3, status = 'completed', progress_snapshot = $4 WHERE batch_id = $5`,
                [videoPrescreenBatchProgress.passed, videoPrescreenBatchProgress.rejected, videoPrescreenBatchProgress.errors, JSON.stringify(videoPrescreenBatchProgress), batchId]
            ).catch(() => { });
            sendEvent('done', { progress: videoPrescreenBatchProgress, batch_id: batchId });
        }
    } catch (err) {
        console.error('[video-prescreen-batch] fatal error:', err?.message);
        sendEvent('error', { message: err?.message || 'Unknown error' });
    } finally {
        videoPrescreenBatchRunning = false;
        res.end();
    }
});

app.post('/api/video/prescreen/override', express.json(), async (req, res) => {
    const { path: videoPath, should_annotate, category, error_category, feedback_description } = req.body || {};
    if (!videoPath || typeof should_annotate !== 'boolean') {
        return sendJson(res, 400, { error: 'invalid_params' });
    }
    try {
        const newStatus = should_annotate ? 'passed' : 'rejected';
        const existing = await pool.query(
            `SELECT description FROM saved_frames WHERE video_path = $1 AND format = 'video_prescreen' LIMIT 1`,
            [videoPath]
        );
        if (existing.rows.length === 0) {
            return sendJson(res, 404, { error: 'not_found' });
        }
        let desc = {};
        try { desc = JSON.parse(existing.rows[0].description || '{}'); } catch { }
        desc.should_annotate = should_annotate;
        desc.overridden = true;
        if (category) desc.category = category;
        else if (!desc.category) desc.category = should_annotate ? 'body_nsfw' : 'none';

        await pool.query(
            `UPDATE saved_frames SET status = $1, description = $2 WHERE video_path = $3 AND format = 'video_prescreen'`,
            [newStatus, JSON.stringify(desc), videoPath]
        );
        // Persist structured feedback when supplied. The feedback table
        // column is named image_path for legacy reasons but stores any
        // asset path; rules currently only feed the image prescreen prompt.
        if (error_category) {
            const correctedStatus = should_annotate ? 'passed' : 'rejected';
            const originalStatus = should_annotate ? 'rejected' : 'passed';
            await pool.query(
                `INSERT INTO prescreen_feedback (image_path, original_status, corrected_status, error_category, description)
                 VALUES ($1, $2, $3, $4, $5)`,
                [videoPath, originalStatus, correctedStatus, error_category, feedback_description || '']
            );
        }
        sendJson(res, 200, { ok: true });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Prescreen history & reset ------------------------------------------
// Surface recent prescreen runs (image + video) so the UI can show a summary
// of the last batch and offer rollback. The optional ?type filter narrows the
// result set; otherwise both types are returned, newest first.
app.get('/api/prescreen/history', async (req, res) => {
    setCors(res);
    const { type, subtype } = req.query || {};
    try {
        let query, params;
        if (type === 'image' || type === 'video') {
            if (subtype === 'pipeline') {
                query = `SELECT * FROM prescreen_history WHERE type = $1 AND batch_config IS NOT NULL AND batch_config::text LIKE '%"annotateStrategy"%' ORDER BY started_at DESC LIMIT 50`;
                params = [type];
            } else if (subtype === 'prescreen') {
                query = `SELECT * FROM prescreen_history WHERE type = $1 AND (batch_config IS NULL OR batch_config::text NOT LIKE '%"annotateStrategy"%') ORDER BY started_at DESC LIMIT 50`;
                params = [type];
            } else {
                query = `SELECT * FROM prescreen_history WHERE type = $1 ORDER BY started_at DESC LIMIT 50`;
                params = [type];
            }
        } else {
            query = `SELECT * FROM prescreen_history ORDER BY started_at DESC LIMIT 50`;
            params = [];
        }
        const result = await pool.query(query, params);
        sendJson(res, 200, { history: result.rows });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

// Reset prescreen results. Two modes:
//   - 'last': remove only the most recent batch (per affected type).
//   - 'all':  wipe every prescreen row of the affected type(s).
// 'type' narrows the scope to image, video, or both (default).
app.post('/api/prescreen/reset', express.json(), async (req, res) => {
    setCors(res);
    const { mode, type } = req.body || {};

    if (!['last', 'all'].includes(mode)) {
        return sendJson(res, 400, { error: 'mode must be "last" or "all"' });
    }
    const targetType = type || 'both';
    if (!['image', 'video', 'both'].includes(targetType)) {
        return sendJson(res, 400, { error: 'type must be "image", "video" or "both"' });
    }

    try {
        let deletedCount = 0;
        const formats = [];
        if (targetType === 'image' || targetType === 'both') formats.push('image_prescreen');
        if (targetType === 'video' || targetType === 'both') formats.push('video_prescreen');

        if (mode === 'all') {
            const result = await pool.query(
                `DELETE FROM saved_frames WHERE format = ANY($1)`,
                [formats]
            );
            deletedCount = result.rowCount;
            const historyTypes = [];
            if (targetType === 'image' || targetType === 'both') historyTypes.push('image');
            if (targetType === 'video' || targetType === 'both') historyTypes.push('video');
            await pool.query(`DELETE FROM prescreen_history WHERE type = ANY($1)`, [historyTypes]);
        } else {
            // mode === 'last': for each affected type, find the most recent
            // batch and delete only its rows. Legacy rows without batch_id are
            // preserved here — only "all" mode wipes them.
            for (const fmt of formats) {
                const histType = fmt === 'image_prescreen' ? 'image' : 'video';
                const lastBatch = await pool.query(
                    `SELECT batch_id FROM prescreen_history WHERE type = $1 ORDER BY started_at DESC LIMIT 1`,
                    [histType]
                );
                if (lastBatch.rows.length > 0) {
                    const batchId = lastBatch.rows[0].batch_id;
                    const del = await pool.query(
                        `DELETE FROM saved_frames WHERE batch_id = $1 AND format = $2`,
                        [batchId, fmt]
                    );
                    deletedCount += del.rowCount;
                    await pool.query(`DELETE FROM prescreen_history WHERE batch_id = $1`, [batchId]);
                }
            }
        }

        queryCache.invalidate('images_prescreened');
        sendJson(res, 200, { ok: true, deletedCount });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Image Pipeline (Pre-screen + Annotation Streaming) -----------------
app.get('/api/image/pipeline/batch/status', async (req, res) => {
    setCors(res);
    if (pipelineBatchRunning) {
        return sendJson(res, 200, { running: true, progress: pipelineBatchProgress });
    }
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'image' AND status = 'interrupted' AND completed_at IS NULL
             AND batch_config IS NOT NULL AND batch_config::text LIKE '%annotateStrategy%'
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length > 0) {
            const row = interrupted.rows[0];
            return sendJson(res, 200, {
                running: false, progress: null,
                interrupted: { batch_id: row.batch_id, config: row.batch_config, progress: row.progress_snapshot }
            });
        }
    } catch { }
    sendJson(res, 200, { running: false, progress: null });
});

app.post('/api/image/pipeline/batch/resume', async (req, res) => {
    setCors(res);
    try {
        const interrupted = await pool.query(
            `SELECT batch_id, batch_config, progress_snapshot FROM prescreen_history
             WHERE type = 'image' AND status = 'interrupted' AND completed_at IS NULL
             AND batch_config IS NOT NULL AND batch_config::text LIKE '%annotateStrategy%'
             ORDER BY started_at DESC LIMIT 1`
        );
        if (interrupted.rows.length === 0) {
            return sendJson(res, 404, { error: '没有可恢复的中断任务' });
        }
        const row = interrupted.rows[0];
        await pool.query(`UPDATE prescreen_history SET status = 'resumed' WHERE batch_id = $1`, [row.batch_id]);
        const config = row.batch_config || { count: 'all', concurrency: 3 };
        const progress = row.progress_snapshot || {};
        const processed = progress.processed || 0;
        const remaining = config.count === 'all' ? 'all' : Math.max(0, (config.count || 0) - processed);
        sendJson(res, 200, { ok: true, config: { ...config, count: remaining || 'all' } });
    } catch (err) {
        sendJson(res, 500, { error: '恢复任务失败：' + (err?.message || '未知错误') });
    }
});

app.post('/api/image/pipeline/batch/stop', (req, res) => {
    setCors(res);
    if (!pipelineBatchRunning) return sendJson(res, 200, { ok: true, message: 'not_running' });
    pipelineBatchAborted = true;
    sendJson(res, 200, { ok: true, message: 'stopping' });
});

app.post('/api/image/pipeline/batch', express.json(), async (req, res) => {
    if (pipelineBatchRunning) {
        return sendJson(res, 409, { error: 'pipeline_running', message: 'A pipeline batch is already in progress', progress: pipelineBatchProgress });
    }
    if (imageBatchRunning) {
        return sendJson(res, 409, { error: 'batch_running', message: 'An image annotation batch is already in progress' });
    }
    if (prescreenBatchRunning) {
        return sendJson(res, 409, { error: 'prescreen_running', message: 'A prescreen batch is already in progress' });
    }

    const { count, folder, concurrency: rawConcurrency, voters, arbiter, prescreenStrategy: rawPsStrategy, prescreenModels: rawPsModels, prescreenArbiter: rawPsArbiter, annotateStrategy: rawAnStrategy, annotateModels: rawAnModels, annotateArbiter: rawAnArbiter } = req.body || {};
    if (count !== 'all' && count !== undefined && (!Number.isInteger(count) || count < 1)) {
        return sendJson(res, 400, { error: 'invalid_count', message: 'count must be a positive integer or "all"' });
    }
    const concurrency = Math.min(Math.max(parseInt(rawConcurrency) || 3, 1), 20);
    // Multi-model strategy params (backward compatible)
    const prescreenStrategy = rawPsStrategy || ((voters && Array.isArray(voters) && voters.length > 0) ? 'vote' : 'single');
    const prescreenModels = rawPsModels || voters || [];
    const prescreenArbiter = rawPsArbiter || arbiter || 'deepseek';
    const annotateStrategy = rawAnStrategy || 'single';
    const annotateModels = rawAnModels || [];
    const annotateArbiter = rawAnArbiter || 'deepseek';

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    function sendEvent(type, data) {
        try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch (e) { /* ignore */ }
    }

    pipelineBatchRunning = true;
    pipelineBatchAborted = false;

    try {
        if (!imageCache) await performImageScan();
        if (!imageCache || !imageCache.items) {
            sendEvent('error', { message: 'Image cache not available' });
            pipelineBatchRunning = false;
            return res.end();
        }

        // Filter: not annotated, not skipped, not already prescreened
        const annotatedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_annotation'`
        );
        const annotatedSet = new Set(annotatedRes.rows.map(r => r.video_path));

        const skippedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_skip'`
        );
        const skippedSet = new Set(skippedRes.rows.map(r => r.video_path));

        const prescreenedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_prescreen'`
        );
        const prescreenedSet = new Set(prescreenedRes.rows.map(r => r.video_path));

        // Few-shot: recent human skip examples for AI annotation skip judgment
        const humanSkipsRes = await pool.query(
            `SELECT video_path FROM saved_frames WHERE format = 'image_skip' AND (description = 'Manual skip' OR description = 'Manual reject') ORDER BY created_at DESC LIMIT 20`
        );
        const humanSkipExamples = humanSkipsRes.rows.map(r => path.basename(r.video_path));

        let allImages = [...imageCache.items.values()].filter(
            img => !annotatedSet.has(img.path) && !skippedSet.has(img.path) && !prescreenedSet.has(img.path)
        );

        if (folder && folder !== '__ALL__') {
            allImages = allImages.filter(img => img.folder === folder || img.folder.startsWith(folder + '/'));
        }

        allImages.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

        const limit = (count === 'all' || count === undefined) ? allImages.length : Math.min(count, allImages.length);
        const toProcess = allImages.slice(0, limit);

        if (toProcess.length === 0) {
            sendEvent('done', { message: 'No images to process', progress: { total: 0, processed: 0, prescreenPassed: 0, annotated: 0, skipped: 0, errors: 0 } });
            pipelineBatchRunning = false;
            return res.end();
        }

        // Aggregate prescreen feedback rules
        let feedbackRules = '';
        try {
            const feedbackRes = await pool.query(
                `SELECT error_category, description FROM prescreen_feedback
                 WHERE created_at > NOW() - INTERVAL '30 days'
                 ORDER BY created_at DESC LIMIT 50`
            );
            feedbackRules = generateFeedbackRules(feedbackRes.rows);
        } catch (e) { /* ignore */ }

        const batchId = randomUUID();
        const pipelineConfig = { count, folder, concurrency, prescreenStrategy, prescreenModels, prescreenArbiter, annotateStrategy, annotateModels, annotateArbiter };
        await pool.query(
            `INSERT INTO prescreen_history (batch_id, type, started_at, batch_config, status) VALUES ($1, 'image', NOW(), $2, 'running')`,
            [batchId, JSON.stringify(pipelineConfig)]
        );

        pipelineBatchProgress = { total: toProcess.length, processed: 0, prescreenPassed: 0, prescreenRejected: 0, annotated: 0, skipped: 0, errors: 0 };
        sendEvent('start', { total: toProcess.length, batch_id: batchId });

        const prescreenBalancer = prescreenStrategy === 'loadbalance' ? createLoadBalancer(prescreenModels) : null;
        const annotateBalancer = annotateStrategy === 'loadbalance' ? createLoadBalancer(annotateModels) : null;

        for (let i = 0; i < toProcess.length; i += concurrency) {
            if (pipelineBatchAborted) {
                sendEvent('aborted', { progress: pipelineBatchProgress });
                break;
            }

            const batch = toProcess.slice(i, Math.min(i + concurrency, toProcess.length));

            await Promise.allSettled(batch.map(async (img, bIdx) => {
                const idx = i + bIdx;
                const imagePath = img.path;
                const imageName = img.name;

                sendEvent('item_start', { index: idx, imagePath, imageName });

                try {
                    const abs = path.join(IMAGES_ROOT, imagePath);
                    const buffer = await fsp.readFile(abs);
                    const imageBase64 = buffer.toString('base64');
                    const ext = img.ext || 'jpeg';
                    const format = ext === 'jpg' ? 'jpeg' : ext;

                    // 1) Pre-screen based on strategy
                    let screenResult;
                    let prescreenModelUsed;
                    if (prescreenStrategy === 'vote') {
                        screenResult = await preScreenImageMultiVote(imageBase64, format, prescreenModels, prescreenArbiter, feedbackRules);
                    } else if (prescreenStrategy === 'loadbalance') {
                        prescreenModelUsed = prescreenBalancer.next();
                        screenResult = await preScreenImage(imageBase64, format, prescreenModelUsed, feedbackRules);
                    } else {
                        screenResult = await preScreenImage(imageBase64, format, undefined, feedbackRules);
                    }

                    // Save prescreen result regardless of pass/reject
                    await pool.query(
                        `DELETE FROM saved_frames WHERE video_path = $1 AND format = 'image_prescreen'`,
                        [imagePath]
                    );
                    await pool.query(
                        `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, model_id, batch_id, created_at)
                         VALUES ($1, $2, -1, '', '', $3, 'image_prescreen', $4, $5, $6, NOW())`,
                        [
                            imagePath, imageName,
                            screenResult.should_annotate ? 'passed' : 'rejected',
                            JSON.stringify({ should_annotate: screenResult.should_annotate, reason: screenResult.reason, confidence: screenResult.confidence, category: screenResult.category || 'none', ...(screenResult.voters ? { voters: screenResult.voters } : {}), ...(prescreenModelUsed ? { model_used: prescreenModelUsed } : {}) }),
                            prescreenModelUsed || null,
                            batchId,
                        ]
                    );
                    queryCache.invalidate('images_prescreened');

                    sendEvent('prescreen_done', {
                        index: idx, imagePath, imageName,
                        should_annotate: screenResult.should_annotate,
                        reason: screenResult.reason,
                        confidence: screenResult.confidence,
                        category: screenResult.category || 'none',
                        ...(prescreenModelUsed ? { model_used: prescreenModelUsed } : {}),
                    });

                    if (screenResult.should_annotate) {
                        pipelineBatchProgress.prescreenPassed++;
                    } else {
                        pipelineBatchProgress.prescreenRejected++;
                    }

                    // 2) If rejected → just send skip event and stop
                    if (!screenResult.should_annotate) {
                        sendEvent('annotate_done', { index: idx, imagePath, imageName, result: 'skipped', reason: '[预筛选] ' + (screenResult.reason || '') });
                        pipelineBatchProgress.skipped++;
                        return;
                    }

                    // 3) If passed → run annotation based on annotateStrategy
                    let aiResult;
                    let annotateModelUsed;
                    if (annotateStrategy === 'vote') {
                        aiResult = await generateDescriptionMultiVote(imageBase64, format, annotateModels, annotateArbiter, { humanSkipExamples });
                    } else if (annotateStrategy === 'loadbalance') {
                        annotateModelUsed = annotateBalancer.next();
                        aiResult = await generateDescription(imageBase64, format, annotateModelUsed, false, humanSkipExamples);
                    } else {
                        aiResult = await generateDescription(imageBase64, format, undefined, false, humanSkipExamples);
                    }

                    if (aiResult?.skip === true) {
                        await pool.query(
                            `DELETE FROM saved_frames WHERE video_path = $1 AND format IN ('image_annotation', 'image_skip')`,
                            [imagePath]
                        );
                        await pool.query(
                            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, created_at)
                             VALUES ($1, $2, -1, '', '', 'skipped', 'image_skip', $3, NOW())`,
                            [imagePath, imageName, '[AI] ' + (aiResult.skip_reason || 'AI auto-skip')]
                        );
                        queryCache.invalidate('images_skipped');
                        queryCache.invalidate('images_annotated');
                        sendEvent('annotate_done', { index: idx, imagePath, imageName, result: 'skipped', reason: aiResult.skip_reason });
                        pipelineBatchProgress.skipped++;
                        return;
                    }

                    // Flatten dimensions to tags
                    const imgFlatTags = [];
                    if (aiResult?.dimensions && typeof aiResult.dimensions === 'object') {
                        for (const dimTags of Object.values(aiResult.dimensions)) {
                            if (Array.isArray(dimTags)) {
                                imgFlatTags.push(...dimTags.map(t => typeof t === 'string' ? t.replace(/^\[NEW\]\s*/, '') : t));
                            }
                        }
                    }

                    await pool.query(
                        `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, dimensions, style, description, format, model_id, created_at)
                         VALUES ($1, $2, -1, '', '', $3, $4, $5, $6, $7, $8, $9, 'image_annotation', $10, NOW())`,
                        [
                            imagePath, imageName,
                            aiResult?.prompt || null,
                            aiResult?.pose || null,
                            aiResult?.pose_en || null,
                            JSON.stringify(imgFlatTags),
                            JSON.stringify(mergeBasicAttrsIntoDimensions(aiResult)),
                            aiResult?.style || null,
                            aiResult?.description || null,
                            annotateModelUsed || null,
                        ]
                    );
                    queryCache.invalidate('images_annotated');

                    sendEvent('annotate_done', { index: idx, imagePath, imageName, result: 'annotated', ...(annotateModelUsed ? { model_used: annotateModelUsed } : {}), ...(aiResult?.voters ? { voters: aiResult.voters } : {}) });
                    pipelineBatchProgress.annotated++;
                } catch (err) {
                    console.error(`[pipeline-batch] error processing ${imagePath}:`, err?.message);
                    sendEvent('annotate_done', { index: idx, imagePath, imageName, result: 'error', reason: err?.message || 'Unknown error' });
                    pipelineBatchProgress.errors++;
                }
            }));

            pipelineBatchProgress.processed = Math.min(i + concurrency, toProcess.length);
            pool.query(`UPDATE prescreen_history SET progress_snapshot = $1 WHERE batch_id = $2`, [JSON.stringify(pipelineBatchProgress), batchId]).catch(() => { });
        }

        try {
            if (pipelineBatchAborted) {
                await pool.query(
                    `UPDATE prescreen_history SET status = 'interrupted', progress_snapshot = $1 WHERE batch_id = $2`,
                    [JSON.stringify(pipelineBatchProgress), batchId]
                );
            } else {
                await pool.query(
                    `UPDATE prescreen_history SET completed_at = NOW(), count_passed = $1, count_rejected = $2, count_error = $3, status = 'completed', progress_snapshot = $4 WHERE batch_id = $5`,
                    [pipelineBatchProgress.prescreenPassed, pipelineBatchProgress.prescreenRejected, pipelineBatchProgress.errors, JSON.stringify(pipelineBatchProgress), batchId]
                );
                sendEvent('done', { progress: pipelineBatchProgress, batch_id: batchId });
            }
        } catch (e) { /* ignore */ }

    } catch (err) {
        console.error('[pipeline-batch] fatal error:', err?.message);
        sendEvent('error', { message: err?.message || 'Unknown error' });
    } finally {
        pipelineBatchRunning = false;
        res.end();
    }
});

app.post('/api/image/analyze/batch', express.json(), async (req, res) => {
    if (imageBatchRunning) {
        return sendJson(res, 409, { error: 'batch_running', message: 'An image batch analysis is already in progress', progress: imageBatchProgress });
    }

    const { count, folder, source, concurrency: rawConcurrency, annotateStrategy: rawAnStrategy, annotateModels: rawAnModels, annotateArbiter: rawAnArbiter } = req.body || {};
    const concurrency = Math.min(Math.max(parseInt(rawConcurrency) || 1, 1), 20);
    if (count !== 'all' && (!Number.isInteger(count) || count < 1)) {
        return sendJson(res, 400, { error: 'invalid_count', message: 'count must be a positive integer or "all"' });
    }
    // Annotate strategy params (backward compatible)
    const annotateStrategy = rawAnStrategy || 'single';
    const annotateModels = rawAnModels || [];
    const annotateArbiter = rawAnArbiter || 'deepseek';

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    function sendEvent(type, data) {
        try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch (e) { /* ignore */ }
    }

    imageBatchRunning = true;
    imageBatchAborted = false;

    try {
        if (!imageCache) await performImageScan();
        if (!imageCache || !imageCache.items) {
            sendEvent('error', { message: 'Image cache not available' });
            imageBatchRunning = false;
            return res.end();
        }

        // Get already-annotated image paths
        const annotatedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_annotation'`
        );
        const annotatedSet = new Set(annotatedRes.rows.map(r => r.video_path));

        // Get already-skipped image paths
        const skippedRes = await pool.query(
            `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_skip'`
        );
        const skippedSet = new Set(skippedRes.rows.map(r => r.video_path));

        // Query recent human skip examples for AI few-shot learning
        const humanSkipsRes = await pool.query(
            `SELECT video_path FROM saved_frames WHERE format = 'image_skip' AND (description = 'Manual skip' OR description = 'Manual reject') ORDER BY created_at DESC LIMIT 20`
        );
        const humanSkipExamples = humanSkipsRes.rows.map(r => path.basename(r.video_path));

        // Filter unannotated and un-skipped images
        let allImages = [...imageCache.items.values()].filter(img => !annotatedSet.has(img.path) && !skippedSet.has(img.path));

        // If source is prescreened (default), only keep images that passed prescreen
        if (source !== 'all') {
            const prescreenPassedRes = await pool.query(
                `SELECT DISTINCT video_path FROM saved_frames WHERE format = 'image_prescreen' AND status = 'passed'`
            );
            const prescreenPassedSet = new Set(prescreenPassedRes.rows.map(r => r.video_path));
            allImages = allImages.filter(img => prescreenPassedSet.has(img.path));
        }

        // Optional folder filter
        if (folder && folder !== '__ALL__') {
            allImages = allImages.filter(img => img.folder === folder || img.folder.startsWith(folder + '/'));
        }

        allImages.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

        const limit = count === 'all' ? allImages.length : Math.min(count, allImages.length);
        const toProcess = allImages.slice(0, limit);

        if (toProcess.length === 0) {
            sendEvent('done', { message: 'No unannotated images to process', total: 0 });
            imageBatchRunning = false;
            return res.end();
        }

        imageBatchProgress = { total: toProcess.length, processed: 0, annotated: 0, skipped: 0, errors: 0 };
        const imageBatchId = randomUUID();
        const imageBatchConfig = { count, folder, source, concurrency, annotateStrategy, annotateModels, annotateArbiter };
        await pool.query(
            `INSERT INTO prescreen_history (batch_id, type, started_at, batch_config, status) VALUES ($1, 'image_annotation', NOW(), $2, 'running')`,
            [imageBatchId, JSON.stringify(imageBatchConfig)]
        );
        sendEvent('start', { total: toProcess.length, batch_id: imageBatchId });

        const annotateBalancer = annotateStrategy === 'loadbalance' ? createLoadBalancer(annotateModels) : null;

        for (let i = 0; i < toProcess.length; i += concurrency) {
            if (imageBatchAborted) {
                sendEvent('aborted', { message: 'Batch aborted by client', progress: imageBatchProgress });
                break;
            }

            const batch = toProcess.slice(i, Math.min(i + concurrency, toProcess.length));

            await Promise.allSettled(batch.map(async (img, bIdx) => {
                const globalIdx = i + bIdx;
                const imagePath = img.path;
                const imageName = img.name;

                sendEvent('item_start', { index: globalIdx, imagePath, imageName });

                try {
                    const abs = path.join(IMAGES_ROOT, imagePath);
                    const buffer = await fsp.readFile(abs);
                    const imageBase64 = buffer.toString('base64');
                    const ext = img.ext || 'jpeg';
                    const format = ext === 'jpg' ? 'jpeg' : ext;

                    // --- Pre-screen check ---
                    let prescreenPassed = true;
                    let prescreenReason = '';

                    const existingPrescreen = await pool.query(
                        `SELECT description FROM saved_frames WHERE video_path = $1 AND format = 'image_prescreen' LIMIT 1`,
                        [imagePath]
                    );

                    if (existingPrescreen.rows.length > 0) {
                        try {
                            const ps = JSON.parse(existingPrescreen.rows[0].description);
                            prescreenPassed = ps.should_annotate !== false;
                            prescreenReason = ps.reason || '';
                        } catch { }
                    } else {
                        try {
                            const screenResult = await preScreenImage(imageBase64, format);
                            prescreenPassed = screenResult.should_annotate;
                            prescreenReason = screenResult.reason;
                            await pool.query(
                                `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, created_at)
                                 VALUES ($1, $2, -1, '', '', $3, 'image_prescreen', $4, NOW())`,
                                [imagePath, imageName, screenResult.should_annotate ? 'passed' : 'rejected',
                                    JSON.stringify({ should_annotate: screenResult.should_annotate, reason: screenResult.reason, confidence: screenResult.confidence })]
                            );
                        } catch (psErr) {
                            console.warn(`[image-batch] prescreen failed for ${imagePath}, proceeding with annotation:`, psErr?.message);
                        }
                    }

                    if (!prescreenPassed) {
                        await pool.query(
                            `DELETE FROM saved_frames WHERE video_path = $1 AND format IN ('image_annotation', 'image_skip')`,
                            [imagePath]
                        );
                        await pool.query(
                            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, created_at)
                             VALUES ($1, $2, -1, '', '', 'skipped', 'image_skip', $3, NOW())`,
                            [imagePath, imageName, '[PreScreen] ' + prescreenReason]
                        );
                        sendEvent('item_done', { index: globalIdx, imagePath, imageName, result: 'skipped', reason: '[预筛选] ' + prescreenReason, pre_screened: true });
                        imageBatchProgress.skipped++;
                        queryCache.invalidate('images_skipped');
                        queryCache.invalidate('images_annotated');
                        return;
                    }
                    // --- End pre-screen check ---

                    let aiResult;
                    let annotateModelUsed;
                    if (annotateStrategy === 'vote') {
                        aiResult = await generateDescriptionMultiVote(imageBase64, format, annotateModels, annotateArbiter, { humanSkipExamples });
                    } else if (annotateStrategy === 'loadbalance') {
                        annotateModelUsed = annotateBalancer.next();
                        aiResult = await generateDescription(imageBase64, format, annotateModelUsed, false, humanSkipExamples);
                    } else {
                        aiResult = await generateDescription(imageBase64, format, undefined, false, humanSkipExamples);
                    }

                    if (aiResult?.skip === true) {
                        await pool.query(
                            `DELETE FROM saved_frames WHERE video_path = $1 AND format IN ('image_annotation', 'image_skip')`,
                            [imagePath]
                        );
                        await pool.query(
                            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, created_at)
                             VALUES ($1, $2, -1, '', '', 'skipped', 'image_skip', $3, NOW())`,
                            [imagePath, imageName, '[AI] ' + (aiResult.skip_reason || 'AI auto-skip')]
                        );
                        sendEvent('item_done', { index: globalIdx, imagePath, imageName, result: 'skipped', reason: aiResult.skip_reason });
                        imageBatchProgress.skipped++;
                        queryCache.invalidate('images_skipped');
                        queryCache.invalidate('images_annotated');
                        return;
                    }

                    // Flatten dimensions to tags
                    const imgFlatTags = [];
                    if (aiResult?.dimensions && typeof aiResult.dimensions === 'object') {
                        for (const dimTags of Object.values(aiResult.dimensions)) {
                            if (Array.isArray(dimTags)) {
                                imgFlatTags.push(...dimTags.map(t => typeof t === 'string' ? t.replace(/^\[NEW\]\s*/, '') : t));
                            }
                        }
                    }

                    await pool.query(
                        `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, dimensions, style, description, format, model_id, created_at)
                         VALUES ($1, $2, -1, '', '', $3, $4, $5, $6, $7, $8, $9, 'image_annotation', $10, NOW())`,
                        [
                            imagePath, imageName,
                            aiResult?.prompt || null,
                            aiResult?.pose || null,
                            aiResult?.pose_en || null,
                            JSON.stringify(imgFlatTags),
                            JSON.stringify(mergeBasicAttrsIntoDimensions(aiResult)),
                            aiResult?.style || null,
                            aiResult?.description || null,
                            annotateModelUsed || null,
                        ]
                    );

                    sendEvent('item_done', { index: globalIdx, imagePath, imageName, result: 'annotated', ...(annotateModelUsed ? { model_used: annotateModelUsed } : {}), ...(aiResult?.voters ? { voters: aiResult.voters } : {}) });
                    imageBatchProgress.annotated++;
                    queryCache.invalidate('images_annotated');
                } catch (err) {
                    console.error(`[image-batch] error processing ${imagePath}:`, err?.message);
                    sendEvent('item_done', { index: globalIdx, imagePath, imageName, result: 'error', reason: err?.message || 'Unknown error' });
                    imageBatchProgress.errors++;
                }
            }));

            imageBatchProgress.processed = Math.min(i + concurrency, toProcess.length);
            pool.query(`UPDATE prescreen_history SET progress_snapshot = $1 WHERE batch_id = $2`, [JSON.stringify(imageBatchProgress), imageBatchId]).catch(() => { });
        }

        if (imageBatchAborted) {
            await pool.query(
                `UPDATE prescreen_history SET status = 'interrupted', progress_snapshot = $1 WHERE batch_id = $2`,
                [JSON.stringify(imageBatchProgress), imageBatchId]
            ).catch(() => { });
        } else {
            await pool.query(
                `UPDATE prescreen_history SET completed_at = NOW(), count_passed = $1, count_rejected = $2, count_error = $3, status = 'completed', progress_snapshot = $4 WHERE batch_id = $5`,
                [imageBatchProgress.annotated, imageBatchProgress.skipped, imageBatchProgress.errors, JSON.stringify(imageBatchProgress), imageBatchId]
            ).catch(() => { });
            sendEvent('done', { progress: imageBatchProgress, batch_id: imageBatchId });
        }
    } catch (err) {
        console.error('[image-batch] fatal error:', err?.message);
        sendEvent('error', { message: err?.message || 'Unknown error' });
    } finally {
        imageBatchRunning = false;
        res.end();
    }
});

// -------- Single Image AI Analysis ------------------------------------------
app.post('/api/image/analyze/single', express.json(), async (req, res) => {
    setCors(res);
    const { path: imagePath, model: modelOverride, thinking: enableThinking } = req.body || {};
    if (!imagePath) return sendJson(res, 400, { error: 'path required' });

    try {
        const abs = path.join(IMAGES_ROOT, imagePath);
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat) return sendJson(res, 404, { error: 'Image file not found' });

        const buffer = await fsp.readFile(abs);
        const imageBase64 = buffer.toString('base64');
        const ext = path.extname(imagePath).replace('.', '').toLowerCase() || 'jpeg';
        const format = ext === 'jpg' ? 'jpeg' : ext;

        // Query recent human skip examples for AI few-shot learning
        const humanSkipsRes2 = await pool.query(
            `SELECT video_path FROM saved_frames WHERE format = 'image_skip' AND (description = 'Manual skip' OR description = 'Manual reject') ORDER BY created_at DESC LIMIT 20`
        );
        const humanSkipExamples2 = humanSkipsRes2.rows.map(r => path.basename(r.video_path));

        // Branch on material classification: "normal" assets get a reverse-prompt
        // pass; the legacy "spicy" flow keeps the 14-dimension annotator.
        const materialType = inferMaterialType(imagePath);
        const aiResult = materialType === 'normal'
            ? await generateReversePrompt(imageBase64, format, modelOverride || undefined, !!enableThinking)
            : await generateDescription(imageBase64, format, modelOverride || undefined, !!enableThinking, humanSkipExamples2);

        // Handle AI skip response for single image
        if (aiResult?.skip === true) {
            await pool.query(
                `DELETE FROM saved_frames WHERE video_path = $1 AND format IN ('image_annotation', 'image_skip')`,
                [imagePath]
            );
            await pool.query(
                `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, status, format, description, created_at)
                 VALUES ($1, $2, -1, '', '', 'skipped', 'image_skip', $3, NOW())`,
                [imagePath, path.basename(imagePath), '[AI] ' + (aiResult.skip_reason || 'AI auto-skip')]
            );
            queryCache.invalidate('images_skipped');
            queryCache.invalidate('images_annotated');
            return res.json({
                success: true,
                skipped: true,
                skip_reason: '[AI] ' + (aiResult.skip_reason || 'AI auto-skip'),
                data: { path: imagePath, name: path.basename(imagePath) }
            });
        }

        // Flatten dimensions to tags
        const imgFlatTags = [];
        if (aiResult?.dimensions && typeof aiResult.dimensions === 'object') {
            for (const dimTags of Object.values(aiResult.dimensions)) {
                if (Array.isArray(dimTags)) {
                    imgFlatTags.push(...dimTags.map(t => typeof t === 'string' ? t.replace(/^\[NEW\]\s*/, '') : t));
                }
            }
        }

        // Delete any existing annotation for this image path
        await pool.query(
            `DELETE FROM saved_frames WHERE video_path = $1 AND format = 'image_annotation'`,
            [imagePath]
        );

        // Insert new annotation
        await pool.query(
            `INSERT INTO saved_frames (video_path, video_name, timestamp, oss_url, oss_key, prompt, pose, pose_en, tags, dimensions, style, description, format, model_id, material_type, created_at)
             VALUES ($1, $2, -1, '', '', $3, $4, $5, $6, $7, $8, $9, 'image_annotation', $10, $11, NOW())`,
            [
                imagePath, path.basename(imagePath),
                aiResult?.prompt || null,
                aiResult?.pose || null,
                aiResult?.pose_en || null,
                JSON.stringify(imgFlatTags),
                JSON.stringify(mergeBasicAttrsIntoDimensions(aiResult)),
                aiResult?.style || null,
                aiResult?.description || null,
                aiResult?.modelId || null,
                materialType,
            ]
        );
        queryCache.invalidate('images_annotated');

        res.json({
            success: true,
            data: {
                path: imagePath,
                name: path.basename(imagePath),
                prompt: aiResult?.prompt || null,
                description: aiResult?.description || null,
                dimensions: mergeBasicAttrsIntoDimensions(aiResult),
                tags: imgFlatTags,
                style: aiResult?.style || null,
                model_id: aiResult?.modelId || null,
                material_type: materialType,
            }
        });
    } catch (err) {
        console.error(`[image-single] error analyzing ${imagePath}:`, err?.message);
        res.status(500).json({ success: false, error: err?.message || 'Analysis failed' });
    }
});

// -------- AI Model config endpoint -------------------------------------------
app.get('/api/ai/model', (req, res) => {
    setCors(res);
    sendJson(res, 200, { model: process.env.AI_MODEL || 'kimi', modelName: getActiveModelName() });
});

app.post('/api/ai/model', express.json(), (req, res) => {
    setCors(res);
    const { model } = req.body || {};
    if (!model || !['kimi', 'qwen'].includes(model)) {
        return sendJson(res, 400, { error: 'Invalid model. Must be "kimi" or "qwen".' });
    }
    process.env.AI_MODEL = model;
    console.log(`[AI] Model switched to: ${model} (${getActiveModelName()})`);
    sendJson(res, 200, { success: true, model, modelName: getActiveModelName() });
});

// -------- Swapface: Search annotated images by 14-dimension tags ---------------
app.get('/api/swapface/search', async (req, res) => {
    setCors(res);
    const { dimension, tag, character_name, limit = 50, offset = 0, order } = req.query;

    try {
        let where = `WHERE format = 'image_annotation'`;
        const params = [];
        let pi = 1;

        if (dimension && tag) {
            where += ` AND dimensions->>$${pi} ILIKE $${pi + 1}`;
            params.push(dimension, `%${tag}%`);
            pi += 2;
        } else if (tag) {
            where += ` AND tags::text ILIKE $${pi}`;
            params.push(`%${tag}%`);
            pi += 1;
        }

        if (character_name) {
            where += ` AND video_name ILIKE $${pi}`;
            params.push(`%${character_name}%`);
            pi += 1;
        }

        const orderClause = order === 'random' ? 'ORDER BY random()' : 'ORDER BY created_at DESC';

        params.push(Number(limit), Number(offset));
        const query = `
            SELECT video_path, video_name, oss_url, prompt, tags, dimensions,
                   style, description, model_id, created_at,
                   video_prompt, i2v_prompt
            FROM saved_frames
            ${where}
            ${orderClause}
            LIMIT $${pi} OFFSET $${pi + 1}
        `;

        const result = await pool.query(query, params);

        const countResult = await pool.query(
            `SELECT count(*) FROM saved_frames ${where}`,
            params.slice(0, params.length - 2)
        );

        const rows = result.rows.map(r => {
            if (r.created_at) r.created_at = r.created_at.toISOString();
            r.image_url = `/api/images/serve?path=${encodeURIComponent(r.video_path)}`;
            return r;
        });

        sendJson(res, 200, {
            total: parseInt(countResult.rows[0]?.count || '0'),
            items: rows,
        });
    } catch (err) {
        console.error(`[swapface-search] error:`, err?.message);
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Swapface: Get all annotated stats ----------------------------------
app.get('/api/swapface/stats', async (req, res) => {
    setCors(res);
    try {
        const totalRes = await pool.query(
            `SELECT count(*) FROM saved_frames WHERE format = 'image_annotation'`
        );
        const charRes = await pool.query(
            `SELECT DISTINCT video_name FROM saved_frames WHERE format = 'image_annotation'`
        );
        const dimRes = await pool.query(
            `SELECT dimensions FROM saved_frames WHERE format = 'image_annotation' AND dimensions IS NOT NULL`
        );

        const tagCounts = {};
        for (const row of dimRes.rows) {
            const dims = row.dimensions;
            if (!dims || typeof dims !== 'object') continue;
            for (const [dim, tags] of Object.entries(dims)) {
                if (!Array.isArray(tags)) continue;
                for (const t of tags) {
                    const clean = typeof t === 'string' ? t.replace(/^\[NEW\]\s*/, '') : String(t);
                    tagCounts[clean] = (tagCounts[clean] || 0) + 1;
                }
            }
        }

        const topTags = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50)
            .map(([tag, count]) => ({ tag, count }));

        sendJson(res, 200, {
            total: parseInt(totalRes.rows[0]?.count || '0'),
            characters: charRes.rows.map(r => r.video_name),
            top_tags: topTags,
        });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Swapface: Tag cloud grouped by dimension --------------------------
app.get('/api/swapface/tag-cloud', async (req, res) => {
    setCors(res);
    try {
        const dimRes = await pool.query(
            `SELECT dimensions FROM saved_frames WHERE format = 'image_annotation' AND dimensions IS NOT NULL`
        );

        const dimTagCounts = {};
        for (const row of dimRes.rows) {
            const dims = row.dimensions;
            if (!dims || typeof dims !== 'object') continue;
            for (const [dim, tags] of Object.entries(dims)) {
                if (!Array.isArray(tags)) continue;
                if (!dimTagCounts[dim]) dimTagCounts[dim] = {};
                for (const t of tags) {
                    const clean = typeof t === 'string' ? t.replace(/^\[NEW\]\s*/, '') : String(t);
                    dimTagCounts[dim][clean] = (dimTagCounts[dim][clean] || 0) + 1;
                }
            }
        }

        const result = {};
        for (const [dim, tagMap] of Object.entries(dimTagCounts)) {
            result[dim] = Object.entries(tagMap)
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => b.count - a.count);
        }

        sendJson(res, 200, {
            total_images: dimRes.rows.length,
            dimensions: result,
        });
    } catch (err) {
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Swapface materials: prescreened face_nsfw images (body source) -----
// Returns random face_nsfw prescreened images, used by CM as faceswap body material.
app.get('/api/swapface/materials', async (req, res) => {
    setCors(res);
    const { limit = 10 } = req.query;
    try {
        const where = `WHERE p.format = 'image_prescreen'
            AND p.description ~ '^\\s*\\{'
            AND (p.description::jsonb->>'category') = 'face_nsfw'`;
        const query = `
            SELECT p.video_path, p.video_name, p.oss_url, 
                   COALESCE(a.prompt, p.prompt) as prompt,
                   p.tags, p.dimensions, p.description, p.created_at
            FROM saved_frames p
            LEFT JOIN saved_frames a ON a.video_path = p.video_path AND a.format = 'image_annotation'
            ${where}
            ORDER BY random()
            LIMIT $1
        `;
        const result = await pool.query(query, [Number(limit)]);
        const countResult = await pool.query(`SELECT count(*) FROM saved_frames p ${where}`);
        const rows = result.rows.map(r => {
            if (r.created_at) r.created_at = r.created_at.toISOString();
            r.image_url = `/api/images/serve?path=${encodeURIComponent(r.video_path)}`;
            return r;
        });
        sendJson(res, 200, {
            total: parseInt(countResult.rows[0]?.count || '0'),
            items: rows,
        });
    } catch (err) {
        console.error(`[swapface-materials] error:`, err?.message);
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Video prompts: records with a video_prompt and a first-frame image -
// Returns random records that have video_prompt + an image, used by CM as the
// source for batch video generation (video_prompt + first frame).
app.get('/api/swapface/video-prompts', async (req, res) => {
    setCors(res);
    const { limit = 10 } = req.query;
    try {
        const where = `WHERE video_prompt IS NOT NULL AND video_prompt <> ''
            AND oss_url IS NOT NULL AND oss_url <> ''`;
        const query = `
            SELECT video_path, video_name, oss_url, prompt, video_prompt, i2v_prompt,
                   tags, dimensions, created_at
            FROM saved_frames
            ${where}
            ORDER BY random()
            LIMIT $1
        `;
        const result = await pool.query(query, [Number(limit)]);
        const countResult = await pool.query(`SELECT count(*) FROM saved_frames ${where}`);
        const rows = result.rows.map(r => {
            if (r.created_at) r.created_at = r.created_at.toISOString();
            r.image_url = `/api/images/serve?path=${encodeURIComponent(r.video_path)}`;
            return r;
        });
        sendJson(res, 200, {
            total: parseInt(countResult.rows[0]?.count || '0'),
            items: rows,
        });
    } catch (err) {
        console.error(`[swapface-video-prompts] error:`, err?.message);
        sendJson(res, 500, { error: err?.message });
    }
});

// -------- Prompt conversion: image prompt -> video prompt --------------------

// GET /api/prompts/video-models — list available models for video prompt conversion
app.get('/api/prompts/video-models', (req, res) => {
    res.json(getVideoPromptModels());
});

// GET /api/prompts/convertible-frames — list frames that have image prompt but no video prompt
app.get('/api/prompts/convertible-frames', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM saved_frames WHERE prompt IS NOT NULL AND prompt != '' AND (video_prompt IS NULL OR video_prompt = '')`
        );
        const total = parseInt(countResult.rows[0].count);

        const totalAnnotatedResult = await pool.query(
            `SELECT COUNT(*) FROM saved_frames WHERE prompt IS NOT NULL AND prompt != ''`
        );
        const totalAnnotated = parseInt(totalAnnotatedResult.rows[0].count);

        const dataResult = await pool.query(
            `SELECT id, video_path, timestamp, prompt, video_prompt, video_prompt_model FROM saved_frames
             WHERE prompt IS NOT NULL AND prompt != '' AND (video_prompt IS NULL OR video_prompt = '')
             ORDER BY id DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        res.json({ frames: dataResult.rows, total, totalAnnotated });
    } catch (err) {
        console.error('[convertible-frames] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/prompts/convert-to-video — SSE stream: batch convert image prompts to video prompts
app.post('/api/prompts/convert-to-video', express.json(), async (req, res) => {
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let clientConnected = true;

    // Detect client disconnect — continue processing in background
    res.on('close', () => {
        clientConnected = false;
        console.log('[convert-to-video] Client disconnected, continuing processing in background...');
    });

    const sendSSE = (data) => {
        if (clientConnected) {
            try {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
                if (typeof res.flush === 'function') res.flush();
            } catch (e) {
                clientConnected = false;
            }
        }
    };

    try {
        const { frameIds, filter, modelIds, modelId } = req.body || {};
        // Immediately notify client that SSE connection is alive (before any DB query)
        sendSSE({ type: 'connected', message: 'SSE connection established' });
        console.log('[convert-to-video] Request body:', JSON.stringify({ frameIds: frameIds?.length, filter, modelIds, modelId }));
        // Backward compatible: prefer modelIds array, fallback to single modelId
        const selectedModels = Array.isArray(modelIds) && modelIds.length > 0
            ? modelIds
            : [modelId || 'qwen3.7-plus'];

        let frames;

        if (filter === 'missing_video_prompt') {
            const result = await pool.query(
                `SELECT id, prompt FROM saved_frames WHERE prompt IS NOT NULL AND prompt != '' AND (video_prompt IS NULL OR video_prompt = '') ORDER BY id`
            );
            frames = result.rows;
        } else if (Array.isArray(frameIds) && frameIds.length > 0) {
            const result = await pool.query(
                `SELECT id, prompt FROM saved_frames WHERE id = ANY($1) AND prompt IS NOT NULL AND prompt != ''`,
                [frameIds]
            );
            frames = result.rows;
        } else {
            sendSSE({ type: 'error', message: 'Must provide frameIds array or filter="missing_video_prompt"' });
            if (clientConnected) res.end();
            return;
        }

        if (frames.length === 0) {
            sendSSE({ type: 'done', success: 0, failed: 0 });
            if (clientConnected) res.end();
            return;
        }

        const total = frames.length;
        let successCount = 0;
        let failedCount = 0;
        let processed = 0;
        let lastSentProgress = 0; // Track last sent progress to ensure monotonic increase

        console.log(`[convert-to-video] Found ${total} frames to process`);
        // Send total to client so frontend knows the full scope
        sendSSE({ type: 'start', total });

        // Helper: atomically increment processed and send monotonic progress
        const reportProgress = () => {
            processed++;
            const current = Math.min(processed, total); // Never exceed total
            if (current > lastSentProgress) {
                lastSentProgress = current;
                sendSSE({ type: 'progress', current, total });
            }
        };

        // Round-robin assign frames to selected models
        const modelGroups = {}; // { modelId: [{frame, originalIndex}, ...] }
        frames.forEach((frame, idx) => {
            const assignedModel = selectedModels[idx % selectedModels.length];
            if (!modelGroups[assignedModel]) modelGroups[assignedModel] = [];
            modelGroups[assignedModel].push({ frame, originalIndex: idx });
        });

        // Process each model group in parallel
        await Promise.all(Object.entries(modelGroups).map(async ([groupModelId, groupItems]) => {
            const groupFrames = groupItems.map(g => g.frame);

            // Split into batches of 10
            const BATCH_SIZE = 10;
            const batches = [];
            for (let i = 0; i < groupFrames.length; i += BATCH_SIZE) {
                batches.push(groupFrames.slice(i, i + BATCH_SIZE));
            }

            // Process with concurrency limit of 2
            const CONCURRENCY = 2;
            for (let i = 0; i < batches.length; i += CONCURRENCY) {
                const concurrentBatches = batches.slice(i, i + CONCURRENCY);

                await Promise.all(concurrentBatches.map(async (batch) => {
                    const prompts = batch.map(f => f.prompt);
                    const { results: videoPrompts, modelId: usedModelId } = await convertImagePromptToVideo(prompts, groupModelId);

                    for (let j = 0; j < batch.length; j++) {
                        const frame = batch[j];
                        const videoPrompt = videoPrompts[j];

                        if (videoPrompt) {
                            try {
                                await pool.query(
                                    `UPDATE saved_frames SET video_prompt = $1, video_prompt_model = $2 WHERE id = $3`,
                                    [videoPrompt, usedModelId, frame.id]
                                );
                                successCount++;
                                sendSSE({ type: 'result', frameId: frame.id, video_prompt: videoPrompt, modelId: usedModelId });
                            } catch (dbErr) {
                                failedCount++;
                                console.error(`[convert-to-video] DB update failed for frame ${frame.id}:`, dbErr.message);
                            }
                        } else {
                            failedCount++;
                        }

                        reportProgress();
                    }
                }));
            }
        }));

        sendSSE({ type: 'done', success: successCount, failed: failedCount });
        console.log(`[convert-to-video] Completed: ${successCount} success, ${failedCount} failed out of ${total} total`);
    } catch (err) {
        console.error('[convert-to-video] Error:', err.message);
        sendSSE({ type: 'error', message: err.message });
    }

    // Always end the response to prevent connection leaks (even after client disconnect)
    try { res.end(); } catch (e) { /* socket already closed */ }
});

app.use((req, res) => {
    sendJson(res, 404, { error: "not_found" });
});

// Export for use by other modules
export { pool, ossClient };

// -------- Startup recovery: detect interrupted batches -----------------------
async function recoverInterruptedBatches(retries = 3) {
    try {
        const result = await pool.query(
            `SELECT batch_id, type, progress_snapshot FROM prescreen_history
             WHERE completed_at IS NULL AND (status IS NULL OR status IN ('running', 'resumed'))
             ORDER BY started_at DESC`
        );
        for (const row of result.rows) {
            await pool.query(
                `UPDATE prescreen_history SET status = 'interrupted' WHERE batch_id = $1`,
                [row.batch_id]
            );
            const progress = row.progress_snapshot || {};
            console.log(`[recovery] Marked batch ${row.batch_id.slice(0, 8)}… (${row.type}) as interrupted — ${progress.processed || 0}/${progress.total || '?'} items completed`);
        }
        if (result.rows.length > 0) {
            console.log(`[recovery] ${result.rows.length} interrupted batch(es) detected. Use the UI to resume.`);
        }
    } catch (err) {
        if (retries > 0 && err?.message?.includes('does not exist')) {
            console.log(`[recovery] Waiting for DB migrations… (${retries} retries left)`);
            setTimeout(() => recoverInterruptedBatches(retries - 1), 2000);
        } else {
            console.error('[recovery] Failed to recover interrupted batches:', err?.message);
        }
    }
}

// -------- crash protection ----------------------------------------------------
// Keep the process alive when an unhandled error occurs. Without this, any
// unawaited promise rejection (e.g. ffmpeg/db hiccup) will silently kill the
// server in modern Node, taking down VFE-dependent flows like CM faceswap.
process.on('uncaughtException', (err) => {
    console.error(`[fatal] uncaughtException @ ${new Date().toISOString()}:`, err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
    console.error(`[fatal] unhandledRejection @ ${new Date().toISOString()}:`, reason?.stack || reason);
});
// Ignore SIGHUP so closing the launching shell doesn't kill the server.
// Use SIGTERM/SIGINT for explicit shutdown.
process.on('SIGHUP', () => {
    console.warn(`[signal] SIGHUP received — ignoring (server stays up).`);
});
const _gracefulShutdown = (sig) => {
    console.log(`[signal] ${sig} received — shutting down.`);
    process.exit(0);
};
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => _gracefulShutdown('SIGINT'));

// -------- startup -------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`[video-server] listening on http://localhost:${PORT}`);
    console.log(`[video-server] serving videos from: ${VIDEOS_ROOT}`);
    console.log(`[video-server] serving images from: ${IMAGES_ROOT}`);
    console.log(`[video-server] AI model: ${getActiveModelName()} (${process.env.AI_MODEL || 'kimi'})`);

    // Start background scan immediately on startup
    performScan();
    performImageScan();

    // Recover interrupted batches from previous crash
    recoverInterruptedBatches();

    // Start file watcher
    startWatcher();
});
