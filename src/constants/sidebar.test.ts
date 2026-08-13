// Stale-navigation guard for sidebar sections: a stored last-visited tab
// that is no longer among a section's children (e.g. 'funnel-compare'
// after the Compare tab was hidden) must fall back to the default child.

import { describe, it, expect } from 'vitest';
import { SIDEBAR_SECTIONS, resolveSectionTarget } from './sidebar';

const funnel = SIDEBAR_SECTIONS.find((s) => s.id === 'funnel')!;

describe('resolveSectionTarget', () => {
  it('a stale stored funnel-compare falls back to the default child', () => {
    expect(resolveSectionTarget(funnel, 'funnel-compare')).toBe('funnel-dashboard');
  });

  it('a valid stored child is honored', () => {
    expect(resolveSectionTarget(funnel, 'funnel-spend')).toBe('funnel-spend');
  });

  it('no stored value lands on the default child', () => {
    expect(resolveSectionTarget(funnel, null)).toBe('funnel-dashboard');
  });

  it('the funnel section shows exactly the five visible tabs, Compare hidden', () => {
    expect(funnel.children.map((c) => c.key)).toEqual([
      'funnel-dashboard',
      'funnel-data',
      'funnel-velocity',
      'funnel-events',
      'funnel-spend',
    ]);
  });

  it('no sidebar child carries a beta flag anymore', () => {
    for (const section of SIDEBAR_SECTIONS) {
      for (const child of section.children) {
        expect('beta' in child).toBe(false);
      }
    }
  });
});
