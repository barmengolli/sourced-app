import type { ChannelSpendBreakdown } from './compute';

export interface FunnelInvestmentSummary {
  coveredChannelCount: number;
  totalCost: number;
  totalLeads: number;
  totalMqls: number;
  totalPipeline: number;
  totalWon: number;
  costPerLead: number | null;
  costPerMql: number | null;
  realizedRoi: number | null;
  pipelineCoverage: number | null;
}

export function summarizeFunnelInvestment(
  breakdown: ChannelSpendBreakdown[],
): FunnelInvestmentSummary {
  let coveredChannelCount = 0;
  let totalCost = 0;
  let totalLeads = 0;
  let totalMqls = 0;
  let totalPipeline = 0;
  let totalWon = 0;

  // Parent rows already contain their descendants. Summing leaves keeps the
  // executive totals identical to the audited Spend page without counting a
  // parent and its children twice.
  for (const row of breakdown) {
    if (row.isParent) continue;
    // Efficiency ratios are meaningful only where Sourced has recorded spend.
    // A zero-cost Website or organic row may mean "cost not measured", not
    // "this demand was free". Excluding it prevents understated CPL/CPMQL and
    // overstated ROI while preserving the detailed funnel counts elsewhere.
    if (row.allocatedCost <= 0) continue;
    coveredChannelCount += 1;
    totalCost += row.allocatedCost;
    totalLeads += row.leads;
    totalMqls += row.mqls;
    totalPipeline += row.pipelineAmount;
    totalWon += row.wonAmount;
  }

  return {
    coveredChannelCount,
    totalCost,
    totalLeads,
    totalMqls,
    totalPipeline,
    totalWon,
    costPerLead: totalLeads > 0 ? totalCost / totalLeads : null,
    costPerMql: totalMqls > 0 ? totalCost / totalMqls : null,
    realizedRoi: totalCost > 0 ? totalWon / totalCost : null,
    pipelineCoverage: totalCost > 0 ? totalPipeline / totalCost : null,
  };
}
