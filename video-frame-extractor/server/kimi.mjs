// Multi-model multimodal description generator.
// Supports Kimi K2.6 and Qwen 3.6 Plus via DashScope-compatible API.
// Model selection controlled by AI_MODEL env var ('kimi' | 'qwen').

import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'fs';
import { readFile as fsReadFile, unlink as fsUnlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

// Boot-time load of static knowledge sources.
const SYSTEM_PROMPT_KIMI = readFileSync('/mnt/cypher/project/opencode-spicy/system_prompt_kimi_k2.6.txt', 'utf-8');
const SYSTEM_PROMPT_QWEN = readFileSync('/mnt/cypher/project/opencode-spicy/system_prompt_qwen.txt', 'utf-8');
const SYSTEM_PROMPT_DSV4 = readFileSync('/mnt/cypher/project/opencode-spicy/system_prompt_dsv4.txt', 'utf-8');

// Video prompt system prompts (separate files for per-model customization).
const VIDEO_PROMPT_SYSTEM_PROMPT_QWEN = readFileSync('/mnt/cypher/project/opencode-spicy/video_prompt_system_prompt_qwen.txt', 'utf-8');
const VIDEO_PROMPT_SYSTEM_PROMPT_KIMI = readFileSync('/mnt/cypher/project/opencode-spicy/video_prompt_system_prompt_kimi.txt', 'utf-8');
const VIDEO_PROMPT_SYSTEM_PROMPT_GLM = readFileSync('/mnt/cypher/project/opencode-spicy/system_prompt_glm5.1.txt', 'utf-8');
const VIDEO_PROMPT_SYSTEM_PROMPT_DSV4 = readFileSync('/mnt/cypher/project/opencode-spicy/system_prompt_dsv4.txt', 'utf-8');

// NSFW prompt template library — full integration (all 14 modules).
// Kimi K2.6 (256K ctx) and Qwen 3.6 Plus (1M ctx) can handle the full content.
const NSFW_TEMPLATES_DIR = '/mnt/cypher/project/asset_manager/nsfw-prompt-templates-asian';
const NSFW_MODULES = [
    '01-场景主题.md',
    '02-景别构图.md',
    '03-裸露液体.md',
    '04-服装专项.md',
    '05-光影氛围.md',
    '06-姿势动作.md',
    '07-表情眼神.md',
    '08-风格胶片.md',
    '09-妆容专项.md',
    '10-发型饰品.md',
    '11-瑕疵细节.md',
    '12-纹身标记.md',
    '13-道具宠物.md',
    '14-人格卡片.md',
];
const NSFW_TEMPLATE_CONTENT = NSFW_MODULES.map(f => readFileSync(`${NSFW_TEMPLATES_DIR}/${f}`, 'utf-8')).join('\n\n');

// Cypher dynamic vocabulary — auto-expanding tag library for all 14 dimensions.
const CYPHER_DIR = '/mnt/cypher/project/asset_manager/nsfw-prompt-templates-cypher';
const CYPHER_CONTENT = NSFW_MODULES.map(f => readFileSync(`${CYPHER_DIR}/${f}`, 'utf-8')).join('\n\n');

// Dimension key → cypher file mapping for auto-append.
const DIMENSION_FILE_MAP = {
    '01_scene': '01-场景主题.md',
    '02_shot': '02-景别构图.md',
    '03_nudity': '03-裸露液体.md',
    '04_clothing': '04-服装专项.md',
    '05_lighting': '05-光影氛围.md',
    '06_pose': '06-姿势动作.md',
    '07_expression': '07-表情眼神.md',
    '08_style': '08-风格胶片.md',
    '09_makeup': '09-妆容专项.md',
    '10_hair': '10-发型饰品.md',
    '11_skin': '11-瑕疵细节.md',
    '12_tattoo': '12-纹身标记.md',
    '13_props': '13-道具宠物.md',
    '14_persona': '14-人格卡片.md',
};

// Pending tags file path — stores [NEW] tags awaiting human review.
const PENDING_TAGS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'pending-tags.json');

function loadPendingTags() {
    try {
        if (!existsSync(PENDING_TAGS_FILE)) return [];
        return JSON.parse(readFileSync(PENDING_TAGS_FILE, 'utf-8'));
    } catch { return []; }
}

function savePendingTags(tags) {
    writeFileSync(PENDING_TAGS_FILE, JSON.stringify(tags, null, 2), 'utf-8');
}

/**
 * Parse [NEW] tags from AI annotation result and store to pending review.
 * Tags are NOT written to cypher files directly — they require human approval.
 * @param {Object} dimensions - e.g. { "01_scene": ["[NEW]新标签|new_tag", "已有标签|existing"], ... }
 * @param {string} videoPath - source video path for traceability
 */
function syncNewTagsToCypher(dimensions, videoPath = '') {
    if (!dimensions || typeof dimensions !== 'object') return;
    const pending = loadPendingTags();
    let totalAdded = 0;

    for (const [dimKey, tags] of Object.entries(dimensions)) {
        if (!Array.isArray(tags)) continue;
        const filename = DIMENSION_FILE_MAP[dimKey];
        if (!filename) continue;

        const newTags = tags
            .filter(t => typeof t === 'string' && t.startsWith('[NEW]'))
            .map(t => t.replace(/^\[NEW\]\s*/, '').trim())
            .filter(t => t.length > 0);

        if (newTags.length === 0) continue;

        for (const tag of newTags) {
            pending.push({
                id: randomUUID(),
                tag,
                dimension: filename,
                videoPath,
                createdAt: new Date().toISOString(),
                status: 'pending',
            });
        }
        totalAdded += newTags.length;
        console.log(`[Cypher] Queued ${newTags.length} new tag(s) for review in ${filename}: ${newTags.join(', ')}`);
    }

    if (totalAdded > 0) {
        savePendingTags(pending);
        console.log(`[Cypher] Total ${totalAdded} tag(s) saved to pending review.`);
    }
}

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// Model configurations
const MODEL_CONFIGS = {
    kimi: { modelName: 'kimi-k2.6', systemPrompt: SYSTEM_PROMPT_KIMI, label: 'Kimi K2.6' },
    'kimi-k2.5': { modelName: 'kimi-k2.5', systemPrompt: SYSTEM_PROMPT_KIMI, label: 'Kimi K2.5' },
    qwen: { modelName: 'qwen3.6-plus', systemPrompt: SYSTEM_PROMPT_QWEN, label: 'Qwen 3.6 Plus' },
    'qwen-3.5': { modelName: 'qwen3.5-plus', systemPrompt: SYSTEM_PROMPT_QWEN, label: 'Qwen 3.5 Plus' },
    'qwen-3.7-plus': { modelName: 'qwen3.7-plus', systemPrompt: SYSTEM_PROMPT_QWEN, label: 'Qwen 3.7 Plus' },
    deepseek: { modelName: 'deepseek-v4-pro', systemPrompt: SYSTEM_PROMPT_DSV4, label: 'DeepSeek V4 Pro', isArbiter: true },
    'qwen-3.7-max': { modelName: 'qwen-max', systemPrompt: SYSTEM_PROMPT_QWEN, label: 'Qwen 3.7 Max', isArbiter: true },
};

