/** @fileoverview Complete FARA source results before acquisition windowing. @module services/fara/types */
import type { FaraRecord } from '@/domain/fara.js';

/** Status belongs to the selected entity, independently of its registrant. */
export type FaraStatus = 'active' | 'terminated' | 'all';
/** Complete snapshot search scope. */
export interface FaraSearch {
  country?: string;
  entity?: 'registrants' | 'foreign_principals';
  name_contains?: string;
  status?: FaraStatus;
}
/** A live detail collection; documents have no status arms. */
export interface FaraDetail {
  detail?: 'foreign_principals' | 'short_forms' | 'documents';
  registration_number: string;
  status?: FaraStatus;
}
/** Immutable records and provenance ready for a retained acquisition checkpoint. */
export interface FaraSourceResult {
  notices: string[];
  records: FaraRecord[];
  retrieved_at: string;
  snapshot_last_modified?: string;
  snapshot_retrieved_at?: string;
  snapshot_source_urls?: string[];
  source_urls: string[];
  status: FaraStatus;
}
