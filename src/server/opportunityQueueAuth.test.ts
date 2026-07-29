// Tests for the Bite 5C2B2A capability-based authorization core.

import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_FOR_ACTION,
  QUEUE_CAPABILITIES,
  authorizeAction,
  hasCapability,
} from './opportunityQueueAuth';
import type { QueueApiAction, QueueCapability } from './opportunityQueueAuth';
import { testPrincipal } from '../test/opportunityQueueServerTestKit';

const ACTIONS = Object.keys(CAPABILITY_FOR_ACTION) as QueueApiAction[];

describe('authorization decisions', () => {
  it('no principal is always unauthenticated, never a silent allow', () => {
    for (const action of ACTIONS) {
      expect(authorizeAction(null, action)).toEqual({ allowed: false, reason: 'unauthenticated' });
      expect(authorizeAction(undefined, action)).toEqual({ allowed: false, reason: 'unauthenticated' });
    }
    // A principal without a stable subject is not authenticated either.
    expect(authorizeAction(testPrincipal(['opportunity_queue:admin'], '  '), 'list_reviews')).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('an authenticated principal without the capability is forbidden', () => {
    const readOnly = testPrincipal(['opportunity_queue:read']);
    for (const action of ACTIONS.filter((a) => CAPABILITY_FOR_ACTION[a] !== 'opportunity_queue:read')) {
      expect(authorizeAction(readOnly, action)).toEqual({ allowed: false, reason: 'forbidden' });
    }
    expect(authorizeAction(testPrincipal([]), 'list_reviews')).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
  });

  it('each capability grants exactly its intended actions', () => {
    const expectations: Array<{ capability: QueueCapability; actions: QueueApiAction[] }> = [
      { capability: 'opportunity_queue:read', actions: ['list_reviews', 'get_review'] },
      {
        capability: 'opportunity_queue:review',
        actions: ['approve_review', 'ignore_review', 'block_review', 'reconsider_review'],
      },
      { capability: 'opportunity_queue:link', actions: ['link_exact'] },
    ];
    for (const { capability, actions } of expectations) {
      const principal = testPrincipal([capability]);
      for (const action of ACTIONS) {
        const expected = actions.includes(action);
        expect(authorizeAction(principal, action).allowed, `${capability} -> ${action}`).toBe(expected);
      }
    }
  });

  it('admin satisfies every capability requirement', () => {
    const admin = testPrincipal(['opportunity_queue:admin']);
    for (const action of ACTIONS) {
      expect(authorizeAction(admin, action).allowed).toBe(true);
    }
    for (const capability of QUEUE_CAPABILITIES) {
      expect(hasCapability(admin, capability)).toBe(true);
    }
  });

  it('capabilities are portable names, not identity-provider group names', () => {
    for (const capability of QUEUE_CAPABILITIES) {
      expect(capability).toMatch(/^opportunity_queue:[a-z_]+$/);
    }
  });
});
