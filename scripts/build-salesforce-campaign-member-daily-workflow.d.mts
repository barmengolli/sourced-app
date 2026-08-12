export const APPROVED_PARENT_CAMPAIGNS: string[];
export const CONFIRMATION_PHRASE: string;
export const APPLY_BATCH_SIZE: number;
export const BUILD_APPLY_BATCHES_CODE: string;
export const MEMBER_QUERY_CODE: string;
export const NORMALIZE_CODE: string;
export const VERIFY_CODE: string;
export interface GeneratedWorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: number[];
  parameters: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}
export interface GeneratedWorkflow {
  name: string;
  nodes: GeneratedWorkflowNode[];
  pinData: Record<string, unknown>;
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
  active: boolean;
  settings: Record<string, unknown> & { timezone: string };
  versionId: string;
  meta: Record<string, unknown>;
  tags: unknown[];
}
export function buildWorkflow(): GeneratedWorkflow;
export function writeWorkflow(): Promise<void>;
