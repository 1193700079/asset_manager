import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { api } from '../api/client';
import './MediaGrid.css';

const STATUS_CYCLE: Record<string, string> = { pending: 'online', online: 'pre_release', pre_release: 'pending' };
const STATUS_ICONS: Record<string, string> = { online: '🟢', pre_release: '🟡', pending: '⚪' };

// Grid uses an OSS/CDN-resized thumbnail (~8x smaller: 2MB -> ~270KB). Full-res
// url is kept for click-to-open. Works on both the ecjoy OSS host and the
// static.ecjoy.ai CDN; non-image / non-OSS urls pass through unchanged.
// ponytail: w_400 is plenty for a grid card; bump if cards ever render larger.
export const ossResize = (url: string, w: number, q = 80) =>
  /^https?:\/\//.test(url) && /\.(jpe?g|png|webp)(\?|$)/i.test(url)
    ? url + (url.includes('?') ? '&' : '?') + `x-oss-process=image/resize,w_${w}/format,jpg/quality,q_${q}`
    : url;
export const thumb = (url: string) => ossResize(url, 400, 75);

const IMG_ERR =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect fill="%2316213e" width="120" height="120"/><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10">Err</text></svg>';

interface CardProps {
  img: string;
  tag: string;
  status: string;
  selectMode: boolean;
  isSel: boolean;
  onImageClick: (url: string) => void;
  onToggleSel: (url: string) => void;
  onStatusToggle: (e: React.MouseEvent, url: string) => void;
  onDelete: (e: React.MouseEvent, url: string) => void;
  onHardDelete: (e: React.MouseEvent, url: string) => void;
  onSetPaid: (e: React.MouseEvent, url: string) => void;
  onSetFree: (e: React.MouseEvent, url: string) => void;
  onSetAvatar: (e: React.MouseEvent, url: string) => void;
  allowHardDelete: boolean;
}

// memo: without this every checkbox toggle re-rendered the whole grid (1000+
// cards). Now a toggle only re-renders the one card whose isSel changed.
const MediaCard = memo(function MediaCard({
  img, tag, status, selectMode, isSel,
  onImageClick, onToggleSel, onStatusToggle, onDelete, onHardDelete, onSetPaid, onSetFree, onSetAvatar, allowHardDelete,
}: CardProps) {
  const fname = img.split('/').pop()?.split('?')[0] || '';
  return (
    <div
      className={`media-card media-status-${status}${selectMode && isSel ? ' selected' : ''}`}
      draggable
      onDragStart={e => e.dataTransfer.setData('application/x-cm-media', JSON.stringify({ url: img, from: tag }))}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="card-check"
          checked={isSel}
          onChange={() => onToggleSel(img)}
          onClick={e => e.stopPropagation()}
        />
      )}
      <div className="card-badge">{tag}</div>
      <button className="card-status-btn" onClick={e => onStatusToggle(e, img)} title={`状态: ${status} → 点击切换`}>
        {STATUS_ICONS[status] || '⚪'}
      </button>
      <button className="card-del" onClick={e => onDelete(e, img)} title="Move to trash (recoverable)">✕</button>
      {allowHardDelete && (
        <button className="card-hard-del" onClick={e => onHardDelete(e, img)} title="Permanent delete (DB + OSS)">🗑</button>
      )}
      {tag === 'profile' && (
        <button className="card-paid-btn" onClick={e => onSetPaid(e, img)} title="设为付费素材">💰</button>
      )}
      {tag === 'paid' && (
        <button className="card-tofree-btn" onClick={e => onSetFree(e, img)} title="转回 Profile">↩</button>
      )}
      <button className="card-avatar-btn" onClick={e => onSetAvatar(e, img)} title="用这张图生成角色头像">👤</button>
      <img
        src={thumb(img)}
        loading="lazy"
        onClick={() => (selectMode ? onToggleSel(img) : onImageClick(img))}
        onError={e => { (e.target as HTMLImageElement).src = IMG_ERR; }}
      />
      <div className="card-name">{fname}</div>
    </div>
  );
});