/**
 * Get the active model configuration.
 * Priority: explicit parameter > AI_MODEL env var > default 'kimi'
 */
function getModelConfig(modelOverride) {
    const key = modelOverride || process.env.AI_MODEL || 'kimi';
    const config = MODEL_CONFIGS[key];
    if (!config) {
        console.warn(`[AI] Unknown model '${key}', falling back to 'kimi'`);
        return MODEL_CONFIGS.kimi;
    }
    return config;
}

/** Expose current model name for logging / API responses */
export function getActiveModelName() {
    return getModelConfig().modelName;
}

/** Return list of available models for frontend display */
export function getAvailableModels() {
    return Object.entries(MODEL_CONFIGS).map(([key, cfg]) => ({
        key,
        label: cfg.label || cfg.modelName,
        isArbiter: !!cfg.isArbiter,
    }));
}

/**
 * Aggregate recent human-correction feedback rows into a concise textual
 * rule block to append at the tail of the prescreen prompt. Token-cheap
 * alternative to image-based few-shot examples; AI is reminded of the
 * categories of past mistakes and instructed to avoid repeating them.
 *
 * @param {Array<{error_category: string, description?: string}>} feedbackRows
 * @returns {string} rule text (empty string when no input)
 */
export function generateFeedbackRules(feedbackRows) {
    if (!feedbackRows || feedbackRows.length === 0) return '';

    // Aggregate by category. Capture the first non-empty description for
    // categories that depend on free-form text (e.g. 'other').
    const categoryCount = {};
    const categoryDescriptions = {};
    for (const row of feedbackRows) {
        const cat = row?.error_category;
        if (!cat) continue;
        categoryCount[cat] = (categoryCount[cat] || 0) + 1;
        if (row.description && !categoryDescriptions[cat]) {
            categoryDescriptions[cat] = row.description;
        }
    }

    const topCategories = Object.entries(categoryCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    if (topCategories.length === 0) return '';

    const categoryRuleMap = {
        'mosaic_false_pass': '有马赛克/打码的图片必须拒绝，即使其他内容清晰',
        'blur_false_pass': '模糊不清的图片必须拒绝，不要因为NSFW内容而放过质量差的图',
        'clear_false_reject': '清晰高质量的NSFW图片不要误拒，轻微瑕疵不等于低质量',
        'sfw_false_pass': '非NSFW内容（穿衣、非色情）必须拒绝，不要被性感擦边球迷惑',
        'low_quality_false_pass': '低分辨率、严重压缩、画面损坏的图片必须拒绝',
        'ai_generated_false_pass': '明显的AI生成图片（畸形、不自然）必须拒绝',
        'face_category_wrong': '注意区分face_nsfw和body_nsfw：只有清晰可见完整五官的才是face_nsfw',
        'other': null,
    };

    let rules = '\n\n## 历史纠错经验（务必注意避免以下错误）：\n';
    for (const [cat, count] of topCategories) {
        const rule = categoryRuleMap[cat];
        if (rule) {
            rules += `- ${rule}（已出现${count}次此类错误）\n`;
        } else if (categoryDescriptions[cat]) {
            rules += `- ${categoryDescriptions[cat]}（已出现${count}次此类错误）\n`;
        }
    }

    return rules;
}

/**
 * Generate a structured text-to-image description for a frame.
 * @param {string} imageBase64 - base64-encoded image bytes (no data URI prefix)
 * @param {string} format - image format (jpeg/png/webp)
 * @param {string} [modelOverride] - optional model key ('kimi' | 'qwen')
 * @param {string} [feedbackRules] - aggregated correction rules text appended to the prompt
 * @returns {Promise<{prompt: string, pose: string, pose_en: string, tags: string[], style: string, description: string}>}
 */
export async function preScreenImage(imageBase64, format = 'jpeg', modelOverride, feedbackRules = '') {
    const { modelName } = getModelConfig(modelOverride);

    const prompt = `你是一个图片预筛选专家。判断这张图片是否包含可用的 NSFW（成人）内容。

请依次检查以下条件：

1. **NSFW内容**：是否包含成人内容？
   - 通过：裸露、性行为、性暗示、色情场景
   - 排除：纯风景、美食、建筑、动物、普通人物非色情照片（SFW）

2. **图片质量**：NSFW图片是否清晰、高质量？
   - 排除：模糊不清、分辨率极低、严重压缩失真、画面损坏/花屏
   - 排除：有马赛克/打码覆盖关键部位（面部、身体、私密区域）
   - 注意：轻微压缩瑕疵不算低质量

3. **真实性**：是否为真实摄影或高质量截图？
   - 排除：卡通/动漫/插画、明显的低质量AI生成（如畸形手指、面部扭曲）、低质量3D渲染
   - 注意：高质量AI生成（接近真实照片）可以通过

4. **水印检测**：图片是否带有文字水印？
   - 重点关注：左下角、右下角的文字水印（网站名、用户名、品牌标识等）
   - 也注意：图片中央、顶部等位置的半透明文字水印
   - 重要：水印检测仅在条件1-3全部通过后才生效！非NSFW或低质量图片有水印 → 直接拒绝
   - 高质量NSFW图片有明显水印 → 通过，归类为 watermark（值得去水印后使用）
   - 无水印或水印极小不影响画面 → 正常归类

判断流程：
1. 先检查条件1-3（NSFW + 质量 + 真实性），任何一个不通过 → should_annotate: false
2. 条件1-3全部通过后，再检查水印：有明显水印 → 归为 watermark；无水印 → 按人脸分类

如果通过（should_annotate: true），还需分类：
- **watermark**：条件1-3全部通过 + 有明显文字水印（尤其左下角、右下角）→ 高质量NSFW但需去水印后使用
- **face_nsfw**：无水印，图片中有且仅有一张完整、清晰、高清的人脸（正脸或3/4侧脸，五官清楚），不存在第二张人脸，且包含 NSFW 内容 → 适合换脸素材（多人脸场景不属于此类，应归入 body_nsfw）
- **body_nsfw**：无水印，NSFW 内容但无清晰完整的单人脸（仅身体局部、背面、脸被遮挡/截断/模糊、或存在多张人脸等情况）→ NSFW训练素材

注意：watermark 仅用于「高质量NSFW + 有明显水印」的情况！有水印但不是高质量NSFW → 直接拒绝（should_annotate: false）。

输出严格JSON（不要输出任何其他内容）：
{"should_annotate": true或false, "reason": "简短判断理由（20字以内）", "confidence": "high或medium或low", "category": "face_nsfw或body_nsfw或watermark或none"}

category 说明：
- watermark: 高质量NSFW + 有明显文字水印，值得去水印后使用（仅限高质量NSFW图片！）
- face_nsfw: 无水印 + 有且仅有一张清晰完整人脸 + NSFW内容（最佳换脸素材，多人脸不算）
- body_nsfw: 无水印 + NSFW内容但无清晰单人脸，含多人脸场景（NSFW训练素材）
- none: should_annotate为false时使用

confidence 说明：
- high: 非常确定
- medium: 基本确定但有少许疑虑
- low: 不太确定（建议人工复核）`;

    const fullPrompt = prompt + (feedbackRules || '');

    const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
            'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:image/${format};base64,${imageBase64}` } },
                        { type: 'text', text: fullPrompt },
                    ],
                },
            ],
            max_tokens: 256,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pre-screen API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (data?.error) {
        const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
        throw new Error(`Pre-screen API returned error: ${errMsg}`);
    }
    if (!data?.choices?.[0]?.message?.content) {
        throw new Error(`Pre-screen API unexpected response shape`);
    }

    const content = data.choices[0].message.content;
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    } else {
        const firstBrace = content.indexOf('{');
        if (firstBrace > 0) jsonStr = content.slice(firstBrace);
    }

    try {
        const result = JSON.parse(jsonStr);
        return {
            should_annotate: !!result.should_annotate,
            reason: result.reason || '',
            confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium',
            category: ['face_nsfw', 'body_nsfw', 'watermark', 'none'].includes(result.category) ? result.category : (result.should_annotate ? 'body_nsfw' : 'none'),
        };
    } catch (parseErr) {
        // If parsing fails, default to annotate (safe fallback)
        console.warn(`[preScreen] JSON parse failed, defaulting to annotate. Content: ${content.slice(0, 100)}`);
        return { should_annotate: true, reason: 'Pre-screen parse failed, defaulting to annotate', confidence: 'low', category: 'body_nsfw' };
    }
}

