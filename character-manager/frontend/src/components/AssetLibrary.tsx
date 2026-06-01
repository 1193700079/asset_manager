import { useState, useEffect } from 'react';
import type { TagCloud, VFESearchItem } from '../types';
import { api } from '../api/client';
import Modal from './Modal';
import './AssetLibrary.css';

const VFE_BASE = 'http://localhost:3001';

const DIM_LABELS: Record<string, string> = {
  '01_scene': '场景', '02_shot': '镜头', '03_nudity': '裸露', '04_clothing': '服装',
  '05_lighting': '光影', '06_pose': '姿势', '07_expression': '表情', '08_style': '风格',
  '09_makeup': '妆容', '10_hair': '发型', '11_skin': '皮肤', '12_tattoo': '纹身',
  '13_props': '道具', '14_persona': '人设',
};

const DIM_PRIORITY = ['01_scene', '06_pose', '04_clothing'];

interface Props {
  onClose: () => void;
}

export default function AssetLibrary({ onClose }: Props) {
  const [tagCloud, setTagCloud] = useState<TagCloud | null>(null);
  const [activeFilters, setActiveFilters] = useState<{ dim: string; tag: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<VFESearchItem[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [modalUrl, setModalUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    api.getTagCloud()
      .then(setTagCloud)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleFilter = (dim: string, tag: string) => {
    const idx = activeFilters.findIndex(f => f.tag === tag);
    let newFilters: { dim: string; tag: string }[];
    if (idx >= 0) {
      newFilters = activeFilters.filter((_, i) => i !== idx);
    } else {
      newFilters = [...activeFilters, { dim, tag }];
    }
    setActiveFilters(newFilters);
    if (newFilters.length > 0) {
      loadImages(newFilters[0]!);
    } else {
      setResults([]);
      setTotalResults(0);
    }
  };

  const loadImages = async (filter: { dim: string; tag: string }) => {
    try {
      const data = await api.searchAssetLibrary({
        dimension: filter.dim,
        tag: filter.tag,
        limit: 50,
      });
      setResults(data.items || []);
      setTotalResults(data.total);
    } catch {
      setResults([]);
    }
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  const handleDelete = async (item: VFESearchItem) => {
    if (!confirm(`确认删除此素材？\n${item.video_name}\n\n该操作会将素材移入 VFE 人工删除区。`)) return;
    try {
      const res = await api.skipVFEImage(item.video_path);
      if (res.success) {
        setResults(prev => prev.filter(r => r.video_path !== item.video_path));
        setTotalResults(prev => prev - 1);
      } else {
        alert('删除失败: ' + (res.error || '未知错误'));
      }
    } catch (e: any) {
      alert('删除失败: ' + e.message);
    }
  };

  const filteredDims = (() => {
    if (!tagCloud) return {};
    const dims = tagCloud.dimensions;
    if (!searchQuery) return dims;
    const q = searchQuery.toLowerCase();
    const filtered: Record<string, { tag: string; count: number }[]> = {};
    for (const [dim, tags] of Object.entries(dims)) {
      const matched = tags.filter(t => t.tag.toLowerCase().includes(q));
      if (matched.length) filtered[dim] = matched;
    }
    return filtered;
  })();

  const priorityDims = DIM_PRIORITY.filter(d => filteredDims[d]);
  const otherDims = Object.keys(filteredDims).filter(d => !DIM_PRIORITY.includes(d)).sort();

  return (
    <div className="lib-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lib-panel">
        <div className="lib-header">
          <h2>素材库</h2>
          <span className="lib-total">
            {tagCloud ? `${tagCloud.total_images} 张已标注素材` : 'Loading...'}
          </span>
          <button className="lib-close" onClick={onClose}>✕ 关闭</button>
        </div>

        <div className="lib-search">
          <input
            placeholder="搜索标签 (中英文)..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="empty">加载中...</div>
        ) : (
          <>
            {priorityDims.length > 0 && (
              <div className="lib-dim-section">
                <div className="lib-dim-label priority">★ 高优先</div>
                <div className="lib-tags">
                  {priorityDims.map(dim => renderDimGroup(dim, filteredDims[dim]!))}
                </div>
              </div>
            )}
            {otherDims.length > 0 && (
              <div className="lib-dim-section">
                <div className="lib-dim-label">其他维度</div>
                <div className="lib-tags">
                  {otherDims.map(dim => renderDimGroup(dim, filteredDims[dim]!))}
                </div>
              </div>
            )}
          </>
        )}

        {activeFilters.length > 0 && (
          <div className="lib-filters">
            <span>筛选:</span>
            {activeFilters.map((f, i) => (
              <span key={i} className="filter-chip" onClick={() => toggleFilter(f.dim, f.tag)}>
                {f.tag} ✕
              </span>
            ))}
          </div>
        )}

        {results.length > 0 && (
          <>
            <div className="lib-results-header">{totalResults} 张匹配</div>
            <div className="lib-results">
              {results.map((item, i) => {
                const imgUrl = VFE_BASE + item.image_url;
                const dimTags = Object.entries(item.dimensions || {})
                  .flatMap(([, tags]) => (Array.isArray(tags) ? tags.slice(0, 2) : []));
                const promptId = `prompt-${i}`;
                const urlId = `url-${i}`;
                return (
                  <div key={i} className="lib-card">
                    <div className="lib-card-actions">
                      {item.prompt && (
                        <button
                          className={`lib-card-btn ${copiedId === promptId ? 'copied' : ''}`}
                          onClick={() => handleCopy(item.prompt!, promptId)}
                          title="复制提示词"
                        >
                          {copiedId === promptId ? '✓' : '📋'} Prompt
                        </button>
                      )}
                      <button
                        className={`lib-card-btn ${copiedId === urlId ? 'copied' : ''}`}
                        onClick={() => handleCopy(imgUrl, urlId)}
                        title="复制图片 URL"
                      >
                        {copiedId === urlId ? '✓' : '🔗'} URL
                      </button>
                      <button
                        className="lib-card-btn lib-card-del"
                        onClick={() => handleDelete(item)}
                        title="删除素材"
                      >
                        🗑
                      </button>
                    </div>
                    <img
                      src={imgUrl}
                      loading="lazy"
                      onClick={() => setModalUrl(imgUrl)}
                    />
                    <div className="lib-card-info">
                      {item.prompt && <div className="lib-card-prompt">{item.prompt}</div>}
                      {item.description && <div className="lib-card-desc">{item.description}</div>}
                      <div className="lib-card-dims">
                        {dimTags.map((t, j) => (
                          <span key={j} className="lib-card-dim-tag">{t}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {activeFilters.length > 0 && results.length === 0 && (
          <div className="empty">无匹配素材</div>
        )}
        {activeFilters.length === 0 && !loading && (
          <div className="empty">点击标签筛选素材</div>
        )}
      </div>

      {modalUrl && <Modal url={modalUrl} onClose={() => setModalUrl(null)} />}
    </div>
  );

  function renderDimGroup(dim: string, tags: { tag: string; count: number }[]) {
    const label = DIM_LABELS[dim] || dim;
    const maxShow = 8;
    return (
      <span key={dim} className="lib-dim-group">
        <span className="lib-dim-prefix">{label}:</span>
        {tags.slice(0, maxShow).map(t => {
          const isActive = activeFilters.some(f => f.tag === t.tag);
          return (
            <span
              key={t.tag}
              className={`lib-tag ${isActive ? 'active' : ''}`}
              onClick={() => toggleFilter(dim, t.tag)}
            >
              {t.tag}<span className="tag-count">{t.count}</span>
            </span>
          );
        })}
        {tags.length > maxShow && (
          <span className="lib-tag-more">+{tags.length - maxShow}</span>
        )}
      </span>
    );
  }
}
