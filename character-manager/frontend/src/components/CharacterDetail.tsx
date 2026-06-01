import { useState } from 'react';
import type { CharacterIndex } from '../types';
import { api } from '../api/client';
import MediaGrid from './MediaGrid';
import VideoGrid from './VideoGrid';
import TrashSection from './TrashSection';
import ReferenceLibrary from './ReferenceLibrary';
import Modal from './Modal';
import './CharacterDetail.css';

interface Props {
  name: string;
  data: CharacterIndex;
  onRefresh: () => void;
}

export default function CharacterDetail({ name, data, onRefresh }: Props) {
  const [modalUrl, setModalUrl] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  const attrs = Object.entries(data.attributes || {})
    .filter(([, v]) => v)
    .map(([k, v]) => ({ key: k, value: v }));

  const trashCount = data.trash_all.length;

  return (
    <div className="char-detail">
      <div className="char-header">
        <h1>{name}</h1>
        <div className="char-desc">{data.description}</div>
        <div className="char-attrs">
          {attrs.map(a => (
            <span key={a.key} className="attr-tag">{a.key}: {a.value}</span>
          ))}
        </div>
        <div className="char-stats">
          {data.profile_images.length} imgs + {data.profile_videos.length} videos + {data.generated_images.length} generated
          {trashCount > 0 ? ` | ${trashCount} in trash` : ''}
        </div>
      </div>

      <div className="section-title">Profile Images</div>
      <MediaGrid
        images={data.profile_images}
        tag="profile"
        characterName={name}
        onImageClick={setModalUrl}
        onRefresh={onRefresh}
      />

      <div className="section-title">Videos ({data.profile_videos.length})</div>
      <VideoGrid videos={data.profile_videos} />

      <div className="section-title">Generated Images</div>
      <MediaGrid
        images={data.generated_images}
        tag="generated"
        characterName={name}
        onImageClick={setModalUrl}
        onRefresh={onRefresh}
      />

      <ReferenceLibrary characterId={data.id} />

      <div className="section-title trash-title">
        <span>Trash ({trashCount})</span>
        <div className="trash-actions">
          <button
            className={`trash-toggle ${showTrash ? 'active' : ''}`}
            onClick={() => setShowTrash(!showTrash)}
          >{showTrash ? 'Hide' : 'Show'}</button>
          {trashCount > 0 && (
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
          items={data.trash_all}
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