/**
 * Batch pre-screen multiple images in a single API call.
 * @param {Array<{base64: string, format: string, name: string}>} images
 * @param {string} [modelOverride] - optional model key ('kimi' | 'qwen')
 * @param {string} [feedbackRules] - aggregated correction rules text
 * @returns {Promise<Array<{should_annotate: boolean, reason: string, confidence: string, category: string}>>}
 */
export async function preScreenImageBatch(images, modelOverride, feedbackRules = '') {
    const { modelName } = getModelConfig(modelOverride);

    const batchPrompt = `你是一个图片预筛选专家。请对以上 ${images.length} 张图片逐一判断是否包含可用的 NSFW（成人）内容。

对每张图依次检查以下条件：

1. **NSFW内容**：是否包含成人内容？
   - 通过：裸露、性行为、性暗示、色情场景
   - 排除：纯风景、美食、建筑、动物、普通人物非色情照片（SFW）

2. **图片质量**：NSFW图片是否清晰、高质量？
   - 排除：模糊不清、分辨率极低、严重压缩失真、画面损坏/花屏
   - 排除：有马赛克/打码覆盖关键部位（面部、身体、私密区域）
   - 注意：轻微压缩瑕疵不算低质量

3. **真实性**：是否为真实摄影或高质量截图？
   - 排除：卡通/动漫/插画、明显的低质量AI生成（如畸形手指、面部扭曲）、低质量3D渲染
   - 注意：高质量AI生成（接近真实照片）可以通过

4. **水印检测**：图片是否带有文字水印？
   - 重点关注：左下角、右下角的文字水印（网站名、用户名、品牌标识等）
   - 重要：水印检测仅在条件1-3全部通过后才有意义！非NSFW或低质量图片有水印 → 直接拒绝
   - 高质量NSFW图片有明显水印 → 通过，归类为 watermark（值得去水印后使用）
   - 无水印 → 正常归类

判断流程：
1. 先检查条件1-3，任何一个不通过 → should_annotate: false（不论有无水印）
2. 条件1-3全部通过后，再看水印：有明显水印 → watermark；无水印 → 按人脸分类

分类规则：
- watermark：条件1-3通过 + 有明显文字水印（仅限高质量NSFW图片！有水印但不是NSFW → 拒绝）
- face_nsfw：无水印 + 有完整清晰人脸 + NSFW内容
- body_nsfw：无水印 + NSFW内容但无清晰人脸
- none：should_annotate为false时使用

请输出严格JSON数组（不要输出任何其他内容），按图片顺序排列：
[{"index":1,"should_annotate":true或false,"reason":"简短理由20字以内","confidence":"high或medium或low","category":"face_nsfw或body_nsfw或watermark或none"}, ...]

注意：index从1开始，对应图片传入顺序。必须输出 ${images.length} 个结果。` + (feedbackRules || '');

    const content = [];
    for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: `data:image/${img.format};base64,${img.base64}` } });
    }
    content.push({ type: 'text', text: batchPrompt });

    try {
        const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
            },
            body: JSON.stringify({
                model: modelName,
                messages: [{ role: 'user', content }],
                max_tokens: Math.min(256 * images.length, 4096),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Batch pre-screen API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        if (data?.error) {
            const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
            throw new Error(`Batch pre-screen API returned error: ${errMsg}`);
        }
        if (!data?.choices?.[0]?.message?.content) {
            throw new Error('Batch pre-screen API unexpected response shape');
        }

        const rawContent = data.choices[0].message.content;
        let jsonStr = rawContent;
        const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        } else {
            const firstBracket = rawContent.indexOf('[');
            if (firstBracket > 0) jsonStr = rawContent.slice(firstBracket);
        }

        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed) || parsed.length !== images.length) {
            throw new Error(`Batch parse length mismatch: expected ${images.length}, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
        }

        return parsed.map(item => ({
            should_annotate: !!item.should_annotate,
            reason: item.reason || '',
            confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
            category: ['face_nsfw', 'body_nsfw', 'watermark', 'none'].includes(item.category) ? item.category : (item.should_annotate ? 'body_nsfw' : 'none'),
        }));
    } catch (err) {
        // Fallback to single-image mode
        console.warn(`[preScreenBatch] batch parse failed, falling back to single-image mode: ${err?.message}`);
        const fallbackResults = [];
        for (const img of images) {
            try {
                const r = await preScreenImage(img.base64, img.format, modelOverride, feedbackRules);
                fallbackResults.push(r);
            } catch (fallbackErr) {
                fallbackResults.push({ should_annotate: true, reason: 'Fallback error', confidence: 'low', category: 'none' });
            }
        }
        return fallbackResults;
    }
}

/**
 * Multi-model voting pre-screen: multiple voter models judge independently,
 * then an arbiter model makes the final decision based on all votes.
 * @param {string} imageBase64 - base64-encoded image
 * @param {string} format - image format
 * @param {string[]} voterKeys - array of model keys to vote (e.g. ['kimi', 'qwen'])
 * @param {string} arbiterKey - arbiter model key (default 'deepseek')
 * @param {string} feedbackRules - aggregated correction rules
 * @returns {Promise<{should_annotate: boolean, reason: string, confidence: string, category: string, voters: Array}>}
 */
export async function preScreenImageMultiVote(imageBase64, format = 'jpeg', voterKeys = ['kimi', 'qwen'], arbiterKey = 'deepseek', feedbackRules = '') {
    // Call all voter models in parallel
    const voterResults = await Promise.all(
        voterKeys.map(async (voterKey) => {
            try {
                const result = await preScreenImage(imageBase64, format, voterKey, feedbackRules);
                return { model: MODEL_CONFIGS[voterKey]?.label || voterKey, ...result };
            } catch (err) {
                console.warn(`[MultiVote] Voter '${voterKey}' failed: ${err.message}`);
                return { model: voterKey, should_annotate: true, reason: 'voter error', confidence: 'low', category: 'body_nsfw', error: true };
            }
        })
    );

    // Check if all voters agree — skip arbiter if unanimous
    const allAgree = voterResults.every(v => v.should_annotate === voterResults[0].should_annotate);
    if (allAgree && voterResults.every(v => v.category === voterResults[0].category) && voterResults.every(v => !v.error)) {
        return {
            ...voterResults[0],
            voters: voterResults,
        };
    }

    // Construct arbiter prompt
    const arbiterPrompt = `你是预筛选最终决策模型。以下是多个 AI 模型对同一张图片的独立判断：

${voterResults.map((v, i) => `模型${i + 1} (${v.model}): {"should_annotate": ${v.should_annotate}, "reason": "${v.reason}", "confidence": "${v.confidence}", "category": "${v.category}"}`).join('\n')}

请综合分析所有判断，做出最终决策。注意：
- 当各模型一致时，遵从一致意见
- 当存在分歧时，重点关注 confidence 高的判断
- category 分歧时，以更保守（面部识别更严格）的为准
- watermark 仅用于高质量NSFW图片有明显水印的情况，非NSFW图片有水印应直接拒绝

输出严格JSON（不要输出任何其他内容）：
{"should_annotate": true或false, "reason": "综合判断理由（20字以内）", "confidence": "high或medium或low", "category": "face_nsfw或body_nsfw或watermark或none"}`;

    // Call arbiter model (text-only, no image)
    const arbiterConfig = MODEL_CONFIGS[arbiterKey];
    if (!arbiterConfig) {
        console.warn(`[MultiVote] Unknown arbiter '${arbiterKey}', using majority vote`);
        // Fallback: use first voter result
        return { ...voterResults[0], voters: voterResults };
    }

    try {
        const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
            },
            body: JSON.stringify({
                model: arbiterConfig.modelName,
                messages: [
                    ...(arbiterConfig.systemPrompt ? [{ role: 'system', content: arbiterConfig.systemPrompt }] : []),
                    { role: 'user', content: arbiterPrompt },
                ],
                max_tokens: 256,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Arbiter API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        if (data?.error) {
            throw new Error(typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error)));
        }
        if (!data?.choices?.[0]?.message?.content) {
            throw new Error('Arbiter unexpected response shape');
        }

        const content = data.choices[0].message.content;
        let jsonStr = content;
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        } else {
            const firstBrace = content.indexOf('{');
            if (firstBrace > 0) jsonStr = content.slice(firstBrace);
        }

        const result = JSON.parse(jsonStr);
        return {
            should_annotate: !!result.should_annotate,
            reason: result.reason || '',
            confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium',
            category: ['face_nsfw', 'body_nsfw', 'watermark', 'none'].includes(result.category) ? result.category : (result.should_annotate ? 'body_nsfw' : 'none'),
            voters: voterResults,
        };
    } catch (err) {
        console.warn(`[MultiVote] Arbiter failed: ${err.message}, using first voter result`);
        return { ...voterResults[0], voters: voterResults };
    }
}

/**
 * Batch multi-model voting pre-screen for multiple images.
 * Processes images with concurrency limit (2 at a time) since each image spawns N voter calls.
 * @param {Array<{base64: string, format: string, name: string}>} images
 * @param {string[]} voterKeys - array of model keys to vote
 * @param {string} arbiterKey - arbiter model key
 * @param {string} feedbackRules - aggregated correction rules
 * @returns {Promise<Array>}
 */
export async function preScreenImageBatchMultiVote(images, voterKeys = ['kimi', 'qwen'], arbiterKey = 'deepseek', feedbackRules = '') {
    const CONCURRENCY = 2;
    const results = new Array(images.length);

    for (let i = 0; i < images.length; i += CONCURRENCY) {
        const batch = images.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(img => preScreenImageMultiVote(img.base64, img.format, voterKeys, arbiterKey, feedbackRules))
        );
        for (let j = 0; j < batchResults.length; j++) {
            results[i + j] = batchResults[j];
        }
    }

    return results;
}

export async function preScreenVideo(videoPath) {
    // 1. Probe video duration
    let duration = 10;
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            videoPath
        ]);
        const parsed = parseFloat(stdout.trim());
        if (!isNaN(parsed) && parsed > 0) duration = parsed;
    } catch { /* use default */ }

    // 2. Extract middle frame to temp file
    const seekTo = Math.max(0, duration / 2);
    const tmpFile = path.join(os.tmpdir(), `prescreen_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);

    try {
        await execFileAsync('ffmpeg', [
            '-ss', String(seekTo),
            '-i', videoPath,
            '-frames:v', '1',
            '-q:v', '2',
            '-y',
            tmpFile
        ]);

        // 3. Read frame as base64
        const buffer = await fsReadFile(tmpFile);
        const imageBase64 = buffer.toString('base64');

        // 4. Reuse preScreenImage logic
        const result = await preScreenImage(imageBase64, 'jpeg');
        return result;
    } finally {
        // cleanup temp file
        try { await fsUnlink(tmpFile); } catch { /* ignore */ }
    }
}

