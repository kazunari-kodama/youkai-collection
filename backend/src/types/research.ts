export type ResearchStatus = 'pending' | 'reviewing' | 'approved' | 'rejected';
export type SourceType = 'academic' | 'web' | 'oral' | 'image';

export interface ResearchDBItem {
  research_id: string;
  status: ResearchStatus;
  yokai_name: string;
  source_url?: string;
  source_type?: SourceType;
  raw_content?: string;
  summary?: string;
  reliability_score?: number;
  originality_score?: number;
  collector_id: string;
  collected_at: string;
  latitude?: number;
  longitude?: number;
  reviewed_by?: string;
  reviewed_at?: string;
  review_notes?: string;
  promoted_to?: string;
  media_attachments?: string[];
}
