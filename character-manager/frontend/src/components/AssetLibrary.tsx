import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ossResize } from './MediaGrid';
import type { TagCloud, VFESearchItem } from '../types';
import { api } from '../api/client';
import Modal from './Modal';
import './AssetLibrary.css';

const PAGE_SIZE = 50;

const DIM_LABELS: Record<string, string> = {
  '01_scene': '场景', '02_shot': '镜头', '03_nudity': '裸露', '04_clothing': '服装',
  '05_lighting': '光影', '06_pose': '姿势', '07_expression': '表情', '08_style': '风格',
  '09_makeup': '妆容', '10_hair': '发型', '11_skin': '皮肤', '12_tattoo': '纹身',
  '13_props': '道具', '14_persona': '人设',
};

const DIM_PRIORITY = ['01_scene', '06_pose', '04_clothing'];

const MAX_COLLAPSED = 8;

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
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedDims, setExpandedDims] = useState<Set<string>>(new Set());
  const [dimSearch, setDimSearch] = useState<Record<string, string>>({});
  const [fullDimTags, setFullDimTags] = useState<Record<string, { tag: string; count: number }[]>>({});
  const [dimLoading, setDimLoading] = useState<Set<string>>(new Set());
  const [currentOffset, setCurrentOffset] = useState(0);
  const [materialType, setMaterialType] = useState<'spicy' | 'normal'>('spicy');
  const resultsRef = useRef<HTMLDivElement>(null);

  // --- Load tag cloud (lightweight, min_count=3); re-runs on library switch ---
  useEffect(() => {
    setLoading(true);
    api.getTagCloud(3, materialType)
      .then(data => {
        if (data.error) setError('标签云加载失败: ' + data.error);
        setTagCloud(data);
      })
      .catch(e => setError('无法连接后端: ' + e.message))
      .finally(() => setLoading(false));
  }, [materialType]);

  // --- Switch between the normal / NSFW asset libraries ---
  const switchMaterial = (mt: 'spicy' | 'normal') => {
    if (mt === materialType) return;
    setActiveFilters([]);
    setResults([]);
    setTotalResults(0);
    setExpandedDims(new Set());
    setFullDimTags({});
    setDimSearch({});
    setCurrentOffset(0);
    setSearchQuery('');
    setError(null);
    setTagCloud(null);
    setMaterialType(mt);
  };

  // --- Lazy load full tags for a dimension when expanding ---
  const expandDim = async (dim: string) => {
    if (expandedDims.has(dim)) return;
    setDimLoading(prev => new Set(prev).add(dim));
    try {
      const data = await api.getDimTags(dim, 1, materialType);
      if (data.tags.length > 0) {
        setFullDimTags(prev => ({ ...prev, [dim]: data.tags }));
      }
    } catch {
      // silent fail, fall back to trimmed tags from initial load
    }
    setDimLoading(prev => { const next = new Set(prev); next.delete(dim); return next; });
    setExpandedDims(prev => new Set(prev).add(dim));
  };

  // --- Search / filter ---
  const loadImages = useCallback(async (filter: { dim: string; tag: string }, offset = 0, append = false) => {
    if (offset === 0) {
      setLoadingResults(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const data = await api.searchAssetLibrary({
        dimension: filter.dim,
        tag: filter.tag,
        limit: PAGE_SIZE,
        offset,
        materialType,
      });
      const items = data.items || [];
      if (append) {
        setResults(prev => [...prev, ...items]);
      } else {
        setResults(items);
      }
      setTotalResults(data.total ?? items.length);
      setCurrentOffset(offset + items.length);
    } catch (e: any) {
      if (append) {
        alert('加载更多失败: ' + e.message);
      } else {
        setResults([]);
        setTotalResults(0);
      }
    } finally {
      setLoadingResults(false);
      setLoadingMore(false);
    }
  }, [materialType]);

  const toggleFilter = (dim: string, tag: string) => {
    const idx = activeFilters.findIndex(f => f.dim === dim && f.tag === tag);
    let newFilters: { dim: string; tag: string }[];
    if (idx >= 0) {
      // Removing this filter
      newFilters = activeFilters.filter((_, i) => i !== idx);
      setActiveFilters(newFilters);
      if (newFilters.length > 0) {
        // Use the LAST remaining filter (most recently added)
        const last = newFilters[newFilters.length - 1]!;
        setCurrentOffset(0);
        loadImages(last);
      } else {
        setResults([]);
        setTotalResults(0);
        setCurrentOffset(0);
      }
    } else {
      // Adding a new filter — this becomes the active search
      newFilters = [...activeFilters, { dim, tag }];
      setActiveFilters(newFilters);
      setCurrentOffset(0);
      loadImages({ dim, tag });
    }
  };

  const handleLoadMore = () => {
    if (activeFilters.length === 0 || loadingMore) return;
    const lastFilter = activeFilters[activeFilters.length - 1]!;
    loadImages(lastFilter, currentOffset, true);
  };

  // --- Close expanded dimension (no API call needed) ---
  const collapseDim = (dim: string) => {
    setExpandedDims(prev => { const next = new Set(prev); next.delete(dim); return next; });
    setDimSearch(prev => ({ ...prev, [dim]: '' }));
  };

  // --- Copy / delete ---
  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
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

  // --- Computed: filtered dims by global search (memoized) ---
  const filteredDims = useMemo(() => {
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
  }, [tagCloud, searchQuery]);

  const priorityDims = DIM_PRIORITY.filter(d => filteredDims[d]);
  const otherDims = Object.keys(filteredDims).filter(d => !DIM_PRIORITY.includes(d)).sort();
  const hasMore = currentOffset < totalResults;

  return (
    <div className="lib-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lib-panel">
        <div className="lib-header">
          <h2>素材库</h2>
          <div className="lib-mat-toggle cv-pi-segment">
            <button
              className={`cv-pi-segment-item ${materialType === 'spicy' ? 'cv-pi-segment-item--active' : ''}`}
              onClick={() => switchMaterial('spicy')}
            >NSFW</button>
            <button
              className={`cv-pi-segment-item ${materialType === 'normal' ? 'cv-pi-segment-item--active' : ''}`}
              onClick={() => switchMaterial('normal')}
            >正常</button>
          </div>
          <span className="lib-total">
            {tagCloud ? (
              tagCloud._full_count
                ? `${tagCloud.total_images} 张已标注素材 · ${tagCloud._shown_count} / ${tagCloud._full_count} 个标签 (展开维度加载全部)`
                : `${tagCloud.total_images} 张已标注素材 · ${Object.values(tagCloud.dimensions).reduce((s, t) => s + t.length, 0)} 个标签`
            ) : 'Loading...'}
          </span>
          <button className="lib-close" onClick={onClose}>✕ 关闭</button>
        </div>

        {error && (
          <div className="lib-error">
            ⚠ {error}
            <button onClick={() => setError(null)} className="lib-error-dismiss">✕</button>
          </div>
        )}

        <div className="lib-search">
          <input
            placeholder="搜索标签 (中英文)..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="lib-loading">
            <div className="lib-spinner" />
            <span>加载标签云中...</span>
          </div>
        ) : (
          <>
            {priorityDims.length > 0 && (
              <div className="lib-dim-section">
                <div className="lib-dim-label priority">★ 高优先维度</div>
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
            {priorityDims.length === 0 && otherDims.length === 0 && (
              <div className="empty">无匹配标签</div>
            )}
          </>
        )}

        {activeFilters.length > 0 && (
          <div className="lib-filters">
            <span>筛选:</span>
            {activeFilters.map((f, i) => {
              const isLast = i === activeFilters.length - 1;
              return (
                <span
                  key={i}
                  className={`filter-chip ${isLast ? 'filter-chip-active' : ''}`}
                  onClick={() => toggleFilter(f.dim, f.tag)}
                  title={isLast ? '当前搜索条件 (点击移除)' : '点击移除'}
                >
                  {DIM_LABELS[f.dim] || f.dim}: {f.tag} ✕
                </span>
              );
            })}
            {activeFilters.length > 1 && (
              <span className="lib-filters-hint">
                搜索: {activeFilters[activeFilters.length - 1]!.tag}
              </span>
            )}
          </div>
        )}

        {loadingResults && (
          <div className="lib-loading">
            <div className="lib-spinner" />
            <span>搜索中...</span>
          </div>
        )}

        {!loadingResults && results.length > 0 && (
          <>
            <div className="lib-results-header">
              显示 {results.length} / {totalResults} 张匹配
            </div>
            <div className="lib-results" ref={resultsRef}>
              {results.map((item, i) => {
                const imgUrl = item.image_url;
                const dimTags = Object.entries(item.dimensions || {})
                  .flatMap(([, tags]) => (Array.isArray(tags) ? tags.slice(0, 2) : []));
                const promptId = `prompt-${i}`;
                const urlId = `url-${i}`;
                return (
                  <div key={`${item.video_path}-${i}`} className="lib-card">
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
                      src={ossResize(imgUrl, 400, 70)}
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

            {hasMore && (
              <div className="lib-load-more-wrap">
                <button
                  className="lib-load-more"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <><div className="lib-spinner lib-spinner-sm" /> 加载中...</>
                  ) : (
                    <>加载更多 ({totalResults - currentOffset} 张剩余)</>
                  )}
                </button>
              </div>
            )}
          </>
        )}

        {activeFilters.length > 0 && results.length === 0 && !loadingResults && (
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
    const isExpanded = expandedDims.has(dim);
    const isLoading = dimLoading.has(dim);
    // Use full tags if loaded, otherwise use trimmed tags from initial fetch
    const allTags = fullDimTags[dim] || tags;
    const localQ = (dimSearch[dim] || '').toLowerCase();
    const displayTags = isExpanded
      ? (localQ ? allTags.filter(t => t.tag.toLowerCase().includes(localQ)) : allTags)
      : tags.slice(0, MAX_COLLAPSED);
    const hiddenCount = allTags.length - MAX_COLLAPSED;

    return (
      <span key={dim} className={`lib-dim-group ${isExpanded ? 'lib-dim-group-expanded' : ''}`}>
        <span className="lib-dim-prefix">{label}:</span>
        {!isExpanded && hiddenCount > 0 && (
          <span className="lib-tag-expand" onClick={() => expandDim(dim)}>
            {isLoading ? (
          <><div className="lib-spinner lib-spinner-sm" /> 加载中</>
            ) : (
          <>+{hiddenCount} 展开</>
            )}
          </span>
        )}
        {isExpanded && (
          <span className="lib-dim-toolbar" onClick={e => e.stopPropagation()}>
            <span className="lib-tag-collapse" onClick={() => collapseDim(dim)}>
              收起 ▲
            </span>
            <input
              className="lib-dim-search"
              placeholder={`在 ${label} 中搜索...`}
              value={dimSearch[dim] || ''}
              onChange={e => setDimSearch(prev => ({ ...prev, [dim]: e.target.value }))}
            />
            <span className="lib-dim-expand-count">{displayTags.length} / {allTags.length}</span>
          </span>
        )}
        {displayTags.map(t => {
          const isActive = activeFilters.some(f => f.dim === dim && f.tag === t.tag);
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
      </span>
    );
  }
}