export async function generateDescription(imageBase64, format = 'jpeg', modelOverride, enableThinking = false, humanSkipExamples = []) {
    const { modelName, systemPrompt } = getModelConfig(modelOverride);
    // Note: humanSkipExamples is kept for backward compatibility but no longer used.
    // Skip decisions are now handled by preScreenImage() before calling this function.
    void humanSkipExamples;
    const userPrompt = `请根据这张图片，完成以下任务：

## 参考资料
以下是当前已有的动态标注词库（Cypher），如果你识别到的标签已在词库中则直接使用，不在则新增：
---CYPHER VOCABULARY START---
${CYPHER_CONTENT}
---CYPHER VOCABULARY END---

## 任务
对图片进行 **14维度全标注**，为每个维度选择 1-3 个最匹配的标签（格式：中文 | english）。
如果识别到的标签不在 Cypher 词库中，标记 [NEW] 前缀。

**额外要求**：除了 14 维度标注外，请额外判断图片中人物的肤色与年龄范围，并作为顶级字段单独输出（用于全局基础属性展示）：
- skin_color: 使用英文统一描述（如 fair, tan, olive, brown, dark 等）
- age_range: 字符串格式，例如 "18-22", "23-28", "29-35", "36-45"

## 输出格式（严格 JSON）
{"prompt": "高质量英文文生图 prompt",
 "dimensions": {
   "01_scene": ["标签cn|tag_en", ...],
   "02_shot": ["标签cn|tag_en", ...],
   "03_nudity": ["标签cn|tag_en", ...],
   "04_clothing": ["标签cn|tag_en", ...],
   "05_lighting": ["标签cn|tag_en", ...],
   "06_pose": ["标签cn|tag_en", ...],
   "07_expression": ["标签cn|tag_en", ...],
   "08_style": ["标签cn|tag_en", ...],
   "09_makeup": ["标签cn|tag_en", ...],
   "10_hair": ["标签cn|tag_en", ...],
   "11_skin": ["标签cn|tag_en", ...],
   "12_tattoo": ["标签cn|tag_en", ...],
   "13_props": ["标签cn|tag_en", ...],
   "14_persona": ["标签cn|tag_en", ...]
 },
 "skin_color": "fair | tan | olive | brown | dark | ...",
 "age_range": "18-22 | 23-28 | 29-35 | 36-45",
 "description": "简短场景描述"}

只输出 JSON，不要输出其他内容。`;

    const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
            'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:image/${format};base64,${imageBase64}` } },
                        { type: 'text', text: userPrompt },
                    ],
                },
            ],
            max_tokens: 4096,
            enable_thinking: !!enableThinking,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Validate API response structure before accessing nested fields.
    if (data && data.error) {
        const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
        throw new Error(`AI API returned error: ${errMsg}`);
    }
    if (!data || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0]?.message?.content) {
        const preview = JSON.stringify(data).slice(0, 200);
        throw new Error(`AI API unexpected response shape (no choices/message/content). Preview: ${preview}`);
    }

    const content = data.choices[0].message.content;

    // Robust JSON extraction:
    // 1. Model may wrap output in ```json ... ``` fences.
    // 2. With thinking mode enabled, content may have preamble text before the JSON.
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    } else {
        // Try to find the first '{' as start of JSON object (handles thinking mode preamble)
        const firstBrace = content.indexOf('{');
        if (firstBrace > 0) {
            jsonStr = content.slice(firstBrace);
        }
    }

    try {
        const result = JSON.parse(jsonStr);
        result.modelId = modelName;
        // If AI returned skip, return early without syncing tags
        if (result.skip === true) {
            return result;
        }
        // Queue [NEW] tags for human review.
        syncNewTagsToCypher(result.dimensions);
        return result;
    } catch (parseErr) {
        const preview = String(content).slice(0, 200);
        throw new Error(`Failed to parse AI response as JSON: ${parseErr.message}. Content preview: ${preview}`);
    }
}

