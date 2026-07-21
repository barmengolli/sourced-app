// @vitest-environment jsdom
//
// Component tests for ReportingBasisDisclosure: the five basis labels,
// explanatory text, and that it renders as neutral information (a note), not a
// selectable filter or a warning.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ReportingBasisDisclosure from './ReportingBasisDisclosure';
import type { ReportingBasis } from '../../types/reporting';

afterEach(cleanup);

const cases: Array<{ basis: ReportingBasis; label: string }> = [
  { basis: 'cohort', label: 'Cohort' },
  { basis: 'activity', label: 'Activity' },
  { basis: 'snapshot', label: 'Snapshot' },
  { basis: 'derived_activity', label: 'Derived activity' },
  { basis: 'allocation', label: 'Allocation' },
];

describe('ReportingBasisDisclosure', () => {
  it.each(cases)('renders the $label badge with an accessible name', ({ basis, label }) => {
    render(<ReportingBasisDisclosure basis={basis} explanation="based on marketing sourced date" />);
    const note = screen.getByRole('note', { name: `Reporting basis: ${label}` });
    expect(note.textContent).toBe(label);
  });

  it('shows the concise explanation / effective date beside the badge', () => {
    render(<ReportingBasisDisclosure basis="snapshot" explanation="as of July 31, 2026" />);
    expect(screen.getByTestId('reporting-basis-disclosure').textContent).toContain('as of July 31, 2026');
  });

  it('is informational, not interactive: no button, radio, or alert role', () => {
    render(<ReportingBasisDisclosure basis="cohort" explanation="based on first MQL date" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
