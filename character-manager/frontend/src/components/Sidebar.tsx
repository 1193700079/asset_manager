import { useState } from 'react';
import type { CharacterIndex, CategoryCount } from '../types';
import { ossResize } from './MediaGrid';
import './Sidebar.css';

interface Props {
  names: string[];
  index: Record<string, CharacterIndex>;
  categories: CategoryCount[];
  activeName: string | null;
  activeCat: string | null;
  searchQuery: string;
  dataSource: string;
  sources: string[];
  onDataSourceChange: (v: string) => void;
  onSelect: (name: string) => void;
  onCategoryChange: (cat: string | null) => void;
  onSearchChange: (q: string) => void;
  onRefresh: () => void;
  onOpenLibrary: () => void;
  onOpenGlobalBatch: () => void;
  onOpenBatchChar: () => void;
  onOpenCreate: () => void;
  onCreateCharacter: (data: { name: string; category?: string; description?: string }) => Promise<void>;
  onDeleteCharacter: (name: string) => Promise<void>;
  onClearCharacter: (name: string) => Promise<void>;
  confirmEnabled: boolean;
  onToggleConfirm: (enabled: boolean) => void;
}

export default function Sidebar({
  names, index, categories, activeName, activeCat,
  searchQuery, dataSource, sources, onDataSourceChange,
  onSelect, onCategoryChange, onSearchChange,
  onRefresh, onOpenLibrary, onOpenGlobalBatch, onOpenBatchChar, onOpenCreate,
  onCreateCharacter, onDeleteCharacter, onClearCharacter,
  confirmEnabled, onToggleConfirm,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', category: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'pending' | 'featured' | 'images' | 'category'>('name');
  const [onlyPending, setOnlyPending] = useState(false);

  const pendCount = (n: string) => index[n]?.pending_media?.length || 0;
  const displayNames = names
    .filter(n => !onlyPending || pendCount(n) > 0)
    .sort((a, b) => {
      const A = index[a]!, B = index[b]!;
      if (sortBy === 'pending') return pendCount(b) - pendCount(a) || a.localeCompare(b);
      if (sortBy === 'featured') return (B.featured ? 1 : 0) - (A.featured ? 1 : 0) || a.localeCompare(b);
      if (sortBy === 'images') return B.all_images.length - A.all_images.length || a.localeCompare(b);
      if (sortBy === 'category') return (A.category || '').localeCompare(B.category || '') || a.localeCompare(b);
      return a.localeCompare(b);
    });

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    setCreating(true);
    try {
      await onCreateCharacter({
        name: createForm.name.trim(),
        category: createForm.category.trim() || undefined,
        description: createForm.description.trim() || undefined,
      });
      setShowCreate(false);
      setCreateForm({ name: '', category: '', description: '' });
    } finally {
      setCreating(false);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, name });
  };

  const handleDelete = async () => {
    if (!ctxMenu) return;
    const name = ctxMenu.name;
    setCtxMenu(null);
    if (!confirm(`确定删除角色「${name}」吗？此操作为软删除，可恢复。`)) return;
    await onDeleteCharacter(name);
  };

  const handleClear = async () => {
    if (!ctxMenu) return;
    const name = ctxMenu.name;
    setCtxMenu(null);
    if (!confirm(`确定清空角色「${name}」的所有素材吗？（头像、图片、视频都会被清除，角色本身保留）`)) return;
    await onClearCharacter(name);
  };

  return (
    <div className="sidebar" onClick={() => setCtxMenu(null)}>
      {sources.length > 1 && (
        <div className="ds-select">
          <label>数据源</label>
          <select
            value={dataSource}
            onChange={e => onDataSourceChange(e.target.value)}
          >
            {sources.map(s => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
      )}
      <h2>Characters ({displayNames.length})</h2>
      <div className="sidebar-search">
        <input
          placeholder="Search..."
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
        />
      </div>
      <div className="cat-filter">
        <button
          className={`cat-btn ${activeCat === null ? 'active' : ''}`}
          onClick={() => onCategoryChange(null)}
        >All</button>
        {(() => {
          const featuredCount = Object.values(index).filter(c => c.featured).length;
          return featuredCount > 0 ? (
            <button
              className={`cat-btn ${activeCat === 'featured' ? 'active' : ''}`}
              onClick={() => onCategoryChange('featured')}
              style={{ borderColor: '#f1c40f', color: activeCat === 'featured' ? undefined : '#f1c40f' }}
            >★ 精品 ({featuredCount})</button>
          ) : null;
        })()}
        {(() => {
          const allTags = Array.from(new Set(Object.values(index).flatMap(c => c.tags || []))).sort();
          return allTags.map(t => (
            <button
              key={`tag:${t}`}
              className={`cat-btn ${activeCat === `tag:${t}` ? 'active' : ''}`}
              onClick={() => onCategoryChange(`tag:${t}`)}
              style={{ borderColor: '#4a9', color: activeCat === `tag:${t}` ? undefined : '#6cd' }}
            >#{t} ({Object.values(index).filter(c => (c.tags || []).includes(t)).length})</button>
          ));
        })()}
        {categories.map(c => (
          <button
            key={c.category}
            className={`cat-btn ${activeCat === c.category ? 'active' : ''}`}
            onClick={() => onCategoryChange(c.category)}
          >{c.category} ({c.count})</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 8px', fontSize: 12 }}>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}
          style={{ flex: 1, background: '#0e1526', color: '#cde', border: '1px solid #2a3550', borderRadius: 4, padding: '3px 4px' }}
          title="排序">
          <option value="name">按名称</option>
          <option value="pending">待选多优先</option>
          <option value="featured">精品优先</option>
          <option value="images">图片多优先</option>
          <option value="category">按分类分组</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, color: onlyPending ? '#f1c40f' : '#89a', cursor: 'pointer', whiteSpace: 'nowrap' }} title="只显示还有待选待审的角色">
          <input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} />
          有待选
        </label>
      </div>
      <div className="sidebar-toolbar">
        <button onClick={onRefresh}>Refresh</button>
        <button className="lib-btn" onClick={onOpenLibrary}>素材库</button>
        <button className="batch-btn" onClick={onOpenGlobalBatch}>批处理</button>
        <button className="gen-btn" onClick={onOpenBatchChar}>批量生成</button>
        <button className="add-btn" onClick={onOpenCreate}>+</button>
      </div>
      <div className="confirm-toggle-row">
        <label className="confirm-toggle" title="关闭后，丢弃 / 采用不再弹出确认（彻底删除不受影响）">
          <input
            type="checkbox"
            checked={confirmEnabled}
            onChange={e => onToggleConfirm(e.target.checked)}
          />
          <span className="confirm-toggle-slider" aria-hidden="true" />
          <span className="confirm-toggle-text">
            二次确认
            <span className="confirm-toggle-hint">
              {confirmEnabled ? '丢弃 / 采用需确认' : '点击即执行'}
            </span>
          </span>
        </label>
      </div>
      <div className="char-list">
        {(() => {
          let lastCat = '';
          return displayNames.map(n => {
            const c = index[n]!;
            const rawThumb = c.avatar_url || c.profile_images[0] || '';
            const thumb = rawThumb ? ossResize(rawThumb, 200, 70) : '';
            const total = c.all_images.length;
            const vcount = c.profile_videos.length;
            const trashCount = c.trash_all.length;
            const age = c.attributes?.Age ? `${c.attributes.Age} | ` : '';
            const pend = pendCount(n);
            const cat = c.category || 'uncategorized';
            const header = sortBy === 'category' && cat !== lastCat ? cat : null;
            lastCat = cat;
            return (
              <div key={n}>
                {header && (
                  <div style={{ padding: '8px 8px 2px', fontSize: 11, color: '#7fd', textTransform: 'uppercase', letterSpacing: 1 }}>{header}</div>
                )}
                <div
                  className={`char-item ${activeName === n ? 'active' : ''}`}
                  onClick={() => onSelect(n)}
                  onContextMenu={e => handleContextMenu(e, n)}
                >
                  {thumb && (
                    <img
                      className="char-thumb"
                      src={thumb}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div className="char-meta">
                    <div className="char-name">
                      {c.featured && <span style={{ color: '#f1c40f' }} title="精品">★ </span>}{n}
                    </div>
                    <div className="char-info">
                      {age}{c.category} | {total} imgs, {vcount} vids
                      {trashCount > 0 ? ` | ${trashCount} trash` : ''}
                    </div>
                  </div>
                  {pend > 0 ? (
                    <span title="待选待审" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: '#f1c40f', background: 'rgba(241,196,15,.12)', padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap' }}>待选 {pend}</span>
                  ) : (
                    <span title="无待选" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 12, color: '#3c6', opacity: 0.55 }}>✓</span>
                  )}
                </div>
              </div>
            );
          });
        })()}
      </div>

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{
            top: Math.min(ctxMenu.y, window.innerHeight - 100),
            left: Math.min(ctxMenu.x, window.innerWidth - 160),
          }}
          onClick={e => e.stopPropagation()}
        >
          <button className="ctx-menu-item" onClick={handleClear}>
            清空素材
          </button>
          <button className="ctx-menu-item danger" onClick={handleDelete}>
            删除角色
          </button>
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>新建角色</h3>
            <label>名称 *</label>
            <input
              value={createForm.name}
              onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
              placeholder="角色名称"
              autoFocus
            />
            <label>分类</label>
            <select
              value={createForm.category}
              onChange={e => setCreateForm(f => ({ ...f, category: e.target.value }))}
            >
              <option value="">uncategorized</option>
              {categories.map(c => (
                <option key={c.category} value={c.category}>{c.category}</option>
              ))}
            </select>
            <label>描述</label>
            <textarea
              value={createForm.description}
              onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              placeholder="可选描述"
              rows={3}
            />
            <div className="modal-actions">
              <button onClick={() => setShowCreate(false)}>取消</button>
              <button className="primary" onClick={handleCreate} disabled={creating || !createForm.name.trim()}>
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
