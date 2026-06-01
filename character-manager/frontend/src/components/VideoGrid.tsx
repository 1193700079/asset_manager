import { useRef } from 'react';
import './VideoGrid.css';

interface Props {
  videos: string[];
}

export default function VideoGrid({ videos }: Props) {
  if (!videos.length) return <div className="empty">No videos</div>;

  return (
    <div className="video-grid">
      {videos.map((url, i) => {
        const fname = url.split('/').pop()?.split('?')[0] || '';
        return (
          <VideoCard key={`${url}-${i}`} url={url} fname={fname} />
        );
      })}
    </div>
  );
}

function VideoCard({ url, fname }: { url: string; fname: string }) {
  const vidRef = useRef<HTMLVideoElement>(null);

  return (
    <div className="video-card">
      <div className="card-badge">video</div>
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
