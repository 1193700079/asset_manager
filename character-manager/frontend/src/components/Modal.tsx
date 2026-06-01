import './Modal.css';

interface Props {
  url: string;
  onClose: () => void;
}

export default function Modal({ url, onClose }: Props) {
  const isVideo = /\.(mp4|webm|mov|avi)(\?|$)/i.test(url);

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="modal-close" onClick={onClose}>Close</button>
      <div className="modal-content">
        {isVideo ? (
          <video src={url} controls autoPlay />
        ) : (
          <img src={url} />
        )}
      </div>
    </div>
  );
}
