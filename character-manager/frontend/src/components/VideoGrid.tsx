import { useRef } from 'react';
import { api } from '../api/client';
import './VideoGrid.css';

interface Props {
  videos: string[];
  characterName: string;
  characterId: number;
  mediaStatusMap?: Record<string, string>;
  confirmEnabled: boolean;
}

export default function VideoGrid({ videos, characterName, characterId, onRefresh, mediaStatusMap, confirmEnabled }: Props & { onRefresh: () => void }) {
  if (!videos.length) return <div className="empty">No videos</div>;

  const handleDelete = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    if (confirmEnabled && !confirm('Move video to trash? (recoverable)')) return;
    await api.softDelete(characterName, url, false);
    onRefresh();
  };

  const handleHardDelete = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    // 彻底删除（不可恢复）始终保留确认，不受开关影响
    if (!confirm('⚠️ PERMANENTLY DELETE this video AND its OSS file?\nThis cannot be undone.')) return;
    const r = await api.softDelete(characterName, url, true);
    if (r.status !== 'ok') alert(`Failed: ${r.mode || 'unknown error'}`);
    onRefresh();
  };

  const handleStatusToggle = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const cycle: Record<string, string> = { pending: 'online', online: 'pre_release', pre_release: 'pending' };
    const current = mediaStatusMap?.[url] || 'pending';
    const next = cycle[current] || 'pending';
    await api.updateMediaStatus(characterId, url, next);
    onRefresh();
  };

  const statusIcons: Record<string, string> = { online: '🟢', pre_release: '🟡', pending: '⚪' };

  return (
    <div className="video-grid">
      {videos.map((url, i) => {
        const fname = url.split('/').pop()?.split('?')[0] || '';
        const status = mediaStatusMap?.[url] || 'pending';
        return (
          <VideoCard key={`${url}-${i}`} url={url} fname={fname} status={status}
            onDelete={(e) => handleDelete(e, url)}
            onHardDelete={(e) => handleHardDelete(e, url)}
            onStatusToggle={(e) => handleStatusToggle(e, url)}
            statusIcon={statusIcons[status] || '⚪'}
          />
        );
      })}
    </div>
  );
}

function VideoCard({ url, fname, status, onDelete, onHardDelete, onStatusToggle, statusIcon }: {
  url: string; fname: string; status: string;
  onDelete: (e: React.MouseEvent) => void;
  onHardDelete: (e: React.MouseEvent) => void;
  onStatusToggle: (e: React.MouseEvent) => void;
  statusIcon: string;
}) {
  const vidRef = useRef<HTMLVideoElement>(null);

  return (
    <div className={`video-card media-status-${status}`}>
      <div className="card-badge">video</div>
      <button className="card-status-btn" onClick={onStatusToggle} title={`状态: ${status}`}>{statusIcon}</button>
    <button className="card-del" onClick={onDelete} title="Move to trash (recoverable)">✕</button>
    <button className="card-hard-del" onClick={onHardDelete} title="Permanent delete (DB + OSS)">🗑</button>
      <video
        ref={vidRef}
        src={url}
        muted
        preload="metadata"
        onMouseEnter={() => vidRef.current?.play()}
        onMouseLeave={() => {
          if (vidRef.current) {
            vidRef.current.pause();
            vidRef.current.currentTime = 0;
          }
        }}
        onClick={() => window.open(url, '_blank')}
      />
      <div className="card-name">{fname}</div>
    </div>
  );
}
