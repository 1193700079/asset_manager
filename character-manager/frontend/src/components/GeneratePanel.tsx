import { useState, useEffect, useRef, useCallback } from 'react';
import { ossResize } from './MediaGrid';
import type { VFESearchItem } from '../types';
import { api } from '../api/client';
import Modal from './Modal';
import './GeneratePanel.css';

const GEN_TABS = [
  { value: 'faceswap', label: '换脸', category: 'image', needsSource: true, needsFace: true },
  { value: 'imageedit', label: '图像编辑', category: 'image', needsSource: true, needsFace: false },
  { value: 'zimage', label: '文生图', category: 'image', needsSource: false, needsFace: false },
  { value: 'wan_spicy', label: '图生视频', category: 'video', needsSource: true, needsFace: false },
  { value: 'wan_animate', label: '动画', category: 'video', needsSource: true, needsFace: false },
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
  profileImages: string[];
  onRefresh: () => void;
  onStatusChange: (status: string) => void;
  onImageClick: (url: string) => void;
  confirmEnabled: boolean;
}

export default function GeneratePanel({
  characterId, characterName, characterStatus, profileImages,
  onRefresh, onStatusChange, onImageClick, confirmEnabled,
}: Props) {
  // Source cards state
  const [sourceCards, setSourceCards] = useState<VFESearchItem[]>([]);
  const [cardCount, setCardCount] = useState(10);
  const [loadingCards, setLoadingCards] = useState(false);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [excludePaths, setExcludePaths] = useState<string[]>([]);

  // Generation config
  const [activeTab, setActiveTab] = useState('faceswap');
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

  // ── ComfyUI single processing state ──
  const [comfyuiScripts, setComfyuiScripts] = useState<any[]>([]);
  const [comfyuiType, setComfyuiType] = useState('');
  const [comfyuiPrompt, setComfyuiPrompt] = useState('');
  const [comfyuiJobs, setComfyuiJobs] = useState<any[]>([]);
  const [comfyuiSubmitting, setComfyuiSubmitting] = useState(false);
  const comfyuiPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load initial data
  useEffect(() => {
    loadCards();
    loadTasks();
    api.listComfyuiScripts().then(d => {
      const scripts = d.scripts || [];
      setComfyuiScripts(scripts);
      if (scripts.length > 0 && !comfyuiType) {
        setComfyuiType(scripts[0]!.key);
      }
    }).catch(() => { });
  }, [characterId]);

  // Timeout config per task type (seconds)
  const getTimeoutForTask = (taskType: string): number => {
    switch (taskType) {
      case 'faceswap': return 120;
      case 'zimage': return 300;
      case 'imageedit': return 180;
      case 'wan_spicy': return 600;
      case 'wan_animate': return 600;
      default: return 180;
    }
  };

  useEffect(() => {
    const activeTasks = tasks.filter(t => t.status === 'pending' || t.status === 'running');
    const now = Date.now();
    for (const t of activeTasks) {
      if (t.created_at) {
        const age = (now - new Date(t.created_at).getTime()) / 1000;
        const timeout = getTimeoutForTask(t.task_type);
        if (age > timeout) {
          setTasks(prev => prev.map(x => x.task_id === t.task_id
            ? { ...x, status: 'failed', error: `超时 (${timeout}s)，任务可能已失败` } : x));
          activeTasks.splice(activeTasks.indexOf(t), 1);
        }
      }
    }
    if (activeTasks.length > 0 && !pollInterval.current) {
      pollInterval.current = setInterval(() => {
        activeTasks.forEach(t => pollTaskRef.current(t.task_id));
      }, 2000);
    } else if (activeTasks.length === 0 && pollInterval.current) {
      clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
  }, [tasks]);

  useEffect(() => {
    return () => {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = null;
      }
    };
  }, []);

  const isComfyuiTab = GEN_TABS.every(t => t.value !== activeTab);
  const currentGenTab = GEN_TABS.find(t => t.value === activeTab);
  const currentComfyuiScript = comfyuiScripts.find((s: any) => s.key === comfyuiType);

  const loadComfyuiJobs = useCallback(async () => {
    try {
      const d = await api.listComfyuiJobs(characterName);
      setComfyuiJobs(d.jobs || []);
    } catch { }
  }, [characterName]);

  const loadComfyuiJobsRef = useRef(loadComfyuiJobs);
  loadComfyuiJobsRef.current = loadComfyuiJobs;

  useEffect(() => {
    if (isComfyuiTab) loadComfyuiJobs();
  }, [isComfyuiTab, loadComfyuiJobs]);

  useEffect(() => {
    const hasRunning = comfyuiJobs.some(j => j.status === 'running');
    if (hasRunning && !comfyuiPollRef.current) {
      comfyuiPollRef.current = setInterval(() => loadComfyuiJobsRef.current(), 2000);
    }
    if (!hasRunning && comfyuiPollRef.current) {
      clearInterval(comfyuiPollRef.current);
      comfyuiPollRef.current = null;
    }
  }, [comfyuiJobs]);

  useEffect(() => {
    return () => {
      if (comfyuiPollRef.current) {
        clearInterval(comfyuiPollRef.current);
        comfyuiPollRef.current = null;
      }
    };
  }, []);

  const handleSubmitComfyui = async () => {
    const selectedSourceCards = sourceCards.filter(c => selectedCards.has(c.video_path));
    if (!currentComfyuiScript) return;

    const profileImage = profileImages[0];
    const hasImage = profileImage || selectedSourceCards.length > 0;
    if (currentComfyuiScript.needs_image && !hasImage) {
      alert('该角色没有 Profile 图片，请先上传');
      return;
    }
    if (currentComfyuiScript.needs_face && !faceImage) {
      alert('换脸需要提供人脸图片');
      return;
    }
    if (currentComfyuiScript.needs_prompt && !comfyuiPrompt) {
      alert('请输入 prompt');
      return;
    }

    // For comfy_video: if the selected card lacks a dedicated i2v_prompt or
    // video_prompt, we'll fall back to the generic text-to-image prompt.
    // Warn the user — the resulting video may look off because the prompt
    // describes a static image, not motion/action.
    const selectedCardForSubmit = sourceCards.find(c => selectedCards.has(c.video_path)) ?? null;
    if (
      comfyuiType === 'comfy_video' &&
      selectedCardForSubmit &&
      !selectedCardForSubmit.i2v_prompt &&
      !selectedCardForSubmit.video_prompt
    ) {
      const proceed = confirm(
        '⚠️ 提示\n\n' +
        '你选的素材没有图生视频专用的 prompt (i2v_prompt / video_prompt)。\n\n' +
        '系统会使用通用的文生图 prompt 作为降级方案，但生成出来的视频可能:\n' +
        '  • 只描述静态画面，缺乏动作/运镜描述\n' +
        '  • 与你的预期不太一致\n\n' +
        '继续提交？'
      );
      if (!proceed) return;
    }

    setComfyuiSubmitting(true);
    try {
      const card = selectedSourceCards[0];
      const imageUrl = profileImage || (card ? (card.oss_url || card.image_url) : '');
      // For comfy_video: prefer i2v_prompt → video_prompt → prompt (ZImage).
      // For other comfy tasks: use the standard prompt.
      const fallbackPrompt = card
        ? (comfyuiType === 'comfy_video'
            ? (card.i2v_prompt || card.video_prompt || card.prompt || '')
            : (card.prompt || ''))
        : '';
      const prompt = comfyuiPrompt || fallbackPrompt;
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
        const card = sourceCards.find(c => c.video_path === path);
        if (card) {
          // Text-to-image prompt (ZImage / imageedit)
          const imgP = card.prompt || '';
          // I2V prompt takes priority for any video/motion task
          const vidP = card.i2v_prompt || card.video_prompt || card.prompt || '';
          setImagePrompt(imgP);
          setVideoPrompt(vidP);
          // ComfyUI prompt: route by task type (comfy_video uses i2v_prompt)
          const comfyP = comfyuiType === 'comfy_video' ? vidP : imgP;
          setComfyuiPrompt(comfyP);
        }
      }
      return next;
    });
  };

  // When user switches comfyui task type with a card already selected,
  // re-derive the comfyui prompt from the appropriate card field so each
  // task type shows its own dedicated prompt (i2v for comfy_video, etc.).
  useEffect(() => {
    if (selectedCards.size === 0) return;
    // Use the most recently-selected card (last added = arbitrary, but set has order)
    const lastPath = Array.from(selectedCards).pop();
    if (!lastPath) return;
    const card = sourceCards.find(c => c.video_path === lastPath);
    if (!card) return;
    const imgP = card.prompt || '';
    const vidP = card.i2v_prompt || card.video_prompt || card.prompt || '';
    setComfyuiPrompt(comfyuiType === 'comfy_video' ? vidP : imgP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comfyuiType]);

  const handleUseAsFace = (card: VFESearchItem) => {
    setFaceImage(card.oss_url);
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

  const pollTaskRef = useRef(pollTask);
  pollTaskRef.current = pollTask;

  const handleSubmit = async () => {
    if (!currentGenTab) return;
    const selectedSourceCards = sourceCards.filter(c => selectedCards.has(c.video_path));
    if (selectedSourceCards.length === 0 && currentGenTab.needsSource) {
      alert('请选择至少一张素材作为源图');
      return;
    }
    if (currentGenTab.needsFace && !faceImage) {
      alert('换脸需要提供人脸图片');
      return;
    }

    setSubmitting(true);
    try {
      const card = selectedSourceCards[0];
      const sourceImage = card ? (card.oss_url || card.image_url) : '';

      const res = await api.createGeneration({
        character_id: characterId,
        character_name: characterName,
        task_type: activeTab,
        engine: (activeTab === 'zimage' || activeTab === 'imageedit') ? 'vps141' : 'smartstudio',
        source_image: sourceImage,
        face_image: faceImage,
        prompt: currentGenTab.category === 'video'
          ? (videoPrompt || selectedSourceCards[0]?.prompt || '')
          : (imagePrompt || selectedSourceCards[0]?.prompt || ''),
        batch_count: batchCount,
        resolution,
        duration,
      });

      if (res.task_ids.length > 0) {
        await loadTasks();
        setPollingIds(new Set(res.task_ids));
        for (const tid of res.task_ids) {
          pollTask(tid);
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
    if (confirmEnabled && !confirm('确认丢弃此任务？')) return;
    try {
      await api.discardGeneration(task.task_id);
      setTasks(prev => prev.map(t => t.task_id === task.task_id ? { ...t, status: 'discarded' } : t));
    } catch (e: any) {
      alert('删除失败: ' + e.message);
    }
  };

  const handleDiscardComfyui = async (job_id: string) => {
    try {
      const res = await api.discardComfyuiJob(job_id);
      if (res.status === 'ok') {
        await loadComfyuiJobs();
      } else {
        alert('删除失败: ' + (res.message || '未知错误'));
      }
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
    if (confirmEnabled && !confirm(`确认丢弃 ${discardedIds.length} 个任务？`)) return;
    try {
      await api.batchDiscardGeneration(discardedIds);
      await loadTasks();
    } catch (e: any) {
      alert('批量丢弃失败: ' + e.message);
    }
  };

  const activeTaskCount = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
  const completedCount = tasks.filter(t => t.status === 'completed' || t.status === 'succeeded').length;
  const discardableCount = tasks.filter(t => t.status === 'completed' || t.status === 'succeeded' || t.status === 'failed').length;
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

      {/* Tab bar */}
      <div className="gen-tab-bar">
        {GEN_TABS.map(t => (
          <button
            key={t.value}
            className={`gen-tab gen-tab-${t.category} ${activeTab === t.value ? 'active' : ''}`}
            onClick={() => setActiveTab(t.value)}
          >
            {t.label}
          </button>
        ))}
        <div className="gen-tab-sep" />
        {comfyuiScripts.map((s: any) => (
          <button
            key={s.key}
            className={`gen-tab gen-tab-${s.category} ${activeTab === s.key ? 'active' : ''}`}
            onClick={() => {
              setActiveTab(s.key);
              setComfyuiType(s.key);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Source card gallery — always shown, used for source images and prompt selection */}
      <div className="gen-section">
        <div className="gen-section-header">
          <span className="gen-section-title">Prompt 素材选择</span>
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
              const imgUrl = card.image_url;
              return (
                <div
                  key={card.video_path}
                  className={`gen-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleCard(card.video_path)}
                >
                  {isSelected && <div className="gen-card-check">✓</div>}
                  <img src={ossResize(imgUrl, 400, 70)} loading="lazy" onDoubleClick={e => { e.stopPropagation(); setGenModalUrl(imgUrl); }} />
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

      {/* Config section */}
      <div className="gen-section">
        <div className="gen-section-header">
          <span className="gen-section-title">生成配置</span>
        </div>
        <div className="gen-config">
          {/* Standard gen tab config */}
          {currentGenTab && (
            <>
              {activeTab === 'faceswap' && (
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

              {(activeTab === 'zimage' || activeTab === 'imageedit' || activeTab === 'faceswap') && (
                <div className="gen-config-row gen-config-row-full">
                  <label>图片 Prompt:</label>
                  <textarea
                    value={imagePrompt}
                    onChange={e => setImagePrompt(e.target.value)}
                    placeholder={activeTab === 'zimage' ? '描述要生成的图片内容...' : activeTab === 'imageedit' ? '描述编辑效果 (如: 换上白色连衣裙)...' : '提示词 (可选)...'}
                    className="gen-textarea"
                    rows={2}
                  />
                </div>
              )}

              {(activeTab === 'wan_spicy' || activeTab === 'wan_animate') && (
                <>
                  <div className="gen-config-row gen-config-row-full">
                    <label>视频 Prompt:</label>
                    <textarea
                      value={videoPrompt}
                      onChange={e => setVideoPrompt(e.target.value)}
                      placeholder={activeTab === 'wan_spicy' ? '描述视频动态效果...' : '描述动画效果...'}
                      className="gen-textarea"
                      rows={2}
                    />
                  </div>
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
                {submitting ? '提交中...' : `🚀 生成 ${batchCount} 个${currentGenTab.label}`}
              </button>
            </>
          )}

          {/* ComfyUI tab config */}
          {isComfyuiTab && currentComfyuiScript && (
            <>
              {currentComfyuiScript.needs_image && profileImages.length > 0 && (
                <div className="gen-config-row">
                  <label>输入图片:</label>
                  <div className="gen-profile-preview">
                    <img src={ossResize(profileImages[0] || "", 200, 70)} className="gen-profile-thumb active" />
                    <span className="gen-profile-hint">自动使用第一张 Profile 图片</span>
                  </div>
                </div>
              )}

              {currentComfyuiScript.needs_prompt && (
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

              <div className="comfyui-hints">
                {currentComfyuiScript.needs_image && profileImages.length > 0 && (
                  <span className="comfyui-source-ok">✅ 使用 Profile 图片: {profileImages[0]!.split('/').pop()}</span>
                )}
                {currentComfyuiScript.needs_face && (
                  <span>👤 需要设置人脸图 (素材卡片 👤 按钮)</span>
                )}
                {selectedCards.size > 0 && (
                  <span className="comfyui-source-ok">✅ 已选 {selectedCards.size} 张素材</span>
                )}
                {(() => {
                  if (!currentComfyuiScript.needs_prompt || selectedCards.size === 0) return null;
                  const lastPath = Array.from(selectedCards).pop();
                  const card = sourceCards.find(c => c.video_path === lastPath);
                  if (!card) return null;
                  if (comfyuiType === 'comfy_video') {
                    if (card.i2v_prompt) return <span className="comfyui-source-ok">📹 已加载 I2V prompt (图生视频专用)</span>;
                    if (card.video_prompt) return <span className="comfyui-source-ok">🎬 已加载 video_prompt (无 I2V，使用 video_prompt fallback)</span>;
                    if (card.prompt) return <span style={{color:'#e94560'}}>⚠️ 该素材无 I2V prompt — 已降级使用通用 prompt</span>;
                    return <span style={{color:'#e94560'}}>⚠️ 卡上没有任何可用的 prompt</span>;
                  }
                  if (card.prompt) return <span className="comfyui-source-ok">📝 已加载 ZImage prompt (文生图)</span>;
                  return <span style={{color:'#e94560'}}>⚠️ 卡上没有 prompt</span>;
                })()}
              </div>

              <button
                className="comfyui-submit-btn"
                onClick={handleSubmitComfyui}
                disabled={comfyuiSubmitting}
              >
                {comfyuiSubmitting ? '提交中...' : `🎨 提交 ${currentComfyuiScript.label}`}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tasks section — unified for all tabs */}
      <div className="gen-section">
        <div className="gen-section-header">
          <span className="gen-section-title">
            {isComfyuiTab ? 'ComfyUI 任务' : '生成任务'} ({isComfyuiTab ? comfyuiJobs.filter(j => j.status !== 'discarded').length : totalVisibleTasks})
          </span>
          <div className="gen-section-controls">
            {isComfyuiTab ? (
              <>
                {comfyuiJobs.some(j => j.status === 'running') && (
                  <span className="gen-poll-badge">⏳ {comfyuiJobs.filter(j => j.status === 'running').length} 进行中</span>
                )}
                <button className="gen-btn gen-btn-secondary gen-btn-sm" onClick={loadComfyuiJobs}>刷新</button>
              </>
            ) : (
              <>
                {activeTaskCount > 0 && <span className="gen-poll-badge">⏳ {activeTaskCount} 进行中</span>}
                {completedCount > 0 && (
                  <button className="gen-btn gen-btn-secondary gen-btn-sm" onClick={handleBatchSave}>
                    💾 全部保存 ({completedCount})
                  </button>
                )}
                {discardableCount > 0 && (
                  <button className="gen-btn gen-btn-danger gen-btn-sm" onClick={handleBatchDiscard}>
                    🗑 全部丢弃 ({discardableCount})
                  </button>
                )}
                <button className="gen-btn gen-btn-secondary gen-btn-sm" onClick={loadTasks}>刷新</button>
              </>
            )}
          </div>
        </div>

        {isComfyuiTab ? (
          comfyuiJobs.filter(j => j.status !== 'discarded').length === 0 ? (
            <div className="gen-empty">暂无 ComfyUI 任务</div>
          ) : (
            <div className="gen-tasks">
              {comfyuiJobs.filter(j => j.status !== 'discarded').map(job => {
                const task: GenTask = {
                  task_id: job.job_id,
                  task_type: job.task_type,
                  status: job.status,
                  prompt: job.prompt || '',
                  ref_image_url: job.image_url || '',
                  result_url: job.result_url,
                  error: job.error,
                  created_at: job.created_at,
                  completed_at: job.completed_at,
                };
                return (
                  <GenTaskCard
                    key={job.job_id}
                    task={task}
                    onSave={async () => {
                      try {
                        const mediaType = job.task_type === 'comfy_video' ? 'video' : 'image';
                        const res = await api.saveComfyuiResult(job.job_id, characterName, mediaType);
                        if (res.status === 'ok') {
                          onRefresh();
                          await loadComfyuiJobs();
                        } else {
                          alert('保存失败: ' + (res.message || '未知错误'));
                        }
                      } catch (e: any) {
                        alert('保存失败: ' + e.message);
                      }
                    }}
                    onDiscard={() => handleDiscardComfyui(job.job_id)}
                    onImageClick={onImageClick}
                  />
                );
              })}
            </div>
          )
        ) : (
          loadingTasks && tasks.length === 0 ? (
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
          )
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
  const isVideo = ['wan_spicy', 'wan_animate', 'comfy_video'].includes(task.task_type);

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

      {(isComplete || task.status === 'failed') && (
        <div className="gen-task-actions">
          {isComplete && (
            <button className="gen-btn gen-btn-primary gen-btn-sm" onClick={onSave}>
              💾 保存为{isVideo ? '视频' : '图片'}
            </button>
          )}
          <button className="gen-btn gen-btn-danger gen-btn-sm" onClick={onDiscard}>
            🗑 丢弃
          </button>
        </div>
      )}
    </div>
  );
}
