import { useState, useEffect, useRef, useCallback, memo } from 'react';
import type { CharacterIndex, CategoryCount } from '../types';
import { api } from '../api/client';
import MediaGrid, { thumb } from './MediaGrid';
import VideoGrid from './VideoGrid';
import TrashSection from './TrashSection';
import GeneratePanel from './GeneratePanel';
import Modal from './Modal';
import './CharacterDetail.css';

interface Props {
  name: string;
  data: CharacterIndex;
  categories: CategoryCount[];
  onRefresh: () => void;
  confirmEnabled: boolean;
  allowHardDelete: boolean;
}

interface AudioCandidate {
  id: number;
  filename: string;
  category: string;
  duration: number;
  oss_url: string;
  status: string;
}

interface PendingItem { url: string; type?: string; source?: string; created_at?: string | null }

// ISO (UTC) -> local "YYYY-MM-DD HH:mm"
const fmtTime = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// memo + thumbnail, same reasons as MediaCard: a 待选区 with hundreds of AI
// images re-rendered every card on each checkbox toggle. Now only the toggled
// card re-renders, and the grid loads ~8x-smaller thumbnails.
const PendingCard = memo(function PendingCard({
  pm, isSel, onToggle, onOpen, onAdopt, onPaid, onDiscard, onPaintStart, onPaintEnter,
}: {
  pm: PendingItem;
  isSel: boolean;
  onToggle: (url: string) => void;
  onOpen: (url: string) => void;
  onAdopt: (url: string) => void;
  onPaid: (url: string) => void;
  onDiscard: (url: string) => void;
  onPaintStart: (url: string, e: React.MouseEvent) => void;
  onPaintEnter: (url: string) => void;
}) {
  return (
    // 刷选: draggable 关掉 (原生拖拽会吞掉 mouseenter, 无法在拖动中连选); 拖到分区改用按钮
    <div
      className={`pending-card${isSel ? ' selected' : ''}`}
      onMouseDown={e => onPaintStart(pm.url, e)}
      onMouseEnter={() => onPaintEnter(pm.url)}
    >
      <input
        type="checkbox"
        className="card-check"
        checked={isSel}
        onChange={() => onToggle(pm.url)}
      />
      {pm.type === 'video' ? (
        <video src={pm.url} controls preload="none" />
      ) : (
        <img src={thumb(pm.url)} loading="lazy" onClick={() => onOpen(pm.url)} />
      )}
      {pm.source && <div className="pending-source">{pm.source}</div>}
      {pm.created_at && <div className="pending-time" title={pm.created_at}>{fmtTime(pm.created_at)}</div>}
      <div className="pending-actions">
        <button className="pending-adopt" onClick={() => onAdopt(pm.url)}>采用</button>
        <button className="pending-paid" onClick={() => onPaid(pm.url)}>付费</button>
        <button className="pending-discard" onClick={() => onDiscard(pm.url)}>丢弃</button>
      </div>
    </div>
  );
});

