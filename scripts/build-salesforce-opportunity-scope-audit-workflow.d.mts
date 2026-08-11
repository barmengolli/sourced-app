export const REPORTING_YEARS: number[];
export const INCLUDED_RECORD_TYPES: string[];
export const MARKET_FIELD_API_NAME: string;
export const BDR_IDENTITIES: Array<{ key: string; acceptedNames: string[] }>;
export const CONFIG_CODE: string;
export const VALIDATE_BDR_CODE: string;
export const RESOLVE_FIELDS_CODE: string;
export const AGGREGATE_CODE: string;
export const GUARD_CODE: string;
export function buildWorkflow(): {
  name: string;
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    typeVersion: number;
    position: number[];
    parameters: Record<string, unknown>;
  }>;
  pinData: Record<string, unknown>;
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
  active: boolean;
  settings: Record<string, unknown>;
  versionId: string;
  meta: Record<string, unknown>;
  tags: unknown[];
};
export function writeWorkflow(): Promise<void>;
