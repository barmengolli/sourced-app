import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('live Opportunity review queue contract', () => {
  const migration = read('migrations/2026-08-12_opportunity_review_queue_runtime.sql');
  const api = read('api/opportunity-queue.ts');
  const page = read('src/pages/FunnelDataEntryPage.tsx');
  const browserRepository = read('src/lib/opportunityQueueHttpRepository.ts');
  const workflow = JSON.parse(read('src/generated/salesforceOpportunityDaily.workflow.json')) as {
    nodes: Array<{ name: string; parameters?: { url?: string } }>;
    connections: Record<string, { main?: Array<Array<{ node: string }>> }>;
  };

  it('records the production application and keeps protected tables inaccessible to browser roles', () => {
    expect(migration).toContain('Applied manually to production on 2026-08-12');
    expect(migration).not.toContain('is PENDING');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
    expect(migration).not.toMatch(/CREATE POLICY/i);
  });

  it('makes approval, audit, exact linking, and projection refresh one database call', () => {
    const action = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.sf_apply_opportunity_review_action'),
      migration.indexOf('REVOKE ALL ON FUNCTION public.sf_refresh_opportunity_reporting'),
    );
    expect(action).toContain('UPDATE public.sf_opportunity_reviews');
    expect(action).toContain('INSERT INTO public.sf_opportunity_review_events');
    expect(action).toContain('INSERT INTO public.sf_opportunity_deal_links');
    expect(action).toContain('sf_refresh_opportunity_reporting(v_opp.id)');
    expect(action).toContain("v_deal_id := 'salesforce:' || v_opp.sf_opportunity_id");
  });

  it('reconciles only generated Salesforce attributions and never mutates manual rows', () => {
    const refresh = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.sf_refresh_opportunity_reporting'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.sf_refresh_all_approved'),
    );
    expect(refresh).toContain("DELETE FROM public.attributions\n  WHERE source_system = 'salesforce'");
    expect(refresh).not.toMatch(/UPDATE public\.attributions/i);
    expect(refresh).not.toMatch(/DELETE FROM public\.attributions[\s\S]*source_system = 'manual'/i);
    expect(refresh).toContain("v_opp.normalized_record_type_state IN ('opp', 'pursuit')");
    expect(refresh).toContain("v_opp.normalized_record_type_state = 'pursuit'");
  });

  it('uses a durable idempotency ledger and optimistic concurrency', () => {
    expect(migration).toContain('sf_opportunity_review_requests');
    expect(migration).toContain('append_only_sf_opportunity_review_requests');
    expect(migration).toContain('idempotency key already used for another request');
    expect(migration).toContain('review changed; reload and retry');
  });

  it('keeps the service key server-only and protects actions with session, origin, and CSRF checks', () => {
    expect(api).toContain("requiredEnv('SUPABASE_SERVICE_ROLE_KEY')");
    expect(api).toContain('HttpOnly; SameSite=Strict');
    expect(api).toContain('sameOrigin(req)');
    expect(api).toContain("header(req, 'x-sourced-csrf') !== session.csrf");
    expect(api).toContain('timingSafeEqual');
    expect(browserRepository).not.toContain('@supabase/supabase-js');
    expect(browserRepository).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(page).toContain('<OpportunityQueuePanel');
  });

  it('refreshes approved reporting after the nightly staging apply and before final verification', () => {
    const names = workflow.nodes.map((node) => node.name);
    expect(names).toContain('REFRESH: approved Opportunity reporting');
    const afterStaging = workflow.connections['VERIFY: staging apply']?.main?.[0]?.map((edge) => edge.node);
    const afterRefresh = workflow.connections['REFRESH: approved Opportunity reporting']?.main?.[0]?.map((edge) => edge.node);
    expect(afterStaging).toEqual(['REFRESH: approved Opportunity reporting']);
    expect(afterRefresh).toEqual(['VERIFY: apply result']);
  });
});