export default function CharacterDetail({ name, data, categories, onRefresh, confirmEnabled, allowHardDelete }: Props) {
  const [modalUrl, setModalUrl] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [showGen, setShowGen] = useState(false);
  const [voiceUrl, setVoiceUrl] = useState(data.voice_id || '');
  const [pendSel, setPendSel] = useState<Set<string>>(new Set());
  const pendSelRef = useRef(pendSel);
  pendSelRef.current = pendSel;  // 最新值镜像, 供稳定的刷选回调读取
  const [newTag, setNewTag] = useState('');
  const [uploading, setUploading] = useState('');
  const doUpload = async (kind: 'image' | 'audio' | 'video', files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(kind);
    let ok = 0, fail = 0;
    for (const f of Array.from(files)) {
      try {
        const r = await api.uploadMedia(data.id, kind, f);
        if (r.status === 'ok') ok++; else { fail++; }
      } catch { fail++; }
    }
    setUploading('');
    if (fail) alert(`上传完成: 成功 ${ok}, 失败 ${fail}`);
    onRefresh();
  };
  const saveTags = async (tags: string[]) => {
    const r = await api.setTags(data.id, tags);
    if (r.status !== 'ok') { alert('标签保存失败: ' + (r.message || '')); return; }
    onRefresh();
  };
  const [savingVoice, setSavingVoice] = useState(false);
  const [audioCandidates, setAudioCandidates] = useState<AudioCandidate[]>([]);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [showManualVoice, setShowManualVoice] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollResult, setEnrollResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // ── Profile editing (name / category / description / attributes) ──────
  const [editing, setEditing] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [editName, setEditName] = useState(name);
  const [editCategory, setEditCategory] = useState(data.category || '');
  const [editNewCat, setEditNewCat] = useState('');
  const [editDesc, setEditDesc] = useState(data.description || '');
  const [editAttrs, setEditAttrs] = useState<{ key: string; value: string }[]>([]);
  const [profileErr, setProfileErr] = useState('');

  const startEdit = () => {
    setEditName(name);
    setEditCategory(data.category || '');
    setEditNewCat('');
    setEditDesc(data.description || '');
    setEditAttrs(
      Object.entries(data.attributes || {}).map(([k, v]) => ({ key: k, value: String(v) }))
    );
    setProfileErr('');
    setEditing(true);
  };

  const setEditAttr = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setEditAttrs(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addEditAttr = () => setEditAttrs(rows => [...rows, { key: '', value: '' }]);
  const removeEditAttr = (i: number) => setEditAttrs(rows => rows.filter((_, idx) => idx !== i));

  const handleSaveProfile = async () => {
    const newName = editName.trim();
    if (!newName) { setProfileErr('名称不能为空'); return; }
    setProfileErr('');
    setSavingProfile(true);
    try {
      const attributes: Record<string, string> = {};
      for (const { key, value } of editAttrs) {
        const k = key.trim();
        if (k) attributes[k] = value.trim();
      }
      const resolvedCat = (editCategory === '__new__' ? editNewCat.trim() : editCategory.trim()) || 'uncategorized';
      const res = await api.updateCharacterProfile({
        character_id: data.id,
        current_name: name,
        name: newName,
        category: resolvedCat,
        description: editDesc,
        attributes,
      });
      if (res.status !== 'ok') {
        setProfileErr(res.message || '保存失败');
        setSavingProfile(false);
        return;
      }
      // If the name changed, point the route at the new name before refreshing
      // so the parent's "unknown character" guard doesn't bounce us home.
      if (newName !== name) {
        window.location.hash = '#/c/' + encodeURIComponent(newName);
      }
      await onRefresh();
      setEditing(false);
    } catch (e: any) {
      setProfileErr('保存异常: ' + e.message);
    } finally {
      setSavingProfile(false);
    }
  };

  useEffect(() => {
    setVoiceUrl(data.voice_id || '');
  }, [data.id, data.voice_id]);

  const loadCandidates = useCallback(async () => {
    setLoadingAudio(true);
    try {
      const r = await api.audioCandidates(data.id);
      setAudioCandidates(r.items || []);
    } catch { /* ignore */ }
    finally { setLoadingAudio(false); }
  }, [data.id]);

  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  const handleConfirmAudio = async (audioId: number) => {
    try {
      const r = await api.audioConfirm(audioId, data.id);
      if (r.status === 'ok') {
        onRefresh();
        loadCandidates();
      } else {
        alert(r.message || '确认失败');
      }
    } catch (e: any) {
      alert('确认失败: ' + e.message);
    }
  };

  const handleRejectAudio = async (audioId: number) => {
    try {
      await api.audioReject(audioId);
      setAudioCandidates(prev => prev.filter(a => a.id !== audioId));
    } catch (e: any) {
      alert('拒绝失败: ' + e.message);
    }
  };

  const handleRefreshCandidates = async () => {
    setLoadingAudio(true);
    try {
      await api.audioRefreshCandidates(data.id);
      await loadCandidates();
    } catch (e: any) {
      alert('刷新失败: ' + e.message);
    } finally { setLoadingAudio(false); }
  };

  const isCosyVoice = voiceUrl.trim().startsWith('cosyvoice-');

  const handleEnroll = async () => {
    setEnrolling(true);
    setEnrollResult(null);
    try {
      const r = await api.enrollVoice(data.id);
      if (r.status === 'ok') {
        setEnrollResult({ ok: true, msg: `注册成功: ${r.voice_id}` });
        onRefresh();
      } else if (r.status === 'skipped') {
        setEnrollResult({ ok: true, msg: '已注册，跳过' });
      } else {
        const logHint = r.logs?.slice(-3).join(' | ') || '';
        setEnrollResult({ ok: false, msg: r.message || '注册失败' + (logHint ? ` (${logHint})` : '') });
      }
    } catch (e: any) {
      setEnrollResult({ ok: false, msg: '注册异常: ' + e.message });
    } finally {
      setEnrolling(false);
    }
  };

  const attrs = Object.entries(data.attributes || {})
    .filter(([, v]) => v)
    .map(([k, v]) => ({ key: k, value: v }));

  const trashCount = data.trash_all.length;
  const status = data.character_status || 'pending';

  const handleStatusChange = async (newStatus: string) => {
    try {
      await api.updateCharacterStatus(data.id, newStatus);
      onRefresh();
    } catch (e: any) {
      alert('状态更新失败: ' + e.message);
    }
  };

  // stable handlers so PendingCard's memo holds across selection toggles
  const pendToggle = useCallback((url: string) =>
    setPendSel(prev => { const n = new Set(prev); if (n.has(url)) n.delete(url); else n.add(url); return n; }), []);
  const pendOpen = useCallback((url: string) => setModalUrl(url), []);

  // ── 刷选: 按住鼠标在待选卡片上拖过即批量选/取消 (比逐个点勾快) ──
  const paintingRef = useRef(false);
  const paintModeRef = useRef<'add' | 'remove'>('add');
  const pendPaintStart = useCallback((url: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;                       // 仅左键
    if ((e.target as HTMLElement).closest('button, input, video')) return; // 别抢按钮/勾选/视频控件
    const mode: 'add' | 'remove' = pendSelRef.current.has(url) ? 'remove' : 'add';
    paintModeRef.current = mode;
    paintingRef.current = true;
    setPendSel(prev => { const n = new Set(prev); mode === 'add' ? n.add(url) : n.delete(url); return n; });
  }, []);
  const pendPaintEnter = useCallback((url: string) => {
    if (!paintingRef.current) return;
    setPendSel(prev => { const n = new Set(prev); paintModeRef.current === 'add' ? n.add(url) : n.delete(url); return n; });
  }, []);
  useEffect(() => {
    const up = () => { paintingRef.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // ── 快捷键: d=丢弃选中(软删到回收站,可恢复) / a=全部采用剩余到 Profile ──
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (modalUrl) return;
      if (!data.pending_media || data.pending_media.length === 0) return;
      if (e.key === 'd' || e.key === 'D') {
        if (!pendSelRef.current.size) return;
        e.preventDefault();
        const r = await api.deleteBatch(name, [...pendSelRef.current], false);
        if (r.status !== 'ok') { alert(`失败: ${r.message || '未知错误'}`); return; }
        setPendSel(new Set()); onRefresh();
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        await api.pendingAdoptAll(data.id);
        onRefresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data.pending_media, data.id, name, onRefresh, modalUrl]);
  const pendAdopt = useCallback(async (url: string) => {
    await api.adoptBatch(name, [url], 'free');
    onRefresh();
  }, [name, onRefresh]);
  const pendPaid = useCallback(async (url: string) => {
    await api.adoptBatch(name, [url], 'paid');
    onRefresh();
  }, [name, onRefresh]);

  const [dragOver, setDragOver] = useState<string | null>(null);
  // drag a single image onto a section to move it there (append to that section's tail)
  const dropZone = (targetTier: 'free' | 'paid', key: string) => ({
    className: dragOver === key ? 'drop-zone drag-over' : 'drop-zone',
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (dragOver !== key) setDragOver(key); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); },
    onDrop: async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const raw = e.dataTransfer.getData('application/x-cm-media');
      if (!raw) return;
      let d: { url?: string; from?: string };
      try { d = JSON.parse(raw); } catch { return; }
      if (!d.url || d.from === key) return;
      if (d.from === 'pending') await api.adoptBatch(name, [d.url], targetTier);
      else await api.setTier(name, [d.url], targetTier);
      onRefresh();
    },
  });
  const pendDiscard = useCallback(async (url: string) => {
    if (confirmEnabled && !confirm('移到回收站？(可恢复)')) return;
    await api.softDelete(name, url, false);
    onRefresh();
  }, [name, confirmEnabled, onRefresh]);

  const handleSaveVoice = async () => {
    setSavingVoice(true);
    try {
      await api.setVoice(data.id, voiceUrl.trim());
      onRefresh();
    } catch (e: any) {
      alert('默认音频保存失败: ' + e.message);
    } finally {
      setSavingVoice(false);
    }
  };

  return (
    <div className="char-detail">
      <div className="char-header">
        <div className="char-header-top">
          <div className="char-avatar">
            {data.avatar_url ? (
              <img src={data.avatar_url} alt="avatar" />
            ) : (
              <div className="char-avatar-empty" title="尚未设置头像">无头像</div>
            )}
          </div>
          <div className="char-header-info">
            {editing ? (
              <div className="char-edit">
                <input
                  className="char-edit-name"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  placeholder="角色名称"
                />
                <label className="char-edit-label">分类 / Category</label>
                <select
                  className="char-edit-input"
                  value={editCategory}
                  onChange={e => setEditCategory(e.target.value)}
                >
                  <option value="">uncategorized</option>
                  {data.category && !categories.some(c => c.category === data.category) && (
                    <option value={data.category}>{data.category}</option>
                  )}
                  {categories.map(c => (
                    <option key={c.category} value={c.category}>{c.category} ({c.count})</option>
                  ))}
                  <option value="__new__">+ 新建分类…</option>
                </select>
                {editCategory === '__new__' && (
                  <input
                    className="char-edit-input"
                    value={editNewCat}
                    onChange={e => setEditNewCat(e.target.value)}
                    placeholder="输入新分类名"
                    autoFocus
                  />
                )}
                <label className="char-edit-label">描述 / Description</label>
                <textarea
                  className="char-edit-input char-edit-textarea"
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  rows={4}
                  placeholder="角色描述"
                />
                <label className="char-edit-label">属性 / Attributes</label>
                <div className="char-edit-attrs">
                  {editAttrs.map((row, i) => (
                    <div className="char-edit-attr-row" key={i}>
                      <input
                        className="char-edit-input char-edit-attr-key"
                        value={row.key}
                        onChange={e => setEditAttr(i, { key: e.target.value })}
                        placeholder="键"
                      />
                      <input
                        className="char-edit-input char-edit-attr-val"
                        value={row.value}
                        onChange={e => setEditAttr(i, { value: e.target.value })}
                        placeholder="值"
                      />
                      <button className="char-edit-attr-del" onClick={() => removeEditAttr(i)} title="删除">×</button>
                    </div>
                  ))}
                </div>
                <button className="cv-pi-button cv-pi-button--compact char-edit-addattr" onClick={addEditAttr}>
                  + 添加属性
                </button>
                {profileErr && <div className="char-edit-err">{profileErr}</div>}
                <div className="char-edit-actions">
                  <button className="cv-pi-button cv-pi-button--compact" onClick={() => setEditing(false)} disabled={savingProfile}>取消</button>
                  <button className="cv-pi-button cv-pi-button--primary cv-pi-button--compact" onClick={handleSaveProfile} disabled={savingProfile}>
                    {savingProfile ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="char-name-row">
                  <h1>{name}</h1>
                  <button className="char-edit-btn" onClick={startEdit} title="编辑资料">✎ 编辑资料</button>
                  <button
                    className="char-edit-btn"
                    onClick={async () => {
                      const r = await api.setFeatured(data.id, !data.featured);
                      if (r.status !== 'ok') { alert('操作失败: ' + (r.message || '')); return; }
                      onRefresh();
                    }}
                    title={data.featured ? '从精品移出' : '加入精品'}
                    style={{ borderColor: '#f1c40f', color: '#f1c40f' }}
                  >{data.featured ? '★ 已精品' : '☆ 加入精品'}</button>
                  <label className="char-edit-btn" style={{ cursor: 'pointer' }} title="从本地上传图片(自动转存 OSS，进 Profile)">
                    {uploading === 'image' ? '上传中…' : '⬆ 上传图片'}
                    <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                      onChange={e => { doUpload('image', e.target.files); e.target.value = ''; }} />
                  </label>
                  <label className="char-edit-btn" style={{ cursor: 'pointer' }} title="从本地上传视频(自动转存 OSS，进 Profile)">
                    {uploading === 'video' ? '上传中…' : '⬆ 上传视频'}
                    <input type="file" accept="video/*" multiple style={{ display: 'none' }}
                      onChange={e => { doUpload('video', e.target.files); e.target.value = ''; }} />
                  </label>
                  <label className="char-edit-btn" style={{ cursor: 'pointer' }} title="从本地上传音频(自动转存 OSS，设为角色语音)">
                    {uploading === 'audio' ? '上传中…' : '⬆ 上传音频'}
                    <input type="file" accept="audio/*" style={{ display: 'none' }}
                      onChange={e => { doUpload('audio', e.target.files); e.target.value = ''; }} />
                  </label>
                </div>
                <div className="char-desc">{data.description}</div>
                <div className="char-attrs">
                  {attrs.map(a => (
                    <span key={a.key} className="attr-tag">{a.key}: {a.value}</span>
                  ))}
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' }}>
              <span style={{ fontSize: 11, color: '#7a8' }}>标签:</span>
              {(data.tags || []).map(t => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#8de', background: 'rgba(90,170,220,.15)', border: '1px solid #35506e', borderRadius: 10, padding: '1px 8px' }}>
                  {t}
                  <span onClick={() => saveTags((data.tags || []).filter(x => x !== t))} style={{ cursor: 'pointer', color: '#f88' }} title="移除">✕</span>
                </span>
              ))}
              <input
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const t = newTag.trim();
                    if (t && !(data.tags || []).includes(t)) saveTags([...(data.tags || []), t]);
                    setNewTag('');
                  }
                }}
                placeholder="+ 加标签(回车)"
                style={{ fontSize: 12, width: 120, background: '#0e1526', border: '1px solid #2a3550', borderRadius: 10, color: '#cde', padding: '2px 8px' }}
              />
            </div>
            <div className="char-stats">
              {data.profile_images.length} imgs + {data.profile_videos.length} videos | 待选 {(data.pending_media || []).length} | 付费 {(data.paid_images || []).length}
              {trashCount > 0 ? ` | ${trashCount} in trash` : ''}
            </div>
            <div className="char-voice">
              <label>默认音频</label>
              {voiceUrl.trim() && voiceUrl.startsWith('http') && !isCosyVoice && (
                <div className="char-voice-current">
                  <audio src={voiceUrl.trim()} controls preload="none" />
                  <span className="vc-status-tag online">已上线</span>
                  <button onClick={handleEnroll} disabled={enrolling} className="vc-enroll-btn">
                    {enrolling ? '注册中…' : '注册语音'}
                  </button>
                </div>
              )}
              {isCosyVoice && (
                <div className="char-voice-current">
                  <span className="vc-status-tag enrolled">已注册 CosyVoice</span>
                  <span className="vc-voice-id">{voiceUrl.trim()}</span>
                </div>
              )}
              {audioCandidates.filter(a => a.status === 'online').length > 0 && (
                <div className="char-voice-online">
                  {audioCandidates.filter(a => a.status === 'online').map(a => (
                    <div key={a.id} className="voice-candidate online">
                      <span className="vc-cat">[{a.category}]</span>
                      <span className="vc-name" title={a.filename}>{a.filename.slice(0, 30)}</span>
                      <audio src={a.oss_url} controls preload="none" />
                    </div>
                  ))}
                </div>
              )}
              {enrollResult && (
                <div className={`vc-enroll-result ${enrollResult.ok ? 'ok' : 'fail'}`}>
                  {enrollResult.msg}
                  <button className="vc-enroll-close" onClick={() => setEnrollResult(null)}>×</button>
                </div>
              )}
              {audioCandidates.filter(a => a.status === 'pending').length > 0 && (
                <div className="char-voice-candidates">
                  <div className="vc-section-label">待审核候选 ({audioCandidates.filter(a => a.status === 'pending').length})</div>
                  {audioCandidates.filter(a => a.status === 'pending').map(a => (
                    <div key={a.id} className="voice-candidate">
                      <span className="vc-cat">[{a.category}]</span>
                      <span className="vc-name" title={a.filename}>{a.filename.slice(0, 30)}</span>
                      <audio src={a.oss_url} controls preload="none" />
                      <button onClick={() => handleConfirmAudio(a.id)} className="vc-select-btn">上线</button>
                      <button onClick={() => handleRejectAudio(a.id)} className="vc-reject-btn">拒绝</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="char-voice-picker">
                <button onClick={handleRefreshCandidates} disabled={loadingAudio} className="voice-pick-btn">
                  {loadingAudio ? '加载中…' : '换一批'}
                </button>
                <button onClick={() => setShowManualVoice(!showManualVoice)} className="voice-manual-toggle">
                  {showManualVoice ? '收起手动输入' : '手动输入URL'}
                </button>
              </div>
              {showManualVoice && (
                <div className="char-voice-manual">
                  <input
                    type="text"
                    placeholder="音频文件 URL（留空清除）"
                    value={voiceUrl}
                    onChange={e => setVoiceUrl(e.target.value)}
                  />
                  <button onClick={handleSaveVoice} disabled={savingVoice}>
                    {savingVoice ? '保存中…' : '保存'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Generate panel toggle */}
      <div className="gen-toggle-row">
        <button
          className={`gen-toggle-btn ${showGen ? 'active' : ''}`}
          onClick={() => setShowGen(!showGen)}
        >
          🎨 {showGen ? '收起生成面板' : '展开生成面板'}
        </button>
      </div>

      {showGen && (
        <GeneratePanel
          characterId={data.id}
          characterName={name}
          characterStatus={status}
          profileImages={data.profile_images}
          onRefresh={onRefresh}
          onStatusChange={handleStatusChange}
          onImageClick={setModalUrl}
          confirmEnabled={confirmEnabled}
        />
      )}

      {data.pending_media && data.pending_media.length > 0 && (
        <>
          <div className="section-title" style={{ color: '#f1c40f' }}>
            待选区 / 待审核 ({data.pending_media.length})
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="pending-adopt-all" onClick={() => setPendSel(new Set(data.pending_media.map(p => p.url)))}>全选</button>
              <button className="pending-adopt-all" onClick={() => setPendSel(new Set())}>清空</button>
              <span style={{ fontSize: 12, color: '#9ab', alignSelf: 'center' }}>已选 {pendSel.size}</span>
              <span style={{ fontSize: 11, color: '#6a7', alignSelf: 'center' }} title="按住鼠标拖过卡片可连续刷选；d=丢弃选中，a=全部采用剩余">拖动刷选 · d丢弃 · a全采用</span>
              <button className="pending-adopt-all" disabled={!pendSel.size} onClick={async () => {
                const r = await api.adoptBatch(name, [...pendSel], 'paid');
                if (r.status !== 'ok') { alert(`失败: ${r.message || '未知错误'}`); return; }
                setPendSel(new Set()); onRefresh();
              }}>加入付费 💰</button>
              <button className="pending-adopt-all" disabled={!pendSel.size} onClick={async () => {
                const r = await api.adoptBatch(name, [...pendSel], 'free');
                if (r.status !== 'ok') { alert(`失败: ${r.message || '未知错误'}`); return; }
                setPendSel(new Set()); onRefresh();
              }}>采用为 Profile</button>
              <button className="pending-del-all" disabled={!pendSel.size} onClick={async () => {
                if (!confirm(`丢弃选中 ${pendSel.size} 张到回收站？(可恢复)`)) return;
                const r = await api.deleteBatch(name, [...pendSel], false);
                if (r.status !== 'ok') { alert(`失败: ${r.message || '未知错误'}`); return; }
                setPendSel(new Set()); onRefresh();
              }}>丢弃选中</button>
              <button className="pending-adopt-all" onClick={async () => {
                if (confirmEnabled && !confirm(`全部采用 ${data.pending_media.length} 张到 Profile？`)) return;
                await api.pendingAdoptAll(data.id);
                onRefresh();
              }}>全部采用</button>
              {allowHardDelete && (
              <button className="pending-del-all" onClick={async () => {
                if (!confirm(`⚠️ 彻底删除全部 ${data.pending_media.length} 张待选图？不可恢复。`)) return;
                await api.pendingDeleteAll(data.id);
                onRefresh();
              }}>全部删除</button>
              )}
            </div>
          </div>
          <div className="pending-grid">
            {data.pending_media.map(pm => (
              <PendingCard
                key={pm.url}
                pm={pm}
                isSel={pendSel.has(pm.url)}
                onToggle={pendToggle}
                onOpen={pendOpen}
                onAdopt={pendAdopt}
                onPaid={pendPaid}
                onDiscard={pendDiscard}
                onPaintStart={pendPaintStart}
                onPaintEnter={pendPaintEnter}
              />
            ))}
          </div>
        </>
      )}

      <div {...dropZone('free', 'profile')}>
      <div className="section-title">Profile Images</div>
      <MediaGrid
        images={data.profile_images}
        tag="profile"
        characterName={name}
        characterId={data.id}
        onImageClick={setModalUrl}
        onRefresh={onRefresh}
        mediaStatusMap={data.media_status_map}
        confirmEnabled={confirmEnabled}
        allowHardDelete={allowHardDelete}
      />
      </div>

      <div {...dropZone('paid', 'paid')}>
      <div className="section-title">付费素材 Paid ({(data.paid_images || []).length})</div>
      <MediaGrid
        images={data.paid_images || []}
        tag="paid"
        characterName={name}
        characterId={data.id}
        onImageClick={setModalUrl}
        onRefresh={onRefresh}
        mediaStatusMap={data.media_status_map}
        confirmEnabled={confirmEnabled}
        allowHardDelete={allowHardDelete}
      />
      </div>

      <div className="section-title">👗 服装图 Costume ({(data.costume_images || []).length})</div>
      <MediaGrid images={data.costume_images || []} tag="costume" characterName={name} characterId={data.id}
        onImageClick={setModalUrl} onRefresh={onRefresh} mediaStatusMap={data.media_status_map}
        confirmEnabled={confirmEnabled} allowHardDelete={allowHardDelete} />

      <div className="section-title">🏞️ 场景图 Scene ({(data.scene_images || []).length})</div>
      <MediaGrid images={data.scene_images || []} tag="scene" characterName={name} characterId={data.id}
        onImageClick={setModalUrl} onRefresh={onRefresh} mediaStatusMap={data.media_status_map}
        confirmEnabled={confirmEnabled} allowHardDelete={allowHardDelete} />

      <div className="section-title">🎭 道具图 Prop ({(data.prop_images || []).length})</div>
      <MediaGrid images={data.prop_images || []} tag="prop" characterName={name} characterId={data.id}
        onImageClick={setModalUrl} onRefresh={onRefresh} mediaStatusMap={data.media_status_map}
        confirmEnabled={confirmEnabled} allowHardDelete={allowHardDelete} />

      <div className="section-title">Videos ({data.profile_videos.length})</div>
      <VideoGrid videos={data.profile_videos} characterName={name} characterId={data.id} onRefresh={onRefresh} mediaStatusMap={data.media_status_map} confirmEnabled={confirmEnabled} allowHardDelete={allowHardDelete} />


      <div className="section-title trash-title">
        <span>Trash ({trashCount})</span>
        <div className="trash-actions">
          <button
            className={`trash-toggle ${showTrash ? 'active' : ''}`}
            onClick={() => setShowTrash(!showTrash)}
          >{showTrash ? 'Hide' : 'Show'}</button>
          {allowHardDelete && trashCount > 0 && (
            <button className="btn-sm btn-red" onClick={async () => {
              if (!confirm('Permanently delete all trash?')) return;
              await api.emptyTrash(name);
              onRefresh();
            }}>Empty Trash</button>
          )}
        </div>
      </div>
      {showTrash && (
        <TrashSection
          images={[...data.trash_images, ...data.trash_generated]}
          videos={data.trash_videos}
          characterName={name}
          onImageClick={setModalUrl}
          onRefresh={onRefresh}
        />
      )}

      {modalUrl && (
        <Modal url={modalUrl} onClose={() => setModalUrl(null)} />
      )}
    </div>
  );
}
