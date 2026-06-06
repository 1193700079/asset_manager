import { useState, useEffect, useCallback } from 'react';
import type { CharacterIndex } from '../types';
import { api } from '../api/client';
import MediaGrid from './MediaGrid';
import VideoGrid from './VideoGrid';
import TrashSection from './TrashSection';
import ReferenceLibrary from './ReferenceLibrary';
import GeneratePanel from './GeneratePanel';
import Modal from './Modal';
import './CharacterDetail.css';

interface Props {
  name: string;
  data: CharacterIndex;
  onRefresh: () => void;
  confirmEnabled: boolean;
}

interface AudioCandidate {
  id: number;
  filename: string;
  category: string;
  duration: number;
  oss_url: string;
  status: string;
}

export default function CharacterDetail({ name, data, onRefresh, confirmEnabled }: Props) {
  const [modalUrl, setModalUrl] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [showGen, setShowGen] = useState(false);
  const [voiceUrl, setVoiceUrl] = useState(data.voice_id || '');
  const [savingVoice, setSavingVoice] = useState(false);
  const [audioCandidates, setAudioCandidates] = useState<AudioCandidate[]>([]);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [showManualVoice, setShowManualVoice] = useState(false);

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
            <div className="char-voice">
              <label>默认音频</label>
              {voiceUrl.trim() && voiceUrl.startsWith('http') && (
                <div className="char-voice-current">
                  <audio src={voiceUrl.trim()} controls preload="none" />
                  <span className="vc-status-tag online">已上线</span>
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
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="pending-adopt-all" onClick={async () => {
                if (confirmEnabled && !confirm(`全部采用 ${data.pending_media.length} 张到 Profile？`)) return;
                await api.pendingAdoptAll(data.id);
                onRefresh();
              }}>全部采用</button>
              <button className="pending-del-all" onClick={async () => {
                if (!confirm(`⚠️ 彻底删除全部 ${data.pending_media.length} 张待选图？不可恢复。`)) return;
                await api.pendingDeleteAll(data.id);
                onRefresh();
              }}>全部删除</button>
            </div>
          </div>
          <div className="pending-grid">
            {data.pending_media.map(pm => (
              <div key={pm.url} className="pending-card">
                {pm.type === 'video' ? (
                  <video src={pm.url} controls preload="none" />
                ) : (
                  <img src={pm.url} loading="lazy" onClick={() => setModalUrl(pm.url)} />
                )}
                {pm.source && <div className="pending-source">{pm.source}</div>}
                <div className="pending-actions">
                  <button className="pending-adopt" onClick={async () => {
                    await api.updateMediaStatus(data.id, pm.url, 'online');
                    onRefresh();
                  }}>采用</button>
                  <button className="pending-discard" onClick={async () => {
                    if (confirmEnabled && !confirm('移到回收站？(可恢复)')) return;
                    await api.softDelete(name, pm.url, false);
                    onRefresh();
                  }}>丢弃</button>
                  <button className="pending-harddel" onClick={async () => {
                    if (!confirm('⚠️ 彻底删除这张图及其 OSS 文件？不可恢复。')) return;
                    const r = await api.softDelete(name, pm.url, true);
                    if (r.status !== 'ok') alert(`失败: ${r.mode || '未知错误'}`);
                    onRefresh();
                  }}>彻底删除</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

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
      />

      <div className="section-title">Videos ({data.profile_videos.length})</div>
      <VideoGrid videos={data.profile_videos} characterName={name} characterId={data.id} onRefresh={onRefresh} mediaStatusMap={data.media_status_map} confirmEnabled={confirmEnabled} />

      <div className="section-title">Generated Images</div>
      <MediaGrid
        images={data.generated_images}
        tag="generated"
        characterName={name}
        characterId={data.id}
        onImageClick={setModalUrl}
        onRefresh={onRefresh}
        mediaStatusMap={data.media_status_map}
        confirmEnabled={confirmEnabled}
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
