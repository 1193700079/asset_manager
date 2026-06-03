import type {
  CharacterIndex,
  CharacterListItem,
  CategoryCount,
  RefImage,
  VFESearchItem,
  TagCloud,
} from '../types';

const BASE = '';

const DS_KEY = 'cm_data_source';

export function getDataSource(): string {
  return localStorage.getItem(DS_KEY) || 'ecjoy';
}

export function setDataSource(name: string): void {
  localStorage.setItem(DS_KEY, name);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('X-Data-Source', getDataSource());
  const res = await fetch(`${BASE}${url}`, { ...init, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

export const api = {
  getDataSources: () =>
    fetchJson<{ sources: string[]; default: string }>('/api/datasources'),

  setAvatar: (characterId: number, imageUrl: string) =>
    fetchJson<{ status: string; avatar_url?: string; face_found?: boolean; message?: string }>(
      '/api/avatar/set',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: characterId, image_url: imageUrl }),
      }
    ),

  batchAvatars: (onlyMissing = true, limit = 0) =>
    fetchJson<{ status: string; processed: number; succeeded: number; failed: number; no_image: number }>(
      '/api/avatar/batch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ only_missing: onlyMissing, limit }),
      }
    ),

  setVoice: (characterId: number, voiceId: string) =>
    fetchJson<{ status: string; voice_id: string | null }>('/api/characters/voice', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character_id: characterId, voice_id: voiceId }),
    }),

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

  getTagCloud: (minCount = 3) =>
    fetchJson<TagCloud>(`/api/asset-library/tags?min_count=${minCount}`),

  getDimTags: (dim: string, minCount = 1) =>
    fetchJson<{ dimension: string; total: number; tags: { tag: string; count: number }[]; error?: string }>(
      `/api/asset-library/tags/${dim}?min_count=${minCount}`
    ),

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

  // --- Per-media status ---
  updateMediaStatus: (character_id: number, url: string, media_status: string) =>
    fetchJson<{ status: string; media_status?: string }>(
      '/api/media/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id, url, media_status }),
      }),

  // --- Character status ---
  updateCharacterStatus: (character_id: number, character_status: string) =>
    fetchJson<{ status: string; character_status?: string; message?: string }>(
      '/api/characters/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id, character_status }),
      }),

  // --- Generation ---
  createGeneration: (data: {
    character_id: number;
    character_name: string;
    task_type: string;
    source_image?: string;
    face_image?: string;
    prompt?: string;
    width?: number;
    height?: number;
    duration?: number;
    resolution?: string;
    seed?: number;
    batch_count?: number;
  }) =>
    fetchJson<{ status: string; task_ids: string[]; errors: string[] }>(
      '/api/generation/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

  getGenerationTasks: (characterId: number) =>
    fetchJson<{
      status: string;
      tasks: {
        task_id: string;
        character_id: number;
        character_name: string;
        task_type: string;
        status: string;
        prompt: string;
        ref_image_url: string;
        resolution: string | null;
        duration: number | null;
        result_url: string | null;
        error: string | null;
        created_at: string | null;
        updated_at: string | null;
      }[];
    }>(`/api/generation/tasks/${characterId}`),

  pollGenerationStatus: (taskId: string) =>
    fetchJson<{
      status: string;
      task_id: string;
      task_status: string;
      result_url: string | null;
      error_message: string;
      completed_at: string | null;
    }>(`/api/generation/status/${taskId}`),

  saveGeneration: (taskId: string, media_type: string) =>
    fetchJson<{ status: string; media_type?: string; message?: string }>(
      `/api/generation/save/${taskId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_type }),
      }),

  discardGeneration: (taskId: string) =>
    fetchJson<{ status: string }>(`/api/generation/discard/${taskId}`, {
      method: 'POST',
    }),

  batchSaveGeneration: (task_ids: string[]) =>
    fetchJson<{ status: string; results: { task_id: string; status: string; media_type?: string }[] }>(
      '/api/generation/batch-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_ids }),
      }),

  batchDiscardGeneration: (task_ids: string[]) =>
    fetchJson<{ status: string; discarded: number }>(
      '/api/generation/batch-discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_ids }),
      }),

  getRandomCards: (character_id: number, count: number = 10, exclude_paths: string[] = []) =>
    fetchJson<{
      status: string;
      cards: import('../types').VFESearchItem[];
      total: number;
      message?: string;
    }>('/api/generation/random-cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character_id, count, exclude_paths }),
    }),

  // --- Batch scripts ---
  listScripts: () =>
    fetchJson<{
      scripts: {
        key: string; label: string; category: string; description: string;
        needs_args: boolean; default_args: Record<string, string>;
        positional_args: string[];
      }[];
    }>('/api/scripts/list'),

  launchScript: (script_key: string, character_name: string, args?: Record<string, string>) =>
    fetchJson<{ status: string; job_id?: string; pid?: number; command?: string; message?: string }>(
      '/api/scripts/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script_key, character_name, args: args || {} }),
      }),

  killScriptJob: (job_id: string) =>
    fetchJson<{ status: string; message?: string }>('/api/scripts/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id }),
    }),

  getScriptJobs: (characterName?: string) => {
    const url = characterName
      ? `/api/scripts/jobs/${encodeURIComponent(characterName)}`
      : '/api/scripts/jobs';
    return fetchJson<{
      jobs: {
        job_id: string; script_key: string; label: string; character_name: string;
        pid: number; status: string; exit_code: number | null;
        started_at: string; completed_at: string | null; log_tail: string;
      }[];
    }>(url);
  },

  getScriptJobStatus: (job_id: string) =>
    fetchJson<{
      job_id: string; script_key: string; label: string; character_name: string;
      pid: number; status: string; exit_code: number | null; command: string;
      started_at: string; completed_at: string | null; log_tail: string;
    }>(`/api/scripts/status/${job_id}`),

  // --- ComfyUI single processing ---
  listComfyuiScripts: () =>
    fetchJson<{
      scripts: {
        key: string; label: string; category: string; description: string;
        needs_image: boolean; needs_face: boolean; needs_prompt: boolean;
      }[];
    }>('/api/comfyui/scripts'),

  submitComfyuiSingle: (data: {
    task_type: string; image_url?: string; face_url?: string;
    prompt?: string; seed?: number; character_name?: string;
  }) =>
    fetchJson<{ status: string; job_id?: string; message?: string }>(
      '/api/comfyui/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

  getComfyuiJobStatus: (job_id: string) =>
    fetchJson<{
      job_id: string; task_type: string; label: string; character_name: string;
      image_url: string; face_url: string; prompt: string; seed: number;
      status: string; result_url: string | null; result_path: string | null;
      error: string | null; port: number | null; prompt_id: string | null;
      created_at: string; completed_at: string | null;
    }>(`/api/comfyui/status/${job_id}`),

  listComfyuiJobs: (characterName?: string) => {
    const url = characterName
      ? `/api/comfyui/jobs/${encodeURIComponent(characterName)}`
      : '/api/comfyui/jobs';
    return fetchJson<{
      jobs: {
        job_id: string; task_type: string; label: string; character_name: string;
        status: string; result_url: string | null; error: string | null;
        created_at: string; completed_at: string | null;
      }[];
    }>(url);
  },

  saveComfyuiResult: (job_id: string, character_name: string, media_type: string = 'image') =>
    fetchJson<{ status: string; media_type?: string; character?: string; message?: string }>(
      '/api/comfyui/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id, character_name, media_type }),
      }),
};
