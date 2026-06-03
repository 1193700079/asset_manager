import type { CharacterIndex, CategoryCount } from '../types';
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
}

export default function Sidebar({
  names, index, categories, activeName, activeCat,
  searchQuery, dataSource, sources, onDataSourceChange,
  onSelect, onCategoryChange, onSearchChange,
  onRefresh, onOpenLibrary,
}: Props) {
  return (
    <div className="sidebar">
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
      <h2>Characters ({names.length})</h2>
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
        {categories.map(c => (
          <button
            key={c.category}
            className={`cat-btn ${activeCat === c.category ? 'active' : ''}`}
            onClick={() => onCategoryChange(c.category)}
          >{c.category} ({c.count})</button>
        ))}
      </div>
      <div className="sidebar-toolbar">
        <button onClick={onRefresh}>Refresh</button>
        <button className="lib-btn" onClick={onOpenLibrary}>素材库</button>
      </div>
      <div className="char-list">
        {names.map(n => {
          const c = index[n]!;
          const thumb = c.avatar_url || c.profile_images[0] || '';
          const total = c.all_images.length;
          const vcount = c.profile_videos.length;
          const trashCount = c.trash_all.length;
          const age = c.attributes?.Age ? `${c.attributes.Age} | ` : '';
          return (
            <div
              key={n}
              className={`char-item ${activeName === n ? 'active' : ''}`}
              onClick={() => onSelect(n)}
            >
              {thumb && (
                <img
                  className="char-thumb"
                  src={thumb}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              )}
              <div className="char-meta">
                <div className="char-name">{n}</div>
                <div className="char-info">
                  {age}{c.category} | {total} imgs, {vcount} vids
                  {trashCount > 0 ? ` | ${trashCount} trash` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
