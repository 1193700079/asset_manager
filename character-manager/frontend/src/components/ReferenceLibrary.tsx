import { useState, useEffect } from 'react';
import type { RefImage } from '../types';
import { api } from '../api/client';
import './ReferenceLibrary.css';

interface Props {
  characterId: number;
}

export default function ReferenceLibrary({ characterId }: Props) {
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const loadRefs = async () => {
    try {
      const data = await api.getRefImages(characterId);
      setRefs(data.items || []);
    } catch { setRefs([]); }
  };

  useEffect(() => { loadRefs(); }, [characterId]);

  const handleSearch = async () => {
    setSearching(true);
    try {
      const params: any = { limit: 50 };
      if (searchQuery) params.tag = searchQuery;
      const data = await api.searchAssetLibrary(params);
      setSearchResults(data.items || []);
    } catch { setSearchResults([]); }
    setSearching(false);
  };

  const handleAdd = async (item: any) => {
    const fullUrl = `http://localhost:3001${item.image_url}`;
    await api.addRefImage({
      character_id: characterId,
      image_url: fullUrl,
      prompt: item.prompt || '',
      dimensions: item.dimensions || {},
      tags: item.tags || [],
      style: item.style || '',
      description: item.description || '',
    });
    loadRefs();
    handleSearch();
  };

  const handleRemove = async (id: number) => {
    if (!confirm('Remove this reference?')) return;
    await api.deleteRefImage(id);
    loadRefs();
  };

  const existingUrls = new Set(refs.map(r => r.image_url));

  return (
    <div className="ref-section">
      <div className="section-title">
        <span>Reference Library ({refs.length})</span>
        <button className="btn-sm" onClick={() => setShowSearch(!showSearch)}>
          {showSearch ? 'Hide Search' : 'Search VFE'}
        </button>
      </div>

      {showSearch && (
        <div className="ref-search-panel">
          <div className="ref-search-bar">
            <input
              placeholder="Search by tag..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
            />
            <button onClick={handleSearch} disabled={searching}>
              {searching ? '...' : 'Search'}
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="ref-search-results">
              {searchResults.map((item, i) => {
                const fullUrl = `http://localhost:3001${item.image_url}`;
                const isAdded = existingUrls.has(fullUrl);
                return (
                  <div key={i} className={`ref-search-card ${isAdded ? 'added' : ''}`}>
                    <img src={fullUrl} loading="lazy" />
                    <div className="ref-search-info">
                      <div className="ref-search-name">{item.video_name}</div>
                      {item.prompt && <div className="ref-search-prompt">{item.prompt}</div>}
                    </div>
                    {!isAdded ? (
                      <button className="ref-add-btn" onClick={() => handleAdd(item)}>+</button>
                    ) : (
                      <span className="ref-added-badge">Added</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {refs.length > 0 && (
        <div className="ref-list">
          {refs.map(ref => (
            <div key={ref.id} className="ref-card">
              <button className="ref-remove" onClick={() => handleRemove(ref.id)}>✕</button>
              <img src={ref.image_url} loading="lazy" />
              <div className="ref-info">
                <div className="ref-name">{ref.image_url.split('/').pop()?.split('?')[0]}</div>
                {ref.prompt && <div className="ref-prompt">{ref.prompt}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
