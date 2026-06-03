import { useState, useEffect, useRef, useCallback } from 'react';
import type { VFESearchItem } from '../types';
import { api } from '../api/client';
import Modal from './Modal';
import CustomBatchPanel from './CustomBatchPanel';
import './GeneratePanel.css';

const VFE_BASE = 'http://localhost:8899';

const TASK_TYPES = [
  { value: 'faceswap', label: '换脸 (FaceSwap)', category: 'image', needsSource: true, needsFace: true },
  { value: 'imageedit', label: '图像编辑 (ImageEdit)', category: 'image', needsSource: true, needsFace: false },
  { value: 'zimage', label: '文生图 (ZImage)', category: 'image', needsSource: false, needsFace: false },
  { value: 'wan_spicy', label: '图生视频 (Wan2.2)', category: 'video', needsSource: true, needsFace: false },
  { value: 'wan_animate', label: '动画 (Animate)', category: 'video', needsSource: true, needsFace: false },
] as const;

const BATCH_OPTIONS = [1, 2, 5, 10];
const CARD_COUNT_OPTIONS = [10, 50, 100];

interface GenTask {
  task_id: string;
  task_type: string;
  status: string;
  prompt: string;
  ref_image_url: string;
  result_url: string | null;
  error: string | null;
  created_at: string | null;
  completed_at?: string | null;
  _elapsed?: number;
}

interface Props {
  characterId: number;
  characterName: string;
  characterStatus: string;
  onRefresh: () => void;
  onStatusChange: (status: string) => void;
  onImageClick: (url: string) => void;
}

