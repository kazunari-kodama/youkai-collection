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
  night_only?: boolean;
  require_qr?: boolean;
  youryoku?: number;   // 1-5（省略時は1扱い）
}

/** GET /youkai レスポンスの1件 */
export interface YokaiListItem {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** マーカー用サムネ（長辺144px webp、平均5KB）。scripts/generate-thumbs.mjs が生成 */
  thumb_url: string;
  /** フル解像度。詳細画面と、サムネ未生成時のフォールバック用 */
  camera_url: string;
  night_only?: boolean;
  require_qr?: boolean;
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
  require_qr?: boolean;
}

/** youkai-captures テーブルの1レコード */
export interface CaptureDBItem {
  deviceId: string;
  youkaiId: string;
  capturedAt: string;
  userLat: number;
  userLon: number;
  actionType: 'seal' | 'release' | 'bond' | 'in_progress';
  faction: 'exorcist' | 'supernatural';
  rally_key?: string;
  seal_progress?: number;   // 封印試行回数（in_progressのとき使用）
  seal_required?: number;   // 封印に必要な試行回数
}
