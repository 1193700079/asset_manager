import { useState, useEffect, useCallback } from 'react';

/**
 * Lightweight hash-based routing. Zero deps.
 *
 * URL shapes:
 *   #/                           → home (no selection)
 *   #/c/{encodedName}            → character selected
 *   #/library                    → asset library
 *   #/batch                      → global batch view
 *
 * Query params in hash:
 *   #/c/Name?cat=babe&q=foo&ds=ecjoy
 *
 * Exposes `route` (parsed state) and `navigate` (push new hash).
 */
export interface RouteState {
  view: 'home' | 'character' | 'library' | 'batch';
  name: string | null;
  category: string | null;
  query: string;
  dataSource: string | null;
}

const EMPTY: RouteState = {
  view: 'home',
  name: null,
  category: null,
  query: '',
  dataSource: null,
};

function parseHash(hash: string): RouteState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPartRaw, queryPart] = raw.split('?');
  const pathPart: string = pathPartRaw ?? '';
  const path = pathPart.replace(/^\/+|\/+$/g, '');

  const params = new URLSearchParams(queryPart || '');
  const category = params.get('cat');
  const query = params.get('q') || '';
  const dataSource = params.get('ds');

  // #/c/Name or #/c/Name/with/slashes
  const cMatch = path.match(/^c\/(.+)$/);
  if (cMatch) {
    const name = cMatch[1];
    if (name) {
      return {
        view: 'character',
        name: decodeURIComponent(name),
        category,
        query,
        dataSource,
      };
    }
  }
  if (path === 'library') {
    return { view: 'library', name: null, category, query, dataSource };
  }
  if (path === 'batch') {
    return { view: 'batch', name: null, category, query, dataSource };
  }
  return { ...EMPTY, category, query, dataSource };
}

function buildHash(state: RouteState): string {
  const params = new URLSearchParams();
  if (state.category) params.set('cat', state.category);
  if (state.query) params.set('q', state.query);
  if (state.dataSource) params.set('ds', state.dataSource);
  const qs = params.toString();
  const q = qs ? `?${qs}` : '';

  if (state.view === 'library') return `#/library${q}`;
  if (state.view === 'batch') return `#/batch${q}`;
  if (state.view === 'character' && state.name) {
    return `#/c/${encodeURIComponent(state.name)}${q}`;
  }
  return `#/${q}`;
}

export function useHashRoute() {
  const [route, setRoute] = useState<RouteState>(() => parseHash(window.location.hash));

  useEffect(() => {
    const sync = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const navigate = useCallback((next: Partial<RouteState>) => {
    const merged: RouteState = { ...route, ...next };
    // When navigating to a different view with no explicit name, clear it
    if (next.view && next.view !== 'character' && next.name === undefined) {
      merged.name = null;
    }
    const target = buildHash(merged);
    if (target !== window.location.hash) {
      // pushState so browser back/forward traverses between characters.
      window.history.pushState(null, '', target);
      setRoute(merged);
    }
  }, [route]);

  return { route, navigate };
}
