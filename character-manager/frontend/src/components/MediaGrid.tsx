import { api } from '../api/client';
import './MediaGrid.css';

const STATUS_CYCLE: Record<string, string> = { pending: 'online', online: 'pre_release', pre_release: 'pending' };
const STATUS_ICONS: Record<string, string> = { online: '🟢', pre_release: '🟡', pending: '⚪' };

interface Props {
  images: string[];
  tag: string;
  characterName: string;
  characterId: number;
  onImageClick: (url: string) => void;
  onRefresh: () => void;
  mediaStatusMap?: Record<string, string>;
}

export default function MediaGrid({ images, tag, characterName, characterId, onImageClick, onRefresh, mediaStatusMap }: Props) {
  if (!images.length) return <div className="empty">No images</div>;

  const handleDelete = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    if (!confirm('Move to trash? (recoverable)')) return;
    await api.softDelete(characterName, url, false);
    onRefresh();
  };

  const handleHardDelete = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    if (!confirm('⚠️ PERMANENTLY DELETE this image AND its OSS file?\nThis cannot be undone.')) return;
    const r = await api.softDelete(characterName, url, true);
    if (r.status !== 'ok') alert(`Failed: ${r.mode || 'unknown error'}`);
    onRefresh();
  };

  const handleStatusToggle = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const current = mediaStatusMap?.[url] || 'pending';
    const next = STATUS_CYCLE[current] || 'pending';
    await api.updateMediaStatus(characterId, url, next);
    onRefresh();
  };

  const handleSetAvatar = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const res = await api.setAvatar(characterId, url);
    if (res.status === 'ok') {
      alert(res.face_found ? '头像已生成（检测到人脸并居中）' : '已设为头像（未检测到人脸，使用居中裁剪）');
      onRefresh();
    } else {
      alert(`头像生成失败：${res.message || '未知错误'}`);
    }
  };

  return (
    <div className="media-grid">
      {images.map((img, i) => {
        const fname = img.split('/').pop()?.split('?')[0] || '';
        const status = mediaStatusMap?.[img] || 'pending';
        return (
          <div key={`${img}-${i}`} className={`media-card media-status-${status}`}>
            <div className="card-badge">{tag}</div>
            <button
              className="card-status-btn"
              onClick={e => handleStatusToggle(e, img)}
              title={`状态: ${status} → 点击切换`}
            >
              {STATUS_ICONS[status] || '⚪'}
            </button>
            <button className="card-del" onClick={e => handleDelete(e, img)} title="Move to trash (recoverable)">✕</button>
            <button className="card-hard-del" onClick={e => handleHardDelete(e, img)} title="Permanent delete (DB + OSS)">🗑</button>
            <button
              className="card-avatar-btn"
              onClick={e => handleSetAvatar(e, img)}
              title="设为头像（人脸居中裁剪）"
            >
              🙂
            </button>
            <img
              src={img}
              loading="lazy"
              onClick={() => onImageClick(img)}
              onError={e => {
                (e.target as HTMLImageElement).src =
                  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect fill="%2316213e" width="120" height="120"/><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10">Err</text></svg>';
              }}
            />
            <div className="card-name">{fname}</div>
          </div>
        );
      })}
    </div>
  );
}
