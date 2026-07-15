import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CharacterIndex, CategoryCount } from './types';
import { api, getDataSource, setDataSource, getConfirmEnabled, setConfirmEnabled, getHardDeleteEnabled, setHardDeleteEnabled, getToken, getCurrentUser, clearAuth } from './api/client';
import { useHashRoute } from './hooks/useHashRoute';
import Sidebar from './components/Sidebar';
import CharacterDetail from './components/CharacterDetail';
import AssetLibrary from './components/AssetLibrary';
import GlobalBatchView from './components/GlobalBatchView';
import BatchCharacterPanel from './components/BatchCharacterPanel';
import CharacterCreate from './components/CharacterCreate';
import Settings from './components/Settings';
import AuthGate from './components/AuthGate';
import './App.css';

export default function App() {
  const [index, setIndex] = useState<Record<string, CharacterIndex>>({});
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<string[]>([]);
  const [confirmEnabled, setConfirmEnabledState] = useState<boolean>(getConfirmEnabled());
  const [allowHardDelete, setAllowHardDeleteState] = useState<boolean>(getHardDeleteEnabled());
  const [authUser, setAuthUser] = useState<string>(getCurrentUser());
  const { route, navigate } = useHashRoute();

  // ── Derive UI state from the URL hash ───────────────────────────────
  const activeName = route.view === 'character' ? route.name : null;
  const activeCat = route.category;
  const searchQuery = route.query;
  const showLibrary = route.view === 'library';
  const showGlobalBatch = route.view === 'batch';
  const showBatchChar = route.view === 'batch-char';
  const showCreate = route.view === 'create';
  const showSettings = route.view === 'settings';

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

  // Cheap refresh for the detail view: refetch only the current character and
  // merge it into the index, instead of rebuilding all ~439 (loadData).
  const refreshOne = useCallback(async (charName: string) => {
    if (!charName) return;
    try {
      const one = await api.getCharacterIndex(charName);
      setIndex(prev => ({ ...prev, ...one }));
    } catch (e) {
      console.error('refreshOne failed:', e);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    api.getDataSources()
      .then(r => {
        setSources(r.sources);
        if (!r.sources.includes(getDataSource())) {
          setDataSource(r.default);
          window.location.reload();
        }
      })
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

  const handleOpenBatchChar = useCallback(() => {
    navigate({ view: 'batch-char' });
  }, [navigate]);

  const handleOpenCreate = useCallback(() => {
    navigate({ view: 'create', name: null });
  }, [navigate]);

  const handleOpenSettings = useCallback(() => {
    navigate({ view: 'settings', name: null });
  }, [navigate]);

  const handleGoHome = useCallback(() => {
    navigate({ view: 'home', name: null });
  }, [navigate]);

  const handleCharacterCreated = useCallback(async (name: string) => {
    await loadData();
    navigate({ view: 'character', name });
  }, [loadData, navigate]);

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

  const handleToggleHardDelete = useCallback((enabled: boolean) => {
    setHardDeleteEnabled(enabled);
    setAllowHardDeleteState(enabled);
  }, []);

  const filteredNames = useMemo(
    () => Object.keys(index)
      .filter(n => {
        const c = index[n]!;
        if (activeCat === 'featured') {
          if (!c.featured) return false;
        } else if (activeCat && activeCat.startsWith('tag:')) {
          if (!(c.tags || []).includes(activeCat.slice(4))) return false;
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

  const viewLabel = showGlobalBatch ? '批处理 / Batch'
    : showBatchChar ? '批量生成 / Generate'
    : showLibrary ? '素材库 / Library'
    : showCreate ? '新建角色 / Create'
    : showSettings ? '设置 / Settings'
    : resolvedName ? resolvedName
    : '总览 / Overview';

  if (!authUser || !getToken()) {
    return <AuthGate onAuthed={setAuthUser} />;
  }

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
        onOpenBatchChar={handleOpenBatchChar}
        onOpenCreate={handleOpenCreate}
        onCreateCharacter={handleCreateCharacter}
        onDeleteCharacter={handleDeleteCharacter}
        onClearCharacter={handleClearCharacter}
        confirmEnabled={confirmEnabled}
        onToggleConfirm={handleToggleConfirm}
      />
      <div className="main">
        <div className="cm-header">
          <button className="cm-header-brand" onClick={handleGoHome} title="返回总览">
            <span className="cm-header-logo">CYPHER<span className="accent">·CM</span></span>
            <span className="cm-header-tag">Character Manager</span>
          </button>
          <div className="cm-header-view">{viewLabel}</div>
          <div className="cm-header-spacer" />
          <div className="cm-header-status">
            <span className="cm-header-dot" />
            {dataSource}
          </div>
          <div className="cm-header-status" title="当前登录用户" style={{ gap: 6 }}>
            <span style={{ opacity: 0.7 }}>👤</span>{authUser}
            <button
              onClick={() => { clearAuth(); setAuthUser(''); }}
              title="登出"
              style={{ marginLeft: 6, background: 'transparent', border: '1px solid #445', color: '#9ab', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '1px 6px' }}
            >登出</button>
          </div>
          <button
            className={`cm-header-gear ${showSettings ? 'active' : ''}`}
            onClick={handleOpenSettings}
            title="设置"
            aria-label="设置"
          >⚙</button>
        </div>
        <div className="main-body">
          {showSettings ? (
            <Settings
              dataSource={dataSource}
              sources={sources}
              onDataSourceChange={handleDataSourceChange}
              confirmEnabled={confirmEnabled}
              onToggleConfirm={handleToggleConfirm}
              allowHardDelete={allowHardDelete}
              onToggleHardDelete={handleToggleHardDelete}
            />
          ) : showCreate ? (
            <CharacterCreate
              categories={categories}
              onBack={handleGoHome}
              onCreated={handleCharacterCreated}
            />
          ) : showGlobalBatch ? (
            <GlobalBatchView onBack={handleBackFromBatch} onRefresh={loadData} />
          ) : showBatchChar ? (
            <BatchCharacterPanel onBack={handleBackFromBatch} onRefresh={loadData} />
          ) : activeChar && resolvedName ? (
            <CharacterDetail
              key={resolvedName}
              name={resolvedName}
              data={activeChar}
              categories={categories}
              onRefresh={() => refreshOne(resolvedName)}
              confirmEnabled={confirmEnabled}
              allowHardDelete={allowHardDelete}
            />
          ) : (
            <div className="empty-state">
              <h1>Select a character</h1>
              <p>{loading ? 'Loading...' : `${Object.keys(index).length} characters available`}</p>
            </div>
          )}
        </div>
      </div>
      {showLibrary && (
        <AssetLibrary onClose={handleCloseLibrary} />
      )}
    </div>
  );
}
