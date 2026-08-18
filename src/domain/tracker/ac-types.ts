export const EVIDENCE_TYPES = ['test', 'curl', 'log', 'manual', 'bash', 'none'] as const;
export type EvidenceType = typeof EVIDENCE_TYPES[number];

export interface ACItem {
  index: number;
  text: string;
  evidenceType: EvidenceType;
  checkCommand: string;
}

export interface AcceptanceCriteria {
  items: ACItem[];
  source: 'labels' | 'legacy' | 'none';
}
