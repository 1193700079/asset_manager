import type {
  CharacterIndex,
  CharacterListItem,
  CategoryCount,
  RefImage,
  VFESearchItem,
  TagCloud,
} from '../types';

const BASE = '';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

export const api = {
  getIndex: () =>
    fetchJson<Record<string, CharacterIndex>>('/api/index'),

  getCategories: () =>
    fetchJson<CategoryCount[]>('/api/characters/categories'),

  getCharacterList: () =>
    fetchJson<CharacterListItem[]>('/api/characters/list'),

  softDelete: (name: string, imageUrl: string) =>
    fetchJson<{ status: string }>('/api/media/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, image_url: imageUrl }),
    }),

  restore: (name: string, imageUrl: string) =>
    fetchJson<{ status: string }>('/api/media/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, image_url: imageUrl }),
    }),

  emptyTrash: (name: string) =>
    fetchJson<{ status: string }>('/api/media/trash/empty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  getRefImages: (characterId: number) =>
    fetchJson<{ total: number; items: RefImage[] }>(
      `/api/ref-images?character_id=${characterId}`
    ),

  addRefImage: (data: {
    character_id: number;
    image_url: string;
    prompt?: string;
    dimensions?: Record<string, string[]>;
    tags?: string[];
    style?: string;
    description?: string;
  }) =>
    fetchJson<{ status: string; id: number }>('/api/ref-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  deleteRefImage: (id: number) =>
    fetchJson<{ status: string }>('/api/ref-images/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  getTagCloud: () =>
    fetchJson<TagCloud>('/api/asset-library/tags'),

  searchAssetLibrary: (params: {
    tag?: string;
    dimension?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.tag) qs.set('tag', params.tag);
    if (params.dimension) qs.set('dimension', params.dimension);
    qs.set('limit', String(params.limit ?? 50));
    qs.set('offset', String(params.offset ?? 0));
    return fetchJson<{ total: number; items: VFESearchItem[] }>(
      `/api/asset-library/images?${qs}`
    );
  },

  skipVFEImage: (path: string) =>
    fetchJson<{ success: boolean; error?: string }>('/api/asset-library/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
};