interface Props {
  images: string[];
  tag: string;
  characterName: string;
  characterId: number;
  onImageClick: (url: string) => void;
  onRefresh: () => void;
  mediaStatusMap?: Record<string, string>;
  confirmEnabled: boolean;
  allowHardDelete: boolean;
}

export default function MediaGrid({ images, tag, characterName, characterId, onImageClick, onRefresh, mediaStatusMap, confirmEnabled, allowHardDelete }: Props) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Fresh data from a refresh is authoritative — clear optimistic hides so an
  // item that legitimately returns to this grid (e.g. Paid -> Profile) reappears.
  useEffect(() => { setHidden(new Set()); }, [images]);

  const visible = images.filter(u => !hidden.has(u));

  // Incremental render: mount only the first `limit` cards and grow on scroll,
  // so a character with hundreds of images doesn't paint them all at once.
  const PAGE = 200;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [images]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (limit >= visible.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      es => { if (es[0]?.isIntersecting) setLimit(l => l + PAGE); },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [limit, visible.length]);
  const shown = visible.slice(0, limit);

  const toggleSel = useCallback((url: string) =>
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(url)) n.delete(url); else n.add(url);
      return n;
    }), []);
  const selectAll = () => setSelected(new Set(visible));
  const clearSel = () => setSelected(new Set());
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };

  const batchDelete = async (hard: boolean) => {
    const urls = [...selected];
    if (!urls.length) return;
    if (hard) {
      if (!confirm(`⚠️ 彻底删除选中的 ${urls.length} 张图片及其 OSS 文件？\n不可恢复。`)) return;
    } else if (confirmEnabled && !confirm(`将选中的 ${urls.length} 张图片移入回收站？（可恢复）`)) {
      return;
    }
    const r = await api.deleteBatch(characterName, urls, hard);
    if (r.status !== 'ok') { alert(`Failed: ${r.message || 'unknown error'}`); return; }
    setHidden(prev => { const n = new Set(prev); urls.forEach(u => n.add(u)); return n; });
    exitSelect();
    onRefresh();
  };

  const [pushing, setPushing] = useState(false);
  const batchPushModelArk = async () => {
    const urls = [...selected];
    if (!urls.length) return;
    setPushing(true);
    const r = await api.pushToModelArk(characterName, urls);
    setPushing(false);
    if (r.status !== 'ok') { alert(`推送失败: ${r.message || '未知错误'}`); return; }
    const results = r.results || [];
    const active = results.filter(x => x.status === 'Active').length;
    const proc = results.filter(x => x.ok && x.status !== 'Active').length;
    const fail = results.filter(x => !x.ok).length;
    alert(`已推送到 ModelArk 人像库\n组: ${r.group_id}\nActive ${active} · 处理中 ${proc} · 失败 ${fail}`);
    exitSelect();
    onRefresh();
  };

  const batchSetTier = async (tier: 'paid' | 'free') => {
    const urls = [...selected];
    if (!urls.length) return;
    const r = await api.setTier(characterName, urls, tier);
    if (r.status !== 'ok') { alert(`Failed: ${r.message || 'unknown error'}`); return; }
    setHidden(prev => { const n = new Set(prev); urls.forEach(u => n.add(u)); return n; });
    exitSelect();
    onRefresh();
  };

  const handleDelete = useCallback(async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    if (confirmEnabled && !confirm('Move to trash? (recoverable)')) return;
    const r = await api.softDelete(characterName, url, false);
    if (r.status !== 'ok') { alert(`Failed: ${r.message || r.mode || 'unknown error'}`); return; }
    setHidden(prev => new Set(prev).add(url));
    onRefresh();
  }, [characterName, confirmEnabled, onRefresh]);

  const handleHardDelete = useCallback(async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    if (!confirm('⚠️ PERMANENTLY DELETE this image AND its OSS file?\nThis cannot be undone.')) return;
    const r = await api.softDelete(characterName, url, true);
    if (r.status !== 'ok') { alert(`Failed: ${r.message || r.mode || 'unknown error'}`); return; }
    setHidden(prev => new Set(prev).add(url));
    onRefresh();
  }, [characterName, onRefresh]);

  const handleStatusToggle = useCallback(async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const current = mediaStatusMap?.[url] || 'pending';
    const next = STATUS_CYCLE[current] || 'pending';
    await api.updateMediaStatus(characterId, url, next);
    onRefresh();
  }, [mediaStatusMap, characterId, onRefresh]);

  // single-image tier moves, no batch-select mode needed
  const handleSetPaid = useCallback(async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const r = await api.setTier(characterName, [url], 'paid');
    if (r.status !== 'ok') { alert(`Failed: ${r.message || 'unknown error'}`); return; }
    setHidden(prev => new Set(prev).add(url));
    onRefresh();
  }, [characterName, onRefresh]);

  const handleSetFree = useCallback(async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const r = await api.setTier(characterName, [url], 'free');
    if (r.status !== 'ok') { alert(`Failed: ${r.message || 'unknown error'}`); return; }
    setHidden(prev => new Set(prev).add(url));
    onRefresh();
  }, [characterName, onRefresh]);

  const handleSetAvatar = useCallback(async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const r = await api.setAvatar(characterId, url);
    if (r.status !== 'ok') { alert(`头像生成失败: ${r.message || '未知错误'}`); return; }
    alert(r.face_found ? '已设为角色头像 ✓' : '未检测到人脸,已用居中裁剪 ✓');
    onRefresh();
  }, [characterId, onRefresh]);

  if (!visible.length) return <div className="empty">No images</div>;

  return (
    <>
      <div className="media-toolbar">
        {!selectMode ? (
          <button className="mt-btn" onClick={() => setSelectMode(true)}>批量选择</button>
        ) : (
          <>
            <button className="mt-btn" onClick={selectAll}>全选</button>
            <button className="mt-btn" onClick={clearSel}>清空</button>
            <span className="mt-count">已选 {selected.size}/{images.length}</span>
            <button className="mt-btn mt-danger" disabled={!selected.size} onClick={() => batchDelete(false)}>批量删除(回收站)</button>
            {allowHardDelete && (
              <button className="mt-btn mt-danger" disabled={!selected.size} onClick={() => batchDelete(true)}>批量彻底删除</button>
            )}
            {tag === 'profile' && (
              <button className="mt-btn" disabled={!selected.size} onClick={() => batchSetTier('paid')}>设为付费 →</button>
            )}
            {tag === 'paid' && (
              <button className="mt-btn" disabled={!selected.size} onClick={() => batchSetTier('free')}>转为 Profile ←</button>
            )}
            {(tag === 'paid' || tag === 'profile') && (
              <button className="mt-btn" disabled={!selected.size || pushing} onClick={batchPushModelArk} title="把选中图上传到字节 ModelArk 私有人像库">
                {pushing ? '推送中…' : '→ ModelArk 人像库'}
              </button>
            )}
            <button className="mt-btn" onClick={exitSelect}>退出</button>
          </>
        )}
      </div>
      <div className="media-grid">
        {shown.map(img => (
          <MediaCard
            key={img}
            img={img}
            tag={tag}
            status={mediaStatusMap?.[img] || 'pending'}
            selectMode={selectMode}
            isSel={selected.has(img)}
            onImageClick={onImageClick}
            onToggleSel={toggleSel}
            onStatusToggle={handleStatusToggle}
            onDelete={handleDelete}
            onHardDelete={handleHardDelete}
            onSetPaid={handleSetPaid}
            onSetFree={handleSetFree}
            onSetAvatar={handleSetAvatar}
            allowHardDelete={allowHardDelete}
          />
        ))}
      </div>
      {limit < visible.length && (
        <div ref={sentinelRef} className="media-more">加载更多… {shown.length}/{visible.length}</div>
      )}
    </>
  );
}
