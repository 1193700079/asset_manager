export interface CharacterIndex {
  id: number;
  category: string;
  description: string;
  attributes: Record<string, string>;
  content_rating: string;
  character_status: 'online' | 'pre_release' | 'pending';
  avatar_url: string;
  voice_id: string;
  profile_images: string[];
  profile_videos: string[];
  generated_images: string[];
  all_images: string[];
  trash_images: string[];
  trash_videos: string[];
  trash_generated: string[];
  trash_all: string[];
  media_status_map: Record<string, 'online' | 'pre_release' | 'pending'>;
  pending_media: { url: string; type: string; source: string }[];
}

export interface CharacterListItem {
  id: number;
  name: string;
  category: string;
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface RefImage {
  id: number;
  character_id: number;
  vfe_frame_id: number | null;
  image_url: string;
  prompt: string | null;
  dimensions: Record<string, string[]>;
  tags: string[];
  style: string | null;
  description: string | null;
  created_at: string | null;
}

export interface VFESearchItem {
  video_path: string;
  video_name: string;
  image_url: string;
  oss_url: string;
  prompt: string | null;
  description: string | null;
  dimensions: Record<string, string[]>;
  tags: string[];
  style: string | null;
  model_id: string | null;
  created_at: string;
  /** Video-level prompt (long-form description of the source video). */
  video_prompt?: string | null;
  /** Image-to-video prompt (motion/action description for I2V tasks like comfy_video). */
  i2v_prompt?: string | null;
}

export interface TagCloudDimension {
  tag: string;
  count: number;
}

export interface TagCloud {
  total_images: number;
  dimensions: Record<string, TagCloudDimension[]>;
  error?: string;
  _full_count?: number;
  _shown_count?: number;
}

export interface BatchJob {
  job_id: string;
  type: 'anime' | 'anime_direct' | 'faceswap' | 'zimage' | 'imageedit' | 'video' | 'avatar';
  data_source: string;
  per_character: number;
  category: string | null;
  engine?: 'smartstudio' | 'comfyui';
  status: 'starting' | 'building' | 'running' | 'stopping' | 'stopped' | 'completed' | 'error' | 'interrupted';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  current: string | null;
  results: { char?: string; id?: number; name?: string; ok: boolean; url?: string; error?: string }[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
  resumable?: boolean;
  resumable_remaining?: number;
}