/**
 * Reverse-engineer a text-to-image prompt from a "normal" (non-spicy) asset.
 * Reuses the same DashScope chat-completions plumbing as generateDescription()
 * but swaps in a prompt-recovery instruction set. The 14-dimension tagging
 * pipeline is intentionally bypassed — these assets are catalogued by their
 * recovered generation prompt instead.
 *
 * @param {string} imageBase64 - base64-encoded image data
 * @param {string} format - image format (jpeg, png, etc.)
 * @param {string} [modelOverride] - explicit model key (kimi/qwen/deepseek/...)
 * @param {boolean} [enableThinking=false]
 * @returns {Promise<{prompt:string, style:string, description:string, tags:string[], dimensions:Object, pose:null, pose_en:null, modelId:string}>}
 */
export async function generateReversePrompt(imageBase64, format = 'jpeg', modelOverride, enableThinking = false) {
    const { modelName, systemPrompt } = getModelConfig(modelOverride);

    const userPrompt = `You are an expert AI image prompt engineer. Analyze this image and reverse-engineer the most likely text-to-image generation prompt that could have produced it.

Your response MUST be a valid JSON object with this exact structure:
{
  "prompt": "A detailed English text-to-image prompt that could generate this image. Include subject description, pose, clothing, setting, lighting, camera angle, style, and quality tags.",
  "style": "The overall visual style (e.g., photorealistic, anime, 3D render, digital art)",
  "description": "A brief 1-sentence description of what's in the image",
  "tags": ["tag1", "tag2", "tag3"],
  "skin_color": "Subject's skin tone in English (e.g. fair, tan, olive, brown, dark)",
  "age_range": "Estimated age range as a string (e.g. 18-22, 23-28, 29-35, 36-45)"
}

Rules:
- The prompt should be detailed enough to recreate a very similar image
- Use standard Stable Diffusion / Midjourney prompt conventions
- Include quality modifiers like "masterpiece, best quality, high resolution" if the image is high quality
- Include camera/composition info (close-up, full body, etc.)
- Include lighting description
- Tags should be simple keywords describing the main elements
- ALWAYS estimate the subject's skin_color and age_range; use the canonical English buckets above for consistency
- Response MUST be valid JSON only, no extra text`;

    const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
            'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:image/${format};base64,${imageBase64}` } },
                        { type: 'text', text: userPrompt },
                    ],
                },
            ],
            max_tokens: 4096,
            enable_thinking: !!enableThinking,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (data && data.error) {
        const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
        throw new Error(`AI API returned error: ${errMsg}`);
    }
    if (!data || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0]?.message?.content) {
        const preview = JSON.stringify(data).slice(0, 200);
        throw new Error(`AI API unexpected response shape (no choices/message/content). Preview: ${preview}`);
    }

    const content = data.choices[0].message.content;

    // Same JSON extraction strategy as generateDescription(): tolerate ```json fences
    // and any preamble text emitted in thinking mode.
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    } else {
        const firstBrace = content.indexOf('{');
        if (firstBrace > 0) {
            jsonStr = content.slice(firstBrace);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
        const preview = String(content).slice(0, 200);
        throw new Error(`Failed to parse AI response as JSON: ${parseErr.message}. Content preview: ${preview}`);
    }

    return {
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
        style: typeof parsed.style === 'string' ? parsed.style : null,
        description: typeof parsed.description === 'string' ? parsed.description : null,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        // Normal assets bypass the 14-dimension flow entirely.
        dimensions: {},
        // Cross-mode basic attributes — surfaced as top-level fields so the
        // index.mjs persistence layer can merge them into dimensions JSONB.
        skin_color: typeof parsed.skin_color === 'string' ? parsed.skin_color : null,
        age_range: typeof parsed.age_range === 'string' ? parsed.age_range : null,
        pose: null,
        pose_en: null,
        modelId: modelName,
    };
}

/**
 * Multi-model voting for image description (annotation).
 * Calls multiple voter models in parallel, checks consistency, and invokes arbiter if needed.
 * @param {string} imageBase64 - base64-encoded image data
 * @param {string} format - image format (jpeg, png, etc.)
 * @param {string[]} voterKeys - model keys to use as voters (e.g. ['kimi', 'qwen'])
 * @param {string} arbiterKey - model key for the arbiter (e.g. 'deepseek')
 * @param {Object} opts - options: { enableThinking, humanSkipExamples }
 * @returns {Promise<Object>} final annotation result with voters array
 */
