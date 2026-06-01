import { api } from '../api/client';

interface Props {
  items: string[];
  characterName: string;
  onImageClick: (url: string) => void;
  onRefresh: () => void;
}

export default function TrashSection({ items, characterName, onImageClick, onRefresh }: Props) {
  if (!items.length) return <div className="empty">Trash is empty</div>;

  const handleRestore = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    await api.restore(characterName, url);
    onRefresh();
  };

  return (
    <div className="media-grid">
      {items.map((url, i) => {
        const fname = url.split('/').pop()?.split('?')[0] || '';
        const isVideo = /\.(mp4|webm|mov|avi)$/i.test(fname);
        return (
          <div key={`${url}-${i}`} className="media-card trashed">
            <div className="card-badge">trashed</div>
            <button className="card-restore" onClick={e => handleRestore(e, url)}>+</button>
            {isVideo ? (
              <video
                src={url}
                muted
                preload="metadata"
                onClick={() => window.open(url, '_blank')}
              />
            ) : (
              <img
                src={url}
                loading="lazy"
                onClick={() => onImageClick(url)}
                onError={e => {
                  (e.target as HTMLImageElement).src =
                    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="%2316213e" width="200" height="200"/><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="12">Load Failed</text></svg>';
                }}
              />
            )}
            <div className="card-name">{fname}</div>
          </div>
        );
      })}
    </div>
  );
}
