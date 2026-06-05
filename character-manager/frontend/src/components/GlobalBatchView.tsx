import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';
import type { BatchJob } from '../types';
import CustomBatchPanel from './CustomBatchPanel';
import './GlobalBatchView.css';

interface Props {
  onBack: () => void;
  onRefresh?: () => void;
}

type BatchType = 'anime' | 'anime_direct' | 'faceswap' | 'zimage' | 'imageedit' | 'video' | 'avatar';

const BATCH_TYPES: { key: BatchType; label: string; desc: string }[] = [
  { key: 'anime', label: '动漫角色生成 (ZImage→Edit)', desc: '先文生图写实，再用 Edit 转动漫风（两步，质量高但慢）' },
  { key: 'anime_direct', label: '动漫角色直出 (ZImage)', desc: '直接用 ZImage 一步生成动漫风角色（单步，快）' },
  { key: 'zimage', label: '批量文生图 (ZImage)', desc: '每角色从素材库随机抽 N 个 prompt 文生图 → 待选' },
  { key: 'imageedit', label: '批量图片编辑 (Edit)', desc: '每角色随机抽 N 个 prompt，base=角色头像 → 编辑 → 待选' },
  { key: 'faceswap', label: '批量换脸 (FaceSwap)', desc: 'face=角色头像；body 来自换脸素材(直接换)与 zimage 生图(生成后换)，注明来源' },
  { key: 'video', label: '批量视频生成 (Wan)', desc: '用已生成的换脸图/编辑图作首帧 + 素材库 video_prompt 合成视频，注明首帧来源' },
  { key: 'avatar', label: '批量头像生成 (YOLO人脸)', desc: '给没有头像的角色用首图做人脸检测+居中裁剪生成头像；已有头像的跳过' },
];

