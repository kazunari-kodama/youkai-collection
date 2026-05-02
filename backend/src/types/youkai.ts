/** kodama_db の1アイテム */
export interface YokaiDBItem {
  yokai_id: string;
  name: string;
  kana: string;
  latitude: number;
  longitude: number;
  notes?: string;
  appearance?: string;
  images?: string[];
  image_types?: string[];
  image_captions?: string[];
  regions?: string[];
  region_detail?: string;
  category_tags?: string[];
  keywords?: string[];
  rally_key?: string;
}

/** GET /youkai レスポンスの1件 */
export interface YokaiListItem {
  id: string;
  name: string;
  lat: number;
  lon: number;
  icon_url: string;
  camera_url: string;
}

/** GET /youkai/{id} レスポンス */
export interface YokaiDetail {
  id: string;
  name: string;
  kana: string;
  lat: number;
  lon: number;
  notes: string;
  appearance: string;
  camera_url: string;
  images: Array<{ url: string; type: string; caption: string }>;
  regions: string[];
  region_detail: string;
  category_tags: string[];
  keywords: string[];
  rally_key?: string;
}

/** youkai-captures テーブルの1レコード */
export interface CaptureDBItem {
  deviceId: string;
  youkaiId: string;
  capturedAt: string;
  userLat: number;
  userLon: number;
}