export async function generateDescriptionMultiVote(imageBase64, format = 'jpeg', voterKeys = ['kimi', 'qwen'], arbiterKey = 'deepseek', opts = {}) {
    const { enableThinking, humanSkipExamples } = opts;

    // Call all voter models in parallel
    const voterResults = await Promise.all(
        voterKeys.map(async (voterKey) => {
            try {
                const result = await generateDescription(imageBase64, format, voterKey, enableThinking, humanSkipExamples);
                return { model: voterKey, ...result };
            } catch (err) {
                console.warn(`[DescMultiVote] Voter '${voterKey}' failed: ${err.message}`);
                return { model: voterKey, error: true, errorMessage: err.message };
            }
        })
    );

    // Filter out failed voters
    const validVoters = voterResults.filter(v => !v.error);
    if (validVoters.length === 0) {
        throw new Error('[DescMultiVote] All voter models failed');
    }
    if (validVoters.length === 1) {
        // Only one succeeded, return it directly
        return { ...validVoters[0], voters: voterResults, modelId: `${validVoters[0].model}` };
    }

    // Check consistency
    const allSkip = validVoters.every(v => v.skip === true);
    const noneSkip = validVoters.every(v => !v.skip);
    let consistent = false;

    if (allSkip) {
        // All agree to skip
        consistent = true;
    } else if (noneSkip) {
        // All annotated — compare core dimensions
        const coreDims = ['01_scene', '03_nudity', '06_pose'];
        consistent = coreDims.every(dim => {
            const tags = validVoters.map(v => {
                const dimTags = v.dimensions?.[dim];
                if (!Array.isArray(dimTags)) return '';
                // Normalize: extract english part, lowercase, sort
                return dimTags.map(t => (t.split('|')[1] || t).trim().toLowerCase()).sort().join(',');
            });
            // Check if all voters produced the same tag set for this dimension
            return tags.every(t => t === tags[0]);
        });
    }
    // If skip decisions differ, not consistent

    if (consistent) {
        // Unanimous — return first valid result with voters metadata
        const modelIdStr = voterKeys.join('+');
        return {
            ...validVoters[0],
            modelId: modelIdStr,
            voters: voterResults,
        };
    }

    // Not consistent — invoke arbiter
    const arbiterConfig = MODEL_CONFIGS[arbiterKey];
    if (!arbiterConfig) {
        console.warn(`[DescMultiVote] Unknown arbiter '${arbiterKey}', using first voter result`);
        return { ...validVoters[0], voters: voterResults, modelId: validVoters[0].model };
    }

    // Build arbiter prompt
    const voterSummaries = validVoters.map((v, i) => {
        if (v.skip) {
            return `模型${i + 1} (${v.model}): {"skip": true, "skip_reason": "${v.skip_reason || ''}"}`;
        }
        return `模型${i + 1} (${v.model}): {"prompt": "${(v.prompt || '').slice(0, 200)}", "dimensions": ${JSON.stringify(v.dimensions || {})}, "description": "${(v.description || '').slice(0, 100)}"}`;
    }).join('\n\n');

    const arbiterPrompt = `你是图片标注质量仲裁模型。以下是 ${validVoters.length} 个 AI 模型对同一张图片的独立标注结果：

${voterSummaries}

请综合分析所有标注结果，做出最终决策：
- 如果某个模型标注了 skip 而其他模型正常标注，以正常标注的结果为准（除非图片确实不含 NSFW 内容）
- 如果所有模型都正常标注但维度标签有分歧，请选择最准确的标签组合，或综合生成最终结果
- prompt 应选择最详细、最准确的描述
- dimensions 的每个维度应选择最贴切的标签

输出严格JSON（格式与标注模型相同，不要输出任何其他内容）。除 14 维度外，还需输出顶级字段 skin_color 与 age_range（用于全局基础属性展示）：
{"prompt": "高质量英文文生图 prompt",
 "dimensions": {
   "01_scene": ["标签cn|tag_en", ...],
   "02_shot": ["标签cn|tag_en", ...],
   "03_nudity": ["标签cn|tag_en", ...],
   "04_clothing": ["标签cn|tag_en", ...],
   "05_lighting": ["标签cn|tag_en", ...],
   "06_pose": ["标签cn|tag_en", ...],
   "07_expression": ["标签cn|tag_en", ...],
   "08_style": ["标签cn|tag_en", ...],
   "09_makeup": ["标签cn|tag_en", ...],
   "10_hair": ["标签cn|tag_en", ...],
   "11_skin": ["标签cn|tag_en", ...],
   "12_tattoo": ["标签cn|tag_en", ...],
   "13_props": ["标签cn|tag_en", ...],
   "14_persona": ["标签cn|tag_en", ...]
 },
 "skin_color": "fair | tan | olive | brown | dark | ...",
 "age_range": "18-22 | 23-28 | 29-35 | 36-45",
 "description": "简短场景描述"}`;

    try {
        const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
            },
            body: JSON.stringify({
                model: arbiterConfig.modelName,
                messages: [
                    ...(arbiterConfig.systemPrompt ? [{ role: 'system', content: arbiterConfig.systemPrompt }] : []),
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: `data:image/${format};base64,${imageBase64}` } },
                            { type: 'text', text: arbiterPrompt },
                        ],
                    },
                ],
                max_tokens: 4096,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Arbiter API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        if (data?.error) {
            throw new Error(typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error)));
        }
        if (!data?.choices?.[0]?.message?.content) {
            throw new Error('Arbiter unexpected response shape');
        }

        const content = data.choices[0].message.content;
        let jsonStr = content;
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        } else {
            const firstBrace = content.indexOf('{');
            if (firstBrace > 0) jsonStr = content.slice(firstBrace);
        }

        const result = JSON.parse(jsonStr);
        const modelIdStr = `${voterKeys.join('+')}|arbiter:${arbiterKey}`;

        // Queue [NEW] tags from arbiter result
        if (result.dimensions && !result.skip) {
            syncNewTagsToCypher(result.dimensions);
        }

        return {
            ...result,
            modelId: modelIdStr,
            voters: voterResults,
        };
    } catch (err) {
        console.warn(`[DescMultiVote] Arbiter failed: ${err.message}, using first voter result`);
        return { ...validVoters[0], voters: voterResults, modelId: validVoters[0].model };
    }
}

/**
 * Simple round-robin load balancer for model keys.
 * @param {string[]} modelKeys - array of model keys to rotate through
 * @returns {{ next: () => string, getKeys: () => string[] }}
 */
export function createLoadBalancer(modelKeys) {
    let idx = 0;
    return {
        next() { return modelKeys[idx++ % modelKeys.length]; },
        getKeys() { return [...modelKeys]; },
    };
}

/**
 * Generate a structured text-to-image description for a whole video.
 * Reads the video file at `videoPath`, encodes to base64, and submits via `video_url` content type.
 * @param {string} videoPath - absolute filesystem path to the video file
 * @param {string} [modelOverride] - optional model key ('kimi' | 'qwen')
 * @returns {Promise<{prompt: string, pose: string, pose_en: string, tags: string[], style: string, description: string, video_prompt: string, i2v_prompt: string, keyFrames: Array<{timestamp: number, description: string}>}>}
 */
