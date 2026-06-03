import { useState, useEffect, useCallback } from 'react';
import type { CharacterIndex, CategoryCount } from './types';
import { api, getDataSource, setDataSource } from './api/client';
import Sidebar from './components/Sidebar';
import CharacterDetail from './components/CharacterDetail';
import AssetLibrary from './components/AssetLibrary';
import './App.css';

export default function App() {
  const [index, setIndex] = useState<Record<string, CharacterIndex>>({});
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSourceState] = useState<string>(getDataSource());
  const [sources, setSources] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [idx, cats] = await Promise.all([
        api.getIndex(),
        api.getCategories(),
      ]);
      setIndex(idx);
      setCategories(cats);
    } catch (e) {
      console.error('Failed to load data:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    api.getDataSources()
      .then(r => setSources(r.sources))
      .catch(e => console.error('Failed to load data sources:', e));
  }, []);

  const handleDataSourceChange = useCallback((next: string) => {
    setDataSource(next);
    setDataSourceState(next);
    setActiveName(null);
    setActiveCat(null);
    setSearchQuery('');
    setLoading(true);
    loadData();
  }, [loadData]);

  const filteredNames = Object.keys(index)
    .filter(n => {
      if (activeCat && index[n]!.category !== activeCat) return false;
      if (searchQuery && !n.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    })
    .sort();

  const activeChar = activeName ? index[activeName] : null;

  return (
    <div className="app">
      <Sidebar
        names={filteredNames}
        index={index}
        categories={categories}
        activeName={activeName}
        activeCat={activeCat}
        searchQuery={searchQuery}
        dataSource={dataSource}
        sources={sources}
        onDataSourceChange={handleDataSourceChange}
        onSelect={setActiveName}
        onCategoryChange={setActiveCat}
        onSearchChange={setSearchQuery}
        onRefresh={loadData}
        onOpenLibrary={() => setShowLibrary(true)}
      />
      <div className="main">
        {activeChar && activeName ? (
          <CharacterDetail
            name={activeName}
            data={activeChar}
            onRefresh={loadData}
          />
        ) : (
          <div className="empty-state">
            <h1>Select a character</h1>
            <p>{loading ? 'Loading...' : `${Object.keys(index).length} characters available`}</p>
          </div>
        )}
      </div>
      {showLibrary && (
        <AssetLibrary onClose={() => setShowLibrary(false)} />
      )}
    </div>
  );
}