export default function GlobalBatchView({ onBack, onRefresh }: Props) {
  const [characters, setCharacters] = useState<string[]>([]);
  const [selectedChar, setSelectedChar] = useState('');
  const [loading, setLoading] = useState(true);

  const [batchType, setBatchType] = useState<BatchType>('zimage');
  const [perChar, setPerChar] = useState(10);
  const [category, setCategory] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [presets, setPresets] = useState<{ id: string; label: string; prompt: string }[]>([]);
  const [engine, setEngine] = useState<'smartstudio' | 'comfyui'>('smartstudio');
  const [job, setJob] = useState<BatchJob | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.getCharacterList()
      .then(chars => {
        const names = chars.map(c => c.name).sort();
        setCharacters(names);
        if (names.length > 0) setSelectedChar(names[0]!);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.batchGenerateAnimeDefaultPrompt()
      .then(r => {
        setEditPrompt(r.edit_prompt);
        if ((r as any).presets) setPresets((r as any).presets);
      })
      .catch(() => {});
  }, []);

  const refreshJob = useCallback(async () => {
    try {
      const r = await api.batchGenerateStatus();
      setJob(r.job);
      const active = r.job && ['running', 'starting', 'building', 'stopping'].includes(r.job.status);
      if (active && !pollRef.current) {
        pollRef.current = setInterval(() => {
          api.batchGenerateStatus().then(rr => {
            setJob(prev => {
              const wasActive = prev && ['running', 'starting', 'building', 'stopping'].includes(prev.status);
              const nowDone = rr.job && ['completed', 'stopped', 'error'].includes(rr.job.status);
              if (wasActive && nowDone && rr.job) {
                const msg = `批处理完成！✅ ${rr.job.succeeded} 成功 / ❌ ${rr.job.failed} 失败 (${rr.job.status})`;
                alert(msg);
                if (Notification.permission === 'granted') {
                  new Notification('CM 批处理完成', { body: msg });
                }
                onRefresh?.();
              } else if (rr.job && prev && rr.job.succeeded > (prev.succeeded || 0)) {
                onRefresh?.();
              }
              return rr.job;
            });
            const stillActive = rr.job && ['running', 'starting', 'building', 'stopping'].includes(rr.job.status);
            if (!stillActive && pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }).catch(() => {});
        }, 3000);
      }
      if (!active && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshJob();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshJob]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(refreshJob, 3000);
  }, [refreshJob]);

  const handleStart = async () => {
    const t = BATCH_TYPES.find(b => b.key === batchType)!;
    if (!confirm(`启动「${t.label}」？\n范围: ${category ? 'category=' + category : '全部角色'}，每角色 ${perChar} 个。\n生成结果以 pending(待选) 加入角色媒体，需后续审核上线。`)) return;
    setStarting(true);
    try {
      const effectiveCategory = (batchType === 'anime' || batchType === 'anime_direct') ? 'anime' : (category || null);
      const r = await api.batchGenerateStart(batchType, perChar, effectiveCategory, 1024, 1536, 0, (batchType === 'anime' || batchType === 'anime_direct') ? editPrompt : null, engine);
      if (r.status !== 'ok') {
        alert(r.message || '启动失败');
      } else {
        await refreshJob();
        startPolling();
      }
    } catch (e: any) {
      alert('启动失败: ' + e.message);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      const r = await api.batchGenerateStop();
      if (r.message) console.log('stop:', r.message);
      // Immediate UI update: mark current job as stopping locally
      if (job) setJob({ ...job, status: 'stopping' });
      setTimeout(refreshJob, 2000);
    } catch (e: any) { alert('停止失败: ' + e.message); }
  };

  const isActive = !!job && ['running', 'starting', 'building', 'stopping'].includes(job.status);
  const pct = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  return (
    <div className="global-batch-view">
      <div className="gb-header">
        <button className="gb-back-btn" onClick={onBack}>← 返回</button>
        <h2>全局批处理</h2>
      </div>

      <div className="gb-batch-box">
        <h3>🚀 角色批量生成（生成 → 待选 → 确认上线）</h3>
        <div className="gb-type-grid">
          {BATCH_TYPES.map(t => (
            <button
              key={t.key}
              className={`gb-type-card ${batchType === t.key ? 'active' : ''}`}
              onClick={() => setBatchType(t.key)}
              disabled={isActive}
            >
              <span className="gb-type-label">{t.label}</span>
              <span className="gb-type-desc">{t.desc}</span>
            </button>
          ))}
        </div>

        {(batchType === 'anime' || batchType === 'anime_direct') && (
          <div className="gb-edit-prompt">
            <label>转动漫风提示词 (可手工编辑，或选预设)</label>
            {presets.length > 0 && (
              <div className="gb-presets">
                {presets.map(p => (
                  <button
                    key={p.id}
                    className={`gb-preset-btn ${editPrompt === p.prompt ? 'active' : ''}`}
                    onClick={() => setEditPrompt(p.prompt)}
                    disabled={isActive}
                  >{p.label}</button>
                ))}
              </div>
            )}
            <textarea
              value={editPrompt}
              onChange={e => setEditPrompt(e.target.value)}
              disabled={isActive}
              rows={3}
              placeholder="例如: convert to high-quality anime art style..."
            />
          </div>
        )}

        <div className="gb-params">
          <label>每角色数量
            <input type="number" min={1} max={50} value={perChar}
              onChange={e => setPerChar(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              disabled={isActive} />
          </label>
          <label>分类筛选 (留空=全部)
            <input type="text" placeholder="如 anime" value={category}
              onChange={e => setCategory(e.target.value)} disabled={isActive} />
          </label>
          {batchType !== 'avatar' && (
            <label>生成引擎
              <select value={engine} onChange={e => setEngine(e.target.value as 'smartstudio' | 'comfyui')} disabled={isActive}>
                <option value="smartstudio">SmartStudio 云端 (限流, 并发2)</option>
                <option value="comfyui">本地 ComfyUI (16路并行)</option>
              </select>
            </label>
          )}
          {!isActive ? (
            <button className="gb-start-btn" onClick={handleStart} disabled={starting}>
              {starting ? '启动中…' : '开始批处理'}
            </button>
          ) : (
            <button className="gb-stop-btn" onClick={handleStop}>停止</button>
          )}
          <button className="gb-refresh-btn" onClick={refreshJob}>刷新</button>
        </div>

        {job && (
          <div className="gb-progress">
            <div className="gb-progress-bar">
              <div className="gb-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="gb-progress-text">
              [{job.type}] 状态: <b>{job.status}</b> | {job.processed}/{job.total} ({pct}%)
              {' '}| ✅ {job.succeeded} ❌ {job.failed}
              {job.current ? ` | 当前: ${job.current}` : ''}
            </div>
            {job.error && <div className="gb-progress-error">错误: {job.error}</div>}
            {job.failed > 0 && (
              <details className="gb-fail-list">
                <summary>失败明细 ({job.failed})</summary>
                <ul>
                  {job.results.filter(r => !r.ok).slice(0, 50).map((r, i) => (
                    <li key={i}>{r.char || r.name}: {r.error}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <p className="gb-hint">生成的图片/视频会以「待审核」状态出现在各角色详情里，请到角色详情用状态按钮挑选并设为 online。</p>
      </div>

      {loading ? (
        <div className="gb-loading">加载中...</div>
      ) : characters.length === 0 ? (
        <div className="gb-empty">无可用角色</div>
      ) : (
        <>
          <div className="gb-char-select">
            <label>单角色自定义脚本:</label>
            <select value={selectedChar} onChange={e => setSelectedChar(e.target.value)}>
              {characters.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          {selectedChar && (
            <div className="gb-content">
              <CustomBatchPanel characterName={selectedChar} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