export default function GeneratePanel({
  characterId, characterName, characterStatus,
  onRefresh, onStatusChange, onImageClick,
}: Props) {
  // Source cards state
  const [sourceCards, setSourceCards] = useState<VFESearchItem[]>([]);
  const [cardCount, setCardCount] = useState(10);
  const [loadingCards, setLoadingCards] = useState(false);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [excludePaths, setExcludePaths] = useState<string[]>([]);

  // Generation config — separate prompts per category
  const [taskType, setTaskType] = useState('faceswap');
  const [faceImage, setFaceImage] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [videoPrompt, setVideoPrompt] = useState('');
  const [batchCount, setBatchCount] = useState(1);
  const [resolution, setResolution] = useState('480p');
  const [duration, setDuration] = useState(5);

  // Tasks
  const [tasks, setTasks] = useState<GenTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set());
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const [genModalUrl, setGenModalUrl] = useState<string | null>(null);
  const [showCustomBatch, setShowCustomBatch] = useState(false);

  // ── ComfyUI single processing state ──
  const [showComfyui, setShowComfyui] = useState(false);
  const [comfyuiScripts, setComfyuiScripts] = useState<any[]>([]);
  const [comfyuiType, setComfyuiType] = useState('comfy_swap');
  const [comfyuiPrompt, setComfyuiPrompt] = useState('');
  const [comfyuiJobs, setComfyuiJobs] = useState<any[]>([]);
  const [comfyuiSubmitting, setComfyuiSubmitting] = useState(false);
  const comfyuiPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load initial data
  useEffect(() => {
    loadCards();
    loadTasks();
  }, [characterId]);

  // Poll active tasks — 2s interval, with 120s timeout
  useEffect(() => {
    const activeTasks = tasks.filter(t => t.status === 'pending' || t.status === 'running');
    // Auto-fail tasks stuck > 120s
    const now = Date.now();
    for (const t of activeTasks) {
      if (t.created_at) {
        const age = (now - new Date(t.created_at).getTime()) / 1000;
        if (age > 120) {
          setTasks(prev => prev.map(x => x.task_id === t.task_id
            ? { ...x, status: 'failed', error: '超时 (120s)，任务可能已失败' } : x));
          activeTasks.splice(activeTasks.indexOf(t), 1);
        }
      }
    }
    if (activeTasks.length > 0 && !pollInterval.current) {
      pollInterval.current = setInterval(async () => {
        activeTasks.forEach(t => pollTask(t.task_id));
      }, 2000);
    }
    if (activeTasks.length === 0 && pollInterval.current) {
      clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, [tasks]);

  // ── ComfyUI single: load scripts + poll jobs ──
  useEffect(() => {
    if (showComfyui && comfyuiScripts.length === 0) {
      api.listComfyuiScripts().then(d => setComfyuiScripts(d.scripts || [])).catch(() => {});
    }
  }, [showComfyui]);

  const loadComfyuiJobs = useCallback(async () => {
    try {
      const d = await api.listComfyuiJobs(characterName);
      setComfyuiJobs(d.jobs || []);
    } catch {}
  }, [characterName]);

  useEffect(() => {
    if (showComfyui) loadComfyuiJobs();
  }, [showComfyui, loadComfyuiJobs]);

  useEffect(() => {
    const hasRunning = comfyuiJobs.some(j => j.status === 'running');
    if (hasRunning && !comfyuiPollRef.current) {
      comfyuiPollRef.current = setInterval(loadComfyuiJobs, 2000);
    }
    if (!hasRunning && comfyuiPollRef.current) {
      clearInterval(comfyuiPollRef.current);
      comfyuiPollRef.current = null;
    }
    return () => {
      if (comfyuiPollRef.current) clearInterval(comfyuiPollRef.current);
    };
  }, [comfyuiJobs, loadComfyuiJobs]);

  const handleSubmitComfyui = async () => {
    const selectedSourceCards = sourceCards.filter(c => selectedCards.has(c.video_path));
    const script = comfyuiScripts.find((s: any) => s.key === comfyuiType);
    if (!script) return;

    if (script.needs_image && selectedSourceCards.length === 0) {
      alert('请先选择至少一张素材');
      return;
    }
    if (script.needs_face && !faceImage) {
      alert('换脸需要提供人脸图片');
      return;
    }
    if (script.needs_prompt && !comfyuiPrompt) {
      alert('请输入 prompt');
      return;
    }

    setComfyuiSubmitting(true);
    try {
      const imageUrl = selectedSourceCards.length > 0 ? VFE_BASE + selectedSourceCards[0]!.oss_url : '';
      const prompt = comfyuiPrompt || imagePrompt || selectedSourceCards[0]?.prompt || '';
      const res = await api.submitComfyuiSingle({
        task_type: comfyuiType,
        image_url: imageUrl,
        face_url: faceImage,
        prompt: prompt,
        character_name: characterName,
      });
      if (res.status === 'ok') {
        await loadComfyuiJobs();
        setComfyuiPrompt('');
      } else {
        alert('提交失败: ' + (res.message || '未知错误'));
      }
    } catch (e: any) {
      alert('提交失败: ' + e.message);
    } finally {
      setComfyuiSubmitting(false);
    }
  };

  const loadCards = async () => {
    setLoadingCards(true);
    try {
      const data = await api.getRandomCards(characterId, cardCount, excludePaths);
      setSourceCards(data.cards || []);
    } catch { setSourceCards([]); }
    finally { setLoadingCards(false); }
  };

  const handleRefreshCards = () => {
    setSelectedCards(new Set());
    loadCards();
  };

  const handleCardCountChange = (newCount: number) => {
    setCardCount(newCount);
    setSelectedCards(new Set());
    setLoadingCards(true);
    api.getRandomCards(characterId, newCount, excludePaths)
      .then(data => setSourceCards(data.cards || []))
      .catch(() => setSourceCards([]))
      .finally(() => setLoadingCards(false));
  };

  const toggleCard = (path: string) => {
    setSelectedCards(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Auto-fill prompts from this card's prompt
        const card = sourceCards.find(c => c.video_path === path);
        if (card?.prompt) {
          setImagePrompt(card.prompt);
          setVideoPrompt(card.prompt);
        }
      }
      return next;
    });
  };

  const handleUseAsFace = (card: VFESearchItem) => {
    setFaceImage(VFE_BASE + card.oss_url);
  };

  const handleSkipCard = async (card: VFESearchItem) => {
    if (!confirm(`标记为拒绝？此素材将进入VFE拒绝列表，不再出现。\n\n${card.video_name}`)) return;
    try {
      const res = await api.skipVFEImage(card.video_path);
      if (res.success) {
        setSourceCards(prev => prev.filter(c => c.video_path !== card.video_path));
        setExcludePaths(prev => [...prev, card.video_path]);
        setSelectedCards(prev => { const n = new Set(prev); n.delete(card.video_path); return n; });
      } else {
        alert('标记失败: ' + (res.error || '未知错误'));
      }
    } catch (e: any) {
      alert('标记失败: ' + e.message);
    }
  };

  const handleBatchSkipSelected = async () => {
    const toSkip = sourceCards.filter(c => selectedCards.has(c.video_path));
    if (toSkip.length === 0) return;
    if (!confirm(`确认将 ${toSkip.length} 张已选素材标记为拒绝？\n标记后这些素材将进入VFE拒绝列表，不再出现。`)) return;
    let successCount = 0;
    for (const card of toSkip) {
      try {
        const res = await api.skipVFEImage(card.video_path);
        if (res.success) successCount++;
      } catch { /* continue */ }
    }
    const skippedPaths = new Set(toSkip.map(c => c.video_path));
    setSourceCards(prev => prev.filter(c => !skippedPaths.has(c.video_path)));
    setExcludePaths(prev => [...prev, ...skippedPaths]);
    setSelectedCards(new Set());
    alert(`成功标记 ${successCount} / ${toSkip.length} 张素材为拒绝`);
  };

  const loadTasks = async () => {
    setLoadingTasks(true);
    try {
      const data = await api.getGenerationTasks(characterId);
      setTasks(data.tasks || []);
    } catch { setTasks([]); }
    finally { setLoadingTasks(false); }
  };

  const pollTask = async (taskId: string) => {
    try {
      const data = await api.pollGenerationStatus(taskId);
      const isDone = ['succeeded', 'failed', 'completed'].includes(data.task_status.toLowerCase());
      setTasks(prev => prev.map(t =>
        t.task_id === taskId ? {
          ...t,
          status: data.task_status.toLowerCase(),
          result_url: data.result_url,
          error: data.error_message,
          completed_at: isDone ? (data.completed_at || new Date().toISOString()) : t.completed_at,
        } : t
      ));
    } catch { /* ignore poll errors */ }
  };

  const handleSubmit = async () => {
    const currentTaskType = TASK_TYPES.find(t => t.value === taskType)!;
    const selectedSourceCards = sourceCards.filter(c => selectedCards.has(c.video_path));
    if (selectedSourceCards.length === 0 && currentTaskType.needsSource) {
      alert('请选择至少一张素材作为源图');
      return;
    }
    if (currentTaskType.needsFace && !faceImage) {
      alert('换脸需要提供人脸图片');
      return;
    }

    setSubmitting(true);
    try {
      const sourceImage = selectedSourceCards.length > 0
        ? VFE_BASE + selectedSourceCards[0]!.oss_url
        : '';

      const res = await api.createGeneration({
        character_id: characterId,
        character_name: characterName,
        task_type: taskType,
        source_image: sourceImage,
        face_image: faceImage,
        prompt: currentTaskType.category === 'video'
          ? (videoPrompt || selectedSourceCards[0]?.prompt || '')
          : (imagePrompt || selectedSourceCards[0]?.prompt || ''),
        batch_count: batchCount,
        resolution,
        duration,
      });

      if (res.task_ids.length > 0) {
        await loadTasks();
        setPollingIds(new Set(res.task_ids));
        // Start polling immediately
        for (const tid of res.task_ids) {
          setTimeout(() => pollTask(tid), 2000);
        }
      }
      if (res.errors.length > 0) {
        alert(`部分任务创建失败:\n${res.errors.join('\n')}`);
      }
    } catch (e: any) {
      alert('创建失败: ' + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSave = async (task: GenTask) => {
    const mediaType = ['wan_spicy', 'wan_animate'].includes(task.task_type) ? 'video' : 'image';
    try {
      const res = await api.saveGeneration(task.task_id, mediaType);
      if (res.status === 'ok') {
        setTasks(prev => prev.map(t => t.task_id === task.task_id ? { ...t, status: 'saved' } : t));
        onRefresh();
      }
    } catch (e: any) {
      alert('保存失败: ' + e.message);
    }
  };

  const handleDiscard = async (task: GenTask) => {
    try {
      await api.discardGeneration(task.task_id);
      setTasks(prev => prev.map(t => t.task_id === task.task_id ? { ...t, status: 'discarded' } : t));
    } catch (e: any) {
      alert('删除失败: ' + e.message);
    }
  };

  const handleBatchSave = async () => {
    const completedIds = tasks.filter(t => t.status === 'completed' || t.status === 'succeeded').map(t => t.task_id);
    if (completedIds.length === 0) return;
    try {
      const res = await api.batchSaveGeneration(completedIds);
      const savedCount = res.results.filter(r => r.status === 'saved').length;
      await loadTasks();
      onRefresh();
      alert(`成功保存 ${savedCount} 个素材`);
    } catch (e: any) {
      alert('批量保存失败: ' + e.message);
    }
  };

  const handleBatchDiscard = async () => {
    const discardedIds = tasks.filter(t => t.status === 'completed' || t.status === 'succeeded' || t.status === 'failed').map(t => t.task_id);
    if (discardedIds.length === 0) return;
    if (!confirm(`确认丢弃 ${discardedIds.length} 个任务？`)) return;
    try {
      await api.batchDiscardGeneration(discardedIds);
      await loadTasks();
    } catch (e: any) {
      alert('批量丢弃失败: ' + e.message);
    }
  };

  const activeTaskCount = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
  const completedCount = tasks.filter(t => t.status === 'completed' || t.status === 'succeeded').length;
  const totalVisibleTasks = tasks.filter(t => t.status !== 'discarded').length;

  return (
    <div className="gen-panel">
      {/* Status selector */}
      <div className="gen-status-row">
        <span className="gen-status-label">角色状态:</span>
        {(['pending', 'pre_release', 'online'] as const).map(s => (
          <button
            key={s}
            className={`gen-status-btn gen-status-${s} ${characterStatus === s ? 'active' : ''}`}
            onClick={() => onStatusChange(s)}
          >
            {s === 'online' ? '🟢 线上' : s === 'pre_release' ? '🟡 预上线' : '⚪ 待上线'}
          </button>
        ))}
      </div>

      {/* Source card gallery */}
      <div className="gen-section">
        <div className="gen-section-header">
          <span className="gen-section-title">素材选择</span>
          <div className="gen-section-controls">
            <select
              value={cardCount}
              onChange={e => handleCardCountChange(Number(e.target.value))}
              className="gen-select"
            >
              {CARD_COUNT_OPTIONS.map(n => <option key={n} value={n}>{n} 张</option>)}
            </select>
            <button className="gen-btn gen-btn-secondary" onClick={handleRefreshCards} disabled={loadingCards}>
              {loadingCards ? '加载中...' : '🔄 换一批'}
            </button>
          </div>
        </div>

        {loadingCards && sourceCards.length === 0 ? (
          <div className="gen-empty">加载素材中...</div>
        ) : sourceCards.length === 0 ? (
          <div className="gen-empty">无素材</div>
        ) : (
          <div className="gen-cards">
            {sourceCards.map(card => {
              const isSelected = selectedCards.has(card.video_path);
              const imgUrl = VFE_BASE + card.image_url;
              return (
                <div
                  key={card.video_path}
                  className={`gen-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleCard(card.video_path)}
                >
                  {isSelected && <div className="gen-card-check">✓</div>}
                  <img src={imgUrl} loading="lazy" onDoubleClick={e => { e.stopPropagation(); setGenModalUrl(imgUrl); }} />
                  <div className="gen-card-actions">
                    <button
                      className="gen-card-skip-btn"
                      onClick={e => { e.stopPropagation(); handleSkipCard(card); }}
                      title="标记拒绝 — 不再出现此素材"
                    >
                      🚫
                    </button>
                    <button
                      className="gen-card-face-btn"
                      onClick={e => { e.stopPropagation(); handleUseAsFace(card); }}
                      title="用作人脸参考"
                    >
                      👤
                    </button>
                  </div>
                  {card.prompt && (
                    <div className="gen-card-prompt" title={card.prompt}>
                      {card.prompt.substring(0, 60)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {selectedCards.size > 0 && (
          <div className="gen-selected-bar">
            <span className="gen-selected-info">已选 {selectedCards.size} 张</span>
            <button className="gen-btn gen-btn-danger gen-btn-sm" onClick={handleBatchSkipSelected}>
              🚫 批量标记拒绝
            </button>
            <button className="gen-btn gen-btn-secondary gen-btn-sm" onClick={() => setSelectedCards(new Set())}>
              取消全选
            </button>
          </div>
        )}
      </div>

      {/* Generation config */}
      <div className="gen-section">
        <div className="gen-section-header">
          <span className="gen-section-title">生成配置</span>
        </div>
        <div className="gen-config">
          <div className="gen-config-row">
            <label>类型:</label>
            <select value={taskType} onChange={e => setTaskType(e.target.value)} className="gen-select gen-select-wide">
              {TASK_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {taskType === 'faceswap' && (
            <div className="gen-config-row">
              <label>人脸:</label>
              {faceImage ? (
                <div className="gen-face-preview-wrap">
                  <img src={faceImage} className="gen-face-preview" />
                  <button className="gen-btn gen-btn-sm" onClick={() => setFaceImage('')}>✕ 清除</button>
                </div>
              ) : (
                <span className="gen-face-hint">点击上方素材的 👤 按钮设置人脸</span>
              )}
            </div>
          )}

          {/* Image prompt — for zimage, imageedit, faceswap */}
          {(taskType === 'zimage' || taskType === 'imageedit' || taskType === 'faceswap') && (
            <div className="gen-config-row gen-config-row-full">
              <label>图片 Prompt:</label>
              <textarea
                value={imagePrompt}
                onChange={e => setImagePrompt(e.target.value)}
                placeholder={taskType === 'zimage' ? '描述要生成的图片内容...' : taskType === 'imageedit' ? '描述编辑效果 (如: 换上白色连衣裙)...' : '提示词 (可选)...'}
                className="gen-textarea"
                rows={2}
              />
            </div>
          )}

          {/* Video prompt — for wan_spicy, wan_animate */}
          {(taskType === 'wan_spicy' || taskType === 'wan_animate') && (
            <div className="gen-config-row gen-config-row-full">
              <label>视频 Prompt:</label>
              <textarea
                value={videoPrompt}
                onChange={e => setVideoPrompt(e.target.value)}
                placeholder={taskType === 'wan_spicy' ? '描述视频动态效果...' : '描述动画效果...'}
                className="gen-textarea"
                rows={2}
              />
            </div>
          )}

          {(taskType === 'wan_spicy' || taskType === 'wan_animate') && (
            <>
              <div className="gen-config-row">
                <label>分辨率:</label>
                <select value={resolution} onChange={e => setResolution(e.target.value)} className="gen-select">
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                </select>
              </div>
              <div className="gen-config-row">
                <label>时长:</label>
                <select value={duration} onChange={e => setDuration(Number(e.target.value))} className="gen-select">
                  <option value={5}>5 秒</option>
                  <option value={8}>8 秒</option>
                </select>
              </div>
            </>
          )}

          <div className="gen-config-row">
            <label>批量:</label>
            <select value={batchCount} onChange={e => setBatchCount(Number(e.target.value))} className="gen-select">
              {BATCH_OPTIONS.map(n => <option key={n} value={n}>{n} 个</option>)}
            </select>
          </div>

          <button
            className="gen-btn gen-btn-primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '提交中...' : `🚀 生成 ${batchCount} 个${TASK_TYPES.find(t => t.value === taskType)?.label.split(' (')[0]}`}
          </button>
        </div>
      </div>

      {/* Tasks section */}
      <div className="gen-section">
        <div className="gen-section-header">
          <span className="gen-section-title">生成任务 ({totalVisibleTasks})</span>
          <div className="gen-section-controls">
            {activeTaskCount > 0 && <span className="gen-poll-badge">⏳ {activeTaskCount} 进行中</span>}
            {completedCount > 0 && (
              <>
                <button className="gen-btn gen-btn-secondary gen-btn-sm" onClick={handleBatchSave}>
                  💾 全部保存 ({completedCount})
                </button>
                <button className="gen-btn gen-btn-danger gen-btn-sm" onClick={handleBatchDiscard}>
                  🗑 全部丢弃
                </button>
              </>
            )}
            <button className="gen-btn gen-btn-secondary gen-btn-sm" onClick={loadTasks}>刷新</button>
          </div>
        </div>

        {loadingTasks && tasks.length === 0 ? (
          <div className="gen-empty">加载任务中...</div>
        ) : totalVisibleTasks === 0 ? (
          <div className="gen-empty">暂无生成任务</div>
        ) : (
          <div className="gen-tasks">
            {tasks.filter(t => t.status !== 'discarded').map(task => (
              <GenTaskCard
                key={task.task_id}
                task={task}
                onSave={() => handleSave(task)}
                onDiscard={() => handleDiscard(task)}
                onImageClick={onImageClick}
              />
            ))}
          </div>
        )}
      </div>
      {/* ComfyUI single processing */}
      <div className="gen-section">
        <div className="gen-section-header cb-collapse-toggle" onClick={() => setShowComfyui(p => !p)}>
          <span className="gen-section-title">
            {showComfyui ? '▼' : '▶'} ComfyUI 单次处理
          </span>
          {comfyuiJobs.some(j => j.status === 'running') && (
            <span className="gen-poll-badge">⏳ {comfyuiJobs.filter(j => j.status === 'running').length} 进行中</span>
          )}
        </div>
        {showComfyui && (
          <div className="comfyui-single-panel">
            {/* Script type buttons */}
            <div className="comfyui-type-grid">
              {comfyuiScripts.map((s: any) => (
                <button
                  key={s.key}
                  className={`comfyui-type-btn ${comfyuiType === s.key ? 'active' : ''} comfyui-cat-${s.category}`}
                  onClick={() => setComfyuiType(s.key)}
                >
                  <span className="comfyui-type-label">{s.label}</span>
                  <span className="comfyui-type-desc">{s.description}</span>
                </button>
              ))}
            </div>

            {/* Prompt for ComfyUI */}
            {comfyuiScripts.find((s: any) => s.key === comfyuiType)?.needs_prompt && (
              <div className="gen-config-row gen-config-row-full">
                <label>ComfyUI Prompt:</label>
                <textarea
                  value={comfyuiPrompt}
                  onChange={e => setComfyuiPrompt(e.target.value)}
                  placeholder="用上方选中的素材提示词，或自己输入..."
                  className="gen-textarea"
                  rows={2}
                />
              </div>
            )}

            {/* Hints */}
            <div className="comfyui-hints">
              {comfyuiScripts.find((s: any) => s.key === comfyuiType)?.needs_image && (
                <span>📷 请先在素材区选择一张图片</span>
              )}
              {comfyuiScripts.find((s: any) => s.key === comfyuiType)?.needs_face && (
                <span>👤 需要设置人脸图 (素材卡片 👤 按钮)</span>
              )}
              {selectedCards.size > 0 && (
                <span className="comfyui-source-ok">✅ 已选 {selectedCards.size} 张素材</span>
              )}
            </div>

            {/* Submit */}
            <button
              className="comfyui-submit-btn"
              onClick={handleSubmitComfyui}
              disabled={comfyuiSubmitting}
            >
              {comfyuiSubmitting ? '提交中...' : `🎨 提交 ${comfyuiScripts.find((s: any) => s.key === comfyuiType)?.label || 'ComfyUI'}`}
            </button>

            {/* Job results */}
            {comfyuiJobs.length > 0 && (
              <div className="comfyui-jobs">
                <div className="comfyui-jobs-header">
                  <span>本地 ComfyUI 任务</span>
                  <button className="cb-refresh-btn" onClick={loadComfyuiJobs}>🔄</button>
                </div>
                {comfyuiJobs.map(j => (
                  <div key={j.job_id} className={`comfyui-job comfyui-job-${j.status}`}>
                    <div className="comfyui-job-row">
                      <span className="comfyui-job-icon">
                        {j.status === 'running' ? '⏳' : j.status === 'completed' ? '✅' : '❌'}
                      </span>
                      <span className="comfyui-job-label">{j.label}</span>
                      <span className="comfyui-job-time">
                        {j.created_at ? new Date(j.created_at).toLocaleTimeString() : ''}
                      </span>
                    </div>
                    {j.status === 'completed' && j.result_url && (
                      <div className="comfyui-job-result">
                        {j.task_type === 'comfy_video' ? (
                          <video src={j.result_url} controls muted className="comfyui-result-media" />
                        ) : (
                          <img src={j.result_url} className="comfyui-result-media"
                               onClick={() => onImageClick(j.result_url)} />
                        )}
                        <button className="comfyui-save-btn" onClick={async () => {
                          try {
                            const mediaType = j.task_type === 'comfy_video' ? 'video' : 'image';
                            const res = await api.saveComfyuiResult(j.job_id, characterName, mediaType);
                            if (res.status === 'ok') {
                              onRefresh();
                              await loadComfyuiJobs();
                            } else {
                              alert('保存失败: ' + (res.message || '未知错误'));
                            }
                          } catch (e: any) {
                            alert('保存失败: ' + e.message);
                          }
                        }}>💾 保存到角色</button>
                      </div>
                    )}
                    {j.error && <div className="comfyui-job-error">{j.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Custom batch scripts */}
      <div className="gen-section">
        <div className="gen-section-header cb-collapse-toggle" onClick={() => setShowCustomBatch(p => !p)}>
          <span className="gen-section-title">
            {showCustomBatch ? '▼' : '▶'} 自定义批处理 (ComfyUI)
          </span>
        </div>
        {showCustomBatch && (
          <CustomBatchPanel characterName={characterName} />
        )}
      </div>

      {genModalUrl && <Modal url={genModalUrl} onClose={() => setGenModalUrl(null)} />}
    </div>
  );
}

function GenTaskCard({
  task, onSave, onDiscard, onImageClick,
}: {
  task: GenTask;
  onSave: () => void;
  onDiscard: () => void;
  onImageClick: (url: string) => void;
}) {
  const statusLabel: Record<string, string> = {
    pending: '⏳ 等待中',
    running: '🔄 生成中',
    completed: '✅ 完成',
    succeeded: '✅ 完成',
    failed: '❌ 失败',
    saved: '💾 已保存',
    discarded: '🗑 已丢弃',
  };

  const [elapsed, setElapsed] = useState('');

  // Live timer for running/pending tasks — freezes on completion
  useEffect(() => {
    if (!task.created_at) return;

    const start = new Date(task.created_at).getTime();
    const isDone = !['running', 'pending'].includes(task.status);

    if (isDone) {
      // Freeze at final time: use completed_at if available, else now
      const end = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
      const secs = Math.max(0, Math.floor((end - start) / 1000));
      setElapsed(`${secs}s`);
      return; // No interval needed
    }

    const update = () => {
      const secs = Math.floor((Date.now() - start) / 1000);
      setElapsed(`${secs}s`);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [task.status, task.created_at, task.completed_at]);

  const isComplete = task.status === 'completed' || task.status === 'succeeded';
  const isVideo = ['wan_spicy', 'wan_animate'].includes(task.task_type);

  return (
    <div className={`gen-task-card gen-task-${task.status}`}>
      <div className="gen-task-header">
        <span className="gen-task-type">{task.task_type}</span>
        <span className="gen-task-status">
          {statusLabel[task.status] || task.status}
          {elapsed && <span className="gen-task-elapsed">{elapsed}</span>}
        </span>
      </div>
      {task.prompt && <div className="gen-task-prompt">{task.prompt.substring(0, 80)}</div>}

      {task.result_url && (
        <div className="gen-task-result">
          {isVideo ? (
            <video
              src={task.result_url}
              controls
              muted
              preload="metadata"
              className="gen-task-media"
            />
          ) : (
            <img
              src={task.result_url}
              className="gen-task-media"
              loading="lazy"
              onClick={() => onImageClick(task.result_url!)}
            />
          )}
        </div>
      )}

      {task.error && <div className="gen-task-error">{task.error}</div>}

      {isComplete && (
        <div className="gen-task-actions">
          <button className="gen-btn gen-btn-primary gen-btn-sm" onClick={onSave}>
            💾 保存为{isVideo ? '视频' : '图片'}
          </button>
          <button className="gen-btn gen-btn-danger gen-btn-sm" onClick={onDiscard}>
            🗑 丢弃
          </button>
        </div>
      )}
    </div>
  );
}
