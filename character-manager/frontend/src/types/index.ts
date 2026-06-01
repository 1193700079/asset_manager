export interface CharacterIndex {
  id: number;
  category: string;
  description: string;
  attributes: Record<string, string>;
  content_rating: string;
  profile_images: string[];
  profile_videos: string[];
  generated_images: string[];
  all_images: string[];
  trash_images: string[];
  trash_videos: string[];
  trash_generated: string[];
  trash_all: string[];
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
}

export interface TagCloudDimension {
  tag: string;
  count: number;
}

export interface TagCloud {
  total_images: number;
  dimensions: Record<string, TagCloudDimension[]>;
}
