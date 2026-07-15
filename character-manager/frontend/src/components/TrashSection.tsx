import { useState } from 'react';
import { api } from '../api/client';
import { thumb } from './MediaGrid';

interface Props {
  images: string[];
  videos: string[];
  characterName: string;
  onImageClick: (url: string) => void;
  onRefresh: () => void;
}

const IMG_ERR =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="%2316213e" width="200" height="200"/><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="12">Load Failed</text></svg>';

export default function TrashSection({ images, videos, characterName, onImageClick, onRefresh }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const vImages = images.filter(u => !hidden.has(u));
  const vVideos = videos.filter(u => !hidden.has(u));
  const all = [...vImages, ...vVideos];
  if (!all.length) return <div className="empty">Trash is empty</div>;

  const toggle = (url: string) =>
    setSelected(prev => { const n = new Set(prev); if (n.has(url)) n.delete(url); else n.add(url); return n; });

  const restoreOne = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    await api.restore(characterName, url);
    setHidden(prev => new Set(prev).add(url));
    onRefresh();
  };

  const restoreSelected = async () => {
    const urls = [...selected];
    if (!urls.length) return;
    const r = await api.restoreBatch(characterName, urls);
    if (r.status !== 'ok') { alert(`失败: ${r.message || '未知错误'}`); return; }
    setHidden(prev => { const n = new Set(prev); urls.forEach(u => n.add(u)); return n; });
    setSelected(new Set());
    onRefresh();
  };

  const card = (url: string, i: number) => {
    const fname = url.split('/').pop()?.split('?')[0] || '';
    const isVideo = /\.(mp4|webm|mov|avi)(\?|$)/i.test(fname);
    const sel = selected.has(url);
    return (
      <div key={`${url}-${i}`} className={`media-card trashed${sel ? ' selected' : ''}`}>
        <input
          type="checkbox"
          className="card-check"
          checked={sel}
          onChange={() => toggle(url)}
          onClick={e => e.stopPropagation()}
        />
        <div className="card-badge">trashed</div>
        <button className="card-restore" onClick={e => restoreOne(e, url)} title="恢复到末尾">+</button>
        {isVideo ? (
          <video src={url} muted preload="metadata" onClick={() => window.open(url, '_blank')} />
        ) : (
          <img
            src={thumb(url)}
            loading="lazy"
            onClick={() => onImageClick(url)}
            onError={e => { (e.target as HTMLImageElement).src = IMG_ERR; }}
          />
        )}
        <div className="card-name">{fname}</div>
      </div>
    );
  };

  return (
    <>
      <div className="media-toolbar">
        <button className="mt-btn" onClick={() => setSelected(new Set(all))}>全选</button>
        <button className="mt-btn" onClick={() => setSelected(new Set())}>清空</button>
        <span className="mt-count">已选 {selected.size}/{all.length}</span>
        <button className="mt-btn" disabled={!selected.size} onClick={restoreSelected}>批量恢复 ↩</button>
      </div>

      <div className="trash-subtitle">图片 ({vImages.length})</div>
      {vImages.length ? <div className="media-grid">{vImages.map(card)}</div> : <div className="empty">无</div>}

      <div className="trash-subtitle">视频 ({vVideos.length})</div>
      {vVideos.length ? <div className="media-grid">{vVideos.map(card)}</div> : <div className="empty">无</div>}
    </>
  );
}
