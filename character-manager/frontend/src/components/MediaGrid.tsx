import { api } from '../api/client';
import './MediaGrid.css';

interface Props {
  images: string[];
  tag: string;
  characterName: string;
  onImageClick: (url: string) => void;
  onRefresh: () => void;
}

export default function MediaGrid({ images, tag, characterName, onImageClick, onRefresh }: Props) {
  if (!images.length) return <div className="empty">No images</div>;

  const handleDelete = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    if (!confirm('Move to trash?')) return;
    await api.softDelete(characterName, url);
    onRefresh();
  };

  return (
    <div className="media-grid">
      {images.map((img, i) => {
        const fname = img.split('/').pop()?.split('?')[0] || '';
        return (
          <div key={`${img}-${i}`} className="media-card">
            <div className="card-badge">{tag}</div>
            <button className="card-del" onClick={e => handleDelete(e, img)}>✕</button>
            <img
              src={img}
              loading="lazy"
              onClick={() => onImageClick(img)}
              onError={e => {
                (e.target as HTMLImageElement).src =
                  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="%2316213e" width="200" height="200"/><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="12">Load Failed</text></svg>';
              }}
            />
            <div className="card-name">{fname}</div>
          </div>
        );
      })}
    </div>
  );
}
