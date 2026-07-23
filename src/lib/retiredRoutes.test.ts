// Tests for the Compare-tab retirement (Bite 3C): navigation absence and the
// legacy-route redirect. Pure/constant checks; no app mount, no network.

import { describe, it, expect } from 'vitest';
import { redirectRetiredPage } from './retiredRoutes';
import { SIDEBAR_SECTIONS, sectionForPage } from '../constants/sidebar';

describe('Outreach Compare retirement', () => {
  it('removes Compare from the Outreach sidebar navigation', () => {
    const outreach = SIDEBAR_SECTIONS.find((s) => s.id === 'outreach');
    expect(outreach).toBeTruthy();
    const keys = outreach!.children.map((c) => c.key);
    expect(keys).toContain('outreach-data');
    expect(keys).toContain('outreach-dashboard');
    expect(keys).not.toContain('outreach-compare');
  });

  it('redirects the legacy outreach-compare route to the Dashboard', () => {
    expect(redirectRetiredPage('outreach-compare')).toBe('outreach-dashboard');
  });

  it('leaves live routes unchanged, including Outreach Data', () => {
    expect(redirectRetiredPage('outreach-data')).toBe('outreach-data');
    expect(redirectRetiredPage('outreach-dashboard')).toBe('outreach-dashboard');
    expect(redirectRetiredPage('linkedin-dashboard')).toBe('linkedin-dashboard');
  });

  it('keeps the Outreach Data tab present and unchanged', () => {
    const outreach = SIDEBAR_SECTIONS.find((s) => s.id === 'outreach');
    expect(outreach!.children.some((c) => c.key === 'outreach-data' && c.label === 'Data')).toBe(true);
    // A retired key still resolves to the Outreach section (so persisted "last
    // tab" values are recognized before the redirect maps them forward).
    expect(sectionForPage('outreach-dashboard')?.id).toBe('outreach');
  });
});
