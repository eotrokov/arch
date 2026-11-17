export interface Finding {
  rule: string;
  level: 'error' | 'warning' | 'attention';
  message: string;
  nodeIds: string[];
  edgeIds: string[];
  file?: string;
}
