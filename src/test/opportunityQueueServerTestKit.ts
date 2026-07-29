// opportunityQueueServerTestKit.ts: TEST-ONLY principals, idempotency store,
// and service wiring for the Opportunity Queue API foundation. Never
// imported by production code (a static test enforces this): real
// principals come only from the future PingOne OIDC session.

import type { QueueCapability, QueuePrincipal } from '../server/opportunityQueueAuth';
import type { OpportunityQueueServiceDeps } from '../server/opportunityQueueService';
import type { IdempotencyRecord, IdempotencyStore } from '../server/opportunityQueueServerRepository';
import type { OpportunityQueueItem } from '../lib/opportunityQueue';
import { createMemoryQueueRepository } from './opportunityQueueMemoryAdapter';
import type { MemoryAdapterOptions } from './opportunityQueueMemoryAdapter';
import { FIXED_NOW } from './fixtures/opportunityQueueFixtures';

export function testPrincipal(capabilities: QueueCapability[], subject = 'SYNTH-IDP-SUBJECT-1'): QueuePrincipal {
  return { subject, capabilities, displayName: 'Synthetic Reviewer' };
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) ?? null;
  }

  async put(key: string, record: IdempotencyRecord): Promise<void> {
    this.records.set(key, record);
  }
}

export function makeServiceDeps(
  seed: OpportunityQueueItem[],
  options: MemoryAdapterOptions = {},
): OpportunityQueueServiceDeps & {
  memoryRepository: ReturnType<typeof createMemoryQueueRepository>;
} {
  const memoryRepository = createMemoryQueueRepository(seed, options);
  return {
    repository: memoryRepository,
    memoryRepository,
    idempotency: new MemoryIdempotencyStore(),
    now: () => FIXED_NOW,
  };
}
