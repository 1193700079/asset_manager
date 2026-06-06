import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CharacterIndex, CategoryCount } from './types';
import { api, getDataSource, setDataSource, getConfirmEnabled, setConfirmEnabled } from './api/client';
import { useHashRoute } from './hooks/useHashRoute';
import Sidebar from './components/Sidebar';
import CharacterDetail from './components/CharacterDetail';
import AssetLibrary from './components/AssetLibrary';
import GlobalBatchView from './components/GlobalBatchView';
import './App.css';

export default function App() {
  const [index, setIndex] = useState<Record<string, CharacterIndex>>({});
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<string[]>([]);
  const [confirmEnabled, setConfirmEnabledState] = useState<boolean>(getConfirmEnabled());
  const { route, navigate } = useHashRoute();

  // ── Derive UI state from the URL hash ───────────────────────────────
  const activeName = route.view === 'character' ? route.name : null;
  const activeCat = route.category;
  const searchQuery = route.query;
  const showLibrary = route.view === 'library';
  const showGlobalBatch = route.view === 'batch';

  // Data source: route.ds wins, else localStorage, else default
  const dataSource = route.dataSource || getDataSource();

  // When the route's ds changes, sync the api client too
  useEffect(() => {
    if (route.dataSource) setDataSource(route.dataSource);
  }, [route.dataSource]);

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

  // ── Handlers that push into the hash ───────────────────────────────
  const handleSelect = useCallback((name: string | null) => {
    if (name) {
      navigate({ view: 'character', name });
    } else {
      navigate({ view: 'home', name: null });
    }
  }, [navigate]);

  const handleCategoryChange = useCallback((cat: string | null) => {
    navigate({ category: cat });
  }, [navigate]);

  const handleSearchChange = useCallback((q: string) => {
    navigate({ query: q });
  }, [navigate]);

  const handleOpenLibrary = useCallback(() => {
    navigate({ view: 'library' });
  }, [navigate]);

  const handleCloseLibrary = useCallback(() => {
    // Return to whatever was showing before (home or the selected character)
    navigate({ view: activeName ? 'character' : 'home' });
  }, [navigate, activeName]);

  const handleOpenGlobalBatch = useCallback(() => {
    navigate({ view: 'batch' });
  }, [navigate]);

  const handleBackFromBatch = useCallback(() => {
    navigate({ view: 'home' });
  }, [navigate]);

  const handleDataSourceChange = useCallback((next: string) => {
    // Reset everything + push ds into hash + re-fetch
    setDataSource(next);
    navigate({
      view: 'home',
      name: null,
      category: null,
      query: '',
      dataSource: next,
    });
    setLoading(true);
    loadData();
  }, [loadData, navigate]);

  const handleCreateCharacter = useCallback(async (data: { name: string; category?: string; description?: string }) => {
    await api.createCharacter(data);
    await loadData();
  }, [loadData]);

  const handleDeleteCharacter = useCallback(async (name: string) => {
    await api.deleteCharacter(name);
    if (activeName === name) {
      navigate({ view: 'home', name: null });
    }
    await loadData();
  }, [loadData, activeName, navigate]);

  const handleClearCharacter = useCallback(async (name: string) => {
    await api.clearCharacter(name);
    await loadData();
  }, [loadData]);

  const handleToggleConfirm = useCallback((enabled: boolean) => {
    setConfirmEnabled(enabled);
    setConfirmEnabledState(enabled);
  }, []);

  const filteredNames = useMemo(
    () => Object.keys(index)
      .filter(n => {
        const c = index[n]!;
        if (activeCat === 'featured') {
          if (![310, 369, 293, 287].includes(c.id)) return false;
        } else if (activeCat && c.category !== activeCat) {
          return false;
        }
        if (searchQuery && !n.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
      })
      .sort(),
    [index, activeCat, searchQuery]
  );

  // Guard: if URL pointed at a character that's no longer in the index, reset to home
  useEffect(() => {
    if (route.view === 'character' && route.name) {
      const loaded = Object.keys(index).length > 0;
      if (loaded && !index[route.name]) {
        navigate({ view: 'home', name: null });
      }
    }
  }, [index, route, navigate]);

  const resolvedName = activeName && index[activeName] ? activeName : null;

  const activeChar = resolvedName ? index[resolvedName] : null;

  return (
    <div className="app">
      <Sidebar
        names={filteredNames}
        index={index}
        categories={categories}
        activeName={resolvedName}
        activeCat={activeCat}
        searchQuery={searchQuery}
        dataSource={dataSource}
        sources={sources}
        onDataSourceChange={handleDataSourceChange}
        onSelect={handleSelect}
        onCategoryChange={handleCategoryChange}
        onSearchChange={handleSearchChange}
        onRefresh={loadData}
        onOpenLibrary={handleOpenLibrary}
        onOpenGlobalBatch={handleOpenGlobalBatch}
        onCreateCharacter={handleCreateCharacter}
        onDeleteCharacter={handleDeleteCharacter}
        onClearCharacter={handleClearCharacter}
        confirmEnabled={confirmEnabled}
        onToggleConfirm={handleToggleConfirm}
      />
      <div className="main">
        {showGlobalBatch ? (
          <GlobalBatchView onBack={handleBackFromBatch} onRefresh={loadData} />
        ) : activeChar && resolvedName ? (
          <CharacterDetail
            name={resolvedName}
            data={activeChar}
            onRefresh={loadData}
            confirmEnabled={confirmEnabled}
          />
        ) : (
          <div className="empty-state">
            <h1>Select a character</h1>
            <p>{loading ? 'Loading...' : `${Object.keys(index).length} characters available`}</p>
          </div>
        )}
      </div>
      {showLibrary && (
        <AssetLibrary onClose={handleCloseLibrary} />
      )}
    </div>
  );
}