export async function generateVideoDescription(videoPath, modelOverride, { feedbackHistory = [], enableThinking = false } = {}) {
    const { modelName, systemPrompt } = getModelConfig(modelOverride);
    const buffer = readFileSync(videoPath);
    const MAX_SIZE = 100 * 1024 * 1024;
    if (buffer.length > MAX_SIZE) {
        throw new Error('Video file too large (max 100MB)');
    }
    const videoBase64 = buffer.toString('base64');
    const ext = (path.extname(videoPath).slice(1) || 'mp4').toLowerCase();

    // Build negative feedback section for prompt injection
    let feedbackSection = '';
    const badFeedback = feedbackHistory.filter(f => f.feedback === 'bad');
    if (badFeedback.length > 0) {
        feedbackSection = `\n## 历史帧质量反馈（请学习并避免选择类似的差帧）\n` +
            badFeedback.slice(0, 10).map(f =>
                `- ✘ 差帧示例: "${f.description || '无描述'}" — 原因: ${f.feedback_note || '用户标记为不好'}`
            ).join('\n') +
            `\n请避免选择模糊、角度差、无实质内容、过曝/欠曝、遮挡严重的帧作为关键帧。\n`;
    }

    const userPrompt = `请根据这段视频，完成以下任务：

## 参考资料
以下是当前已有的动态标注词库（Cypher），如果你识别到的标签已在词库中则直接使用，不在则新增：
---CYPHER VOCABULARY START---
${CYPHER_CONTENT}
---CYPHER VOCABULARY END---

## 任务
0. **先判断视频是否包含 NSFW 内容**。如果视频完全不包含 NSFW 内容（如纯风景、广告、文字画面、无裸露/性暗示内容），直接输出 {"skip": true, "skip_reason": "原因"} 并停止，不需要完成下面的任务。**重要：只要视频中存在任何 NSFW 元素（裸露、性行为、性暗示等），无论帧数多少、视频多短，都必须进行完整标注，绝对不允许跳过。帧数少时 video_prompt 和 i2v_prompt 可基于现有画面推断。**

1. 对视频进行 **14维度全标注**，为每个维度选择 1-3 个最匹配的标签（格式：中文 | english）。如果识别到的标签不在 Cypher 词库中，标记 [NEW] 前缀。

2. 找出视频中 3-8 个最佳 NSFW 关键帧时间点（精确到小数点后1位的秒数），选择角度好、表情清晰、姿势到位、动作高潮的瞬间。注意避免选择模糊、角度差、过曝/欠曝、遮挡严重或无实质内容的帧。
${feedbackSection}
3. 生成 video_prompt（文生视频提示词，英文）：完整描述视频的动作、镜头运动（pan/tilt/zoom/tracking shot）、节奏（slow/fast/rhythmic），用于文生视频模型。

4. 生成 i2v_prompt（首帧图生视频提示词，英文）：以视频首帧画面为基础，描述从静态到动态的变化过程，用于图生视频模型。

## 输出格式（严格 JSON）
{"prompt": "高质量英文文生图 prompt",
 "dimensions": {
   "01_scene": ["标签cn|tag_en", ...],
   "02_shot": ["标签cn|tag_en", ...],
   "03_nudity": ["标签cn|tag_en", ...],
   "04_clothing": ["标签cn|tag_en", ...],
   "05_lighting": ["标签cn|tag_en", ...],
   "06_pose": ["标签cn|tag_en", ...],
   "07_expression": ["标签cn|tag_en", ...],
   "08_style": ["标签cn|tag_en", ...],
   "09_makeup": ["标签cn|tag_en", ...],
   "10_hair": ["标签cn|tag_en", ...],
   "11_skin": ["标签cn|tag_en", ...],
   "12_tattoo": ["标签cn|tag_en", ...],
   "13_props": ["标签cn|tag_en", ...],
   "14_persona": ["标签cn|tag_en", ...]
 },
 "description": "简短场景描述",
 "video_prompt": "动作+镜头运动+节奏+画面质感，全英文",
 "i2v_prompt": "首帧如何开始运动+运动方向+过渡感，全英文",
 "key_frames": [{"timestamp": 3.5, "description": "reason"}, ...]}

如果视频无 NSFW 内容，输出：
{"skip": true, "skip_reason": "原因描述"}

只输出 JSON，不要输出其他内容。`;

    const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
            'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'video_url', video_url: { url: `data:video/${ext};base64,${videoBase64}` } },
                        { type: 'text', text: userPrompt },
                    ],
                },
            ],
            max_tokens: 4096,
            enable_thinking: !!enableThinking,
        }),
        signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Validate API response structure before accessing nested fields.
    if (data && data.error) {
        const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
        console.error('[generateVideoDescription] AI API returned error payload:', JSON.stringify(data).slice(0, 500));
        throw new Error(`AI API returned error: ${errMsg}`);
    }
    if (!data || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0]?.message?.content) {
        const preview = JSON.stringify(data).slice(0, 200);
        console.error('[generateVideoDescription] Unexpected response shape. Full preview:', JSON.stringify(data).slice(0, 500));
        throw new Error(`AI API unexpected response shape (no choices/message/content). Preview: ${preview}`);
    }

    const content = data.choices[0].message.content;

    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    } else {
        // Try to find the first '{' as start of JSON object (handles thinking mode preamble)
        const firstBrace = content.indexOf('{');
        if (firstBrace > 0) {
            jsonStr = content.slice(firstBrace);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
        const preview = String(content).slice(0, 200);
        console.error('[generateVideoDescription] JSON parse failed. Raw content preview:', preview);
        throw new Error(`Failed to parse AI video response as JSON: ${parseErr.message}. Content preview: ${preview}`);
    }

    // Handle AI skip response (video has no NSFW content)
    if (parsed.skip === true) {
        console.log(`[generateVideoDescription] AI recommends SKIP: ${parsed.skip_reason || 'no reason'}`);
        return {
            skip: true,
            skip_reason: parsed.skip_reason || '',
            modelId: modelName,
        };
    }

    // Validate and filter key_frames
    let validatedKeyFrames = [];
    if (Array.isArray(parsed.key_frames)) {
        validatedKeyFrames = parsed.key_frames.filter(
            (kf) =>
                kf &&
                typeof kf.timestamp === 'number' &&
                typeof kf.description === 'string' &&
                kf.timestamp >= 0
        );
    }

    // Queue [NEW] tags for human review.
    syncNewTagsToCypher(parsed.dimensions, videoPath);

    return {
        prompt: parsed.prompt || '',
        dimensions: parsed.dimensions || {},
        description: parsed.description || '',
        video_prompt: parsed.video_prompt || '',
        i2v_prompt: parsed.i2v_prompt || '',
        keyFrames: validatedKeyFrames,
        modelId: modelName,
    };
}

/**
 * Convert image prompts to video prompts using AI.
 * Processes in batches of up to 10 prompts per API call.
 * @param {string[]} imagePrompts - array of image prompt texts
 * @returns {Promise<(string|null)[]>} array of video prompt strings (null for failed conversions)
 */
