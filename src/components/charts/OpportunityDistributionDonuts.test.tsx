// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ChannelDistributionDonut from './ChannelDistributionDonut';
import RegionDistributionDonut from './RegionDistributionDonut';

describe('opportunity distribution donut percentages', () => {
  it('shows precise region shares instead of whole-number rounding that can exceed 100%', () => {
    render(
      <RegionDistributionDonut
        distribution={{
          totalDeals: 40,
          totalAmount: 4_000_000,
          regions: [
            {
              region: 'NA',
              dealCount: 15,
              totalAmount: 1_500_000,
              percentageOfCount: 37.5,
            },
            {
              region: 'UK&IRE, ME, Japan',
              dealCount: 13,
              totalAmount: 1_300_000,
              percentageOfCount: 32.5,
            },
            {
              region: 'EMEA cont & LATAM',
              dealCount: 11,
              totalAmount: 1_100_000,
              percentageOfCount: 27.5,
            },
            {
              region: 'Other',
              dealCount: 1,
              totalAmount: 100_000,
              percentageOfCount: 2.5,
            },
          ],
        }}
      />,
    );

    for (const percentage of ['37.5%', '32.5%', '27.5%', '2.5%']) {
      expect(screen.getByText(percentage)).toBeTruthy();
    }
  });

  it('shows precise channel shares instead of independently rounded whole percentages', () => {
    render(
      <ChannelDistributionDonut
        distribution={{
          totalDeals: 40,
          totalAmount: 4_000_000,
          channels: [
            {
              channelId: 'sales-generated',
              channelName: '2025 - Sales Generated',
              displayLabel: '2025 - Sales Generated',
              dealCount: 7,
              totalAmount: 700_000,
              percentageOfCount: 17.5,
            },
            {
              channelId: 'website',
              channelName: '2026 - Website',
              displayLabel: '2026 - Website',
              dealCount: 33,
              totalAmount: 3_300_000,
              percentageOfCount: 82.5,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('17.5%')).toBeTruthy();
    expect(screen.getByText('82.5%')).toBeTruthy();
  });
});