// Video prompt model configuration table
const VIDEO_PROMPT_MODELS = {
    'qwen3.7-plus': { modelName: 'qwen3.7-plus', label: 'Qwen 3.7 Plus', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_QWEN },
    'qwen3.6-plus': { modelName: 'qwen3.6-plus', label: 'Qwen 3.6 Plus', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_QWEN },
    'qwen3.5-plus': { modelName: 'qwen3.5-plus', label: 'Qwen 3.5 Plus', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_QWEN },
    'kimi-k2.6': { modelName: 'kimi-k2.6', label: 'Kimi K2.6', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_KIMI },
    'kimi-k2.5': { modelName: 'kimi-k2.5', label: 'Kimi K2.5', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_KIMI },
    'qwen3.7-max': { modelName: 'qwen3.7-max', label: 'Qwen 3.7 Max', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_QWEN },
    'qwen3.6-max': { modelName: 'qwen3.6-max', label: 'Qwen 3.6 Max', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_QWEN },
    'glm5.1': { modelName: 'glm4-plus', label: 'GLM 5.1', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_GLM },
    'deepseek-v4-pro': { modelName: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', systemPrompt: VIDEO_PROMPT_SYSTEM_PROMPT_DSV4 },
};

/**
 * Get available video prompt models list
 */
export function getVideoPromptModels() {
    return Object.entries(VIDEO_PROMPT_MODELS).map(([id, config]) => ({
        id,
        label: config.label
    }));
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Detect model refusals / moderation garbage so callers can treat them as
// PERMANENT failures (retrying the same model won't help) rather than
// transient errors. Patterns drawn from real production logs.
function looksLikeRefusal(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (!t) return false;
    // English refusal openers
    if (/^(I am unable|I'?m unable|I cannot|I can'?t|I can not|I won'?t|I will not|I'?m not|I do not|I don'?t|I'?m sorry|I am sorry|Sorry,|As an AI|Unfortunately,)/i.test(t)) return true;
    // Chinese refusals
    if (/(抱歉|无法满足|无法生成|无法完成|不能帮|我不能|很遗憾)/.test(t)) return true;
    // Bracketed / jailbreak garbage markers seen in logs: [NULL] [ CLOSE ] [ EDGELORD ...
    if (/\[\s*(NULL|CLOSE|EDGELORD|UNSTABLE|CTRL\+C)/i.test(t)) return true;
    if (/^\[\s*\/(\s*\/)+/.test(t)) return true; // "[ / / / 🔴 ..."
    if (/^\*[A-Za-z]/.test(t)) return true;        // "*Cracks knuckles*..."
    return false;
}

export async function convertImagePromptToVideo(imagePrompts, modelId = 'qwen3.7-plus') {
    if (!imagePrompts || imagePrompts.length === 0) return { results: [], modelId, refused: [] };

    const BATCH_SIZE = 10;
    const MAX_RETRIES = 3;       // for transient 429 / network errors
    const BACKOFF_BASE_MS = 1000;
    const INTER_BATCH_MS = 300;  // smooth request rate to avoid burst 429
    const results = [];
    const refused = []; // parallel to results: true => permanent failure (model refusal/moderation)

    const modelConfig = VIDEO_PROMPT_MODELS[modelId] || VIDEO_PROMPT_MODELS['qwen3.7-plus'];
    const systemPrompt = modelConfig.systemPrompt;

    // POST one batch with exponential backoff on 429 / network errors.
    // Returns { data } on success, or { transient } / { refused } on failure.
    const postBatchWithRetry = async (numberedList) => {
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                        'X-DashScope-DataInspection': JSON.stringify({ input: 'disable', output: 'disable' }),
                    },
                    body: JSON.stringify({
                        model: modelConfig.modelName,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: numberedList },
                        ],
                        max_tokens: 4096,
                    }),
                });

                if (response.status === 429) {
                    if (attempt < MAX_RETRIES) {
                        const delay = BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500);
                        console.warn(`[convertImagePromptToVideo] 429 rate limit, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
                        await _sleep(delay);
                        continue;
                    }
                    console.error('[convertImagePromptToVideo] 429 rate limit, retries exhausted');
                    return { transient: true };
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`[convertImagePromptToVideo] API error (${response.status}): ${errorText}`);
                    // 4xx other than 429 is typically content moderation / bad request => permanent
                    return { refused: response.status >= 400 && response.status < 500, transient: response.status >= 500 };
                }

                const data = await response.json();
                if (data?.error) {
                    const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
                    console.error(`[convertImagePromptToVideo] API returned error: ${errMsg}`);
                    return { transient: true };
                }
                if (!data?.choices?.[0]?.message?.content) {
                    console.error('[convertImagePromptToVideo] Unexpected response shape');
                    return { transient: true };
                }
                return { data };
            } catch (err) {
                // network failure ("fetch failed") => transient
                if (attempt < MAX_RETRIES) {
                    const delay = BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500);
                    console.warn(`[convertImagePromptToVideo] network error "${err.message}", retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
                    await _sleep(delay);
                    continue;
                }
                console.error(`[convertImagePromptToVideo] Batch error after retries: ${err.message}`);
                return { transient: true };
            }
        }
    };

    for (let i = 0; i < imagePrompts.length; i += BATCH_SIZE) {
        const batch = imagePrompts.slice(i, i + BATCH_SIZE);
        const numberedList = batch.map((p, idx) => `${idx + 1}. ${p}`).join('\n');

        if (i > 0) await _sleep(INTER_BATCH_MS);

        const outcome = await postBatchWithRetry(numberedList);

        if (!outcome.data) {
            // transient => null (retry next run); refused => permanent (park after maxAttempts)
            const isRefused = !!outcome.refused;
            for (let j = 0; j < batch.length; j++) { results.push(null); refused.push(isRefused); }
            continue;
        }

        const content = outcome.data.choices[0].message.content;

        // Whole-response refusal (model refused the entire batch as prose)
        if (looksLikeRefusal(content)) {
            console.warn(`[convertImagePromptToVideo] response looks like a refusal, marking batch as refused`);
            for (let j = 0; j < batch.length; j++) { results.push(null); refused.push(true); }
            continue;
        }

        let jsonStr = content;
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        } else {
            const firstBracket = content.indexOf('[');
            if (firstBracket > 0) jsonStr = content.slice(firstBracket);
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonStr);
        } catch (parseErr) {
            // Fallback: try splitting by newlines for individual prompts
            console.warn(`[convertImagePromptToVideo] JSON parse failed, trying line split. Error: ${parseErr.message}`);
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            if (lines.length >= batch.length) {
                parsed = lines.slice(0, batch.length);
            } else {
                // Unparseable, non-refusal noise => permanent (won't improve on retry)
                for (let j = 0; j < batch.length; j++) { results.push(null); refused.push(true); }
                continue;
            }
        }

        if (Array.isArray(parsed)) {
            for (let j = 0; j < batch.length; j++) {
                const item = parsed[j];
                const valid = item && typeof item === 'string' && !looksLikeRefusal(item);
                results.push(valid ? item : null);
                refused.push(valid ? false : true);
            }
        } else {
            for (let j = 0; j < batch.length; j++) { results.push(null); refused.push(true); }
        }
    }

    return { results, modelId, refused };
}

// Exported helpers for tag review API
export { loadPendingTags, savePendingTags, DIMENSION_FILE_MAP, CYPHER_DIR };
