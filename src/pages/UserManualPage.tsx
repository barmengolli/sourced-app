export default function UserManualPage() {
  return (
    <div className="p-8 space-y-8 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold text-charcoal">
          User Manual
        </h1>
        <p className="mt-1 text-sm text-slate-muted">
          A quick reference for how to use Sourced day-to-day. For each
          section, what it shows and how to read it.
        </p>
      </header>

      <Section title="What Sourced is">
        <p>
          Sourced is the corrected, marketing-owned mirror of Salesforce
          lead and opportunity data. It exists so Marketing can fix bad
          dates and re-attribute deals without those edits being
          overwritten by Salesforce sync.
        </p>
      </Section>

      <Section title="Two views of the data">
        <p>
          <Strong>Data Entry uses cohort math.</Strong> Each column counts
          leads or deals that entered the funnel in the selected period AND
          whose next stage transition also happened in the same period.
          Conversion rates can never exceed 100%.
        </p>
        <p>
          <Strong>Opportunities uses snapshot math.</Strong> Any deal with
          at least one stage transition in the selected period appears
          here, regardless of when the deal was created. This is the
          working-pipeline view.
        </p>
        <p>
          When the two disagree, the cohort hid a cross-period deal.
          The snapshot is where you'll see it.
        </p>
      </Section>

      <Section title="Where to find what">
        <ul className="text-sm text-charcoal space-y-1">
          <Row label="Conversion rates and the funnel grid">
            Marketing Funnel → Data Entry
          </Row>
          <Row label="Where MQLs come from over the year">
            Marketing Funnel → Leads & MQLs
          </Row>
          <Row label="Event attendance and activation">
            Marketing Funnel → Events
          </Row>
          <Row label="Specific deal or active pipeline">
            Marketing Funnel → Opportunities
          </Row>
          <Row label="Cost per channel and ROI">
            Marketing Funnel → Spend (Beta)
          </Row>
          <Row label="Quarter-over-quarter comparison">
            Marketing Funnel → Compare (Beta)
          </Row>
          <Row label="BDR sequence performance">
            Outreach → Data / Dashboard / Compare
          </Row>
        </ul>
      </Section>

      <Section title="Marketing Funnel sub-tabs">
        <SubSection title="Data Entry">
          The funnel grid. Each row is a channel, each column is a stage
          (Lead, MQL, HPP, Opp, Pursuit, Closed Won, Closed Lost). Click
          any actual count cell to see the underlying deals.
        </SubSection>
        <SubSection title="Leads & MQLs">
          Read-only charts of how leads and MQLs are distributed across
          the year. Per-month totals and per-month breakdowns by channel.
        </SubSection>
        <SubSection title="Events">
          Per-event activation tracking. Total contacts, active contacts
          (those with at least one activation), plus engagement counts
          for pre-event meetings, booth meetings, and session attendees.
        </SubSection>
        <SubSection title="Opportunities">
          The deal-side view. Velocity averages, distribution donuts,
          the Active Deals table, and the Opportunity Influence section
          showing each deal's full touch-to-close journey.
        </SubSection>
        <SubSection title="Spend" beta>
          Campaign cost and ROI per channel. Shows budgeted spend, leads
          generated, cost per lead, cost per MQL, first-touch opportunities,
          pipeline coverage, and won-based ROI. This tab is in Beta;
          no further development is planned until the rest of the
          Marketing Funnel is complete.
        </SubSection>
        <SubSection title="Compare" beta>
          Side-by-side period comparison at monthly granularity. Shows
          what changed between any two periods you select. This tab is in
          Beta; no further development is planned until the rest of the
          Marketing Funnel is complete.
        </SubSection>
      </Section>

      <Section title="Outreach sub-tabs">
        <SubSection title="Data">
          Weekly snapshots of BDR sequence performance. Each row is one
          sequence at a point in time; the data refreshes automatically
          every Thursday.
        </SubSection>
        <SubSection title="Dashboard">
          Current-week view of sequence performance with week-over-week
          deltas.
        </SubSection>
        <SubSection title="Compare">
          Side-by-side period comparison for sequences, same shape as
          the Marketing Funnel Compare tab.
        </SubSection>
      </Section>

      <Section title="Common tasks">
        <SubSection title="View deals in a funnel cell">
          Click any actual count cell on Data Entry. A modal opens listing
          every deal behind that count with Edit, Promote, Close Lost, and
          Delete buttons.
        </SubSection>
        <SubSection title="Change the time period">
          Each sub-tab has a year selector and Q1 / Q2 / Q3 / Q4 toggles
          at the top. "Year" shows the full year; quarter buttons narrow
          the view.
        </SubSection>
        <SubSection title="Filter by region">
          Region chips at the top of each sub-tab toggle which regions
          appear. "Clear" turns all five regions on at once.
        </SubSection>
        <SubSection title="Create a new HPP manually">
          Marketing Funnel → Data Entry → click "+ Create HPP". Fill in
          the deal metadata, the first touch, and any downstream stage
          dates you already have.
        </SubSection>
        <SubSection title="Edit a deal from the Opportunities tab">
          Find the deal in the Active Deals table, click the pencil icon
          to the left of the deal name. Edit any field, including
          downstream stage dates from the Other Stage Dates section.
        </SubSection>
        <SubSection title="Re-attribute a deal to a different channel">
          Open the deal via Edit, change the Channel selector, save. The
          Spend tab and Opportunity Influence Sankey will update
          immediately.
        </SubSection>
      </Section>

      <Section title="Glossary">
        <dl className="text-sm text-charcoal space-y-2">
          <Term name="Lead">
            A net-new inbound or outbound prospect. Tracked in HubSpot,
            synced to Salesforce.
          </Term>
          <Term name="MQL (Marketing Qualified Lead)">
            A Lead that meets qualification criteria.
          </Term>
          <Term name="HPP (High Potential Prospect / SQL)">
            A qualified opportunity. Created in Salesforce as a specific
            Opportunity record type.
          </Term>
          <Term name="Opp (Opportunity / SAO)">
            An HPP that has progressed to active sales engagement.
          </Term>
          <Term name="Pursuit">
            A late-stage Opportunity being actively pursued by sales.
          </Term>
          <Term name="Closed Won / Closed Lost">
            Terminal stages. The deal either closed successfully or died.
          </Term>
          <Term name="Channel">
            A marketing source (Website, Events, Marketing SDR, Content
            Syndication, etc.). Each lead has one source channel.
          </Term>
          <Term name="Cohort">
            A group of leads or deals defined by when they entered the
            funnel.
          </Term>
          <Term name="Snapshot">
            A view of data filtered by activity in a period, regardless
            of when the underlying lead or deal was created.
          </Term>
          <Term name="First-touch attribution">
            Crediting an entire deal to the channel that originally
            sourced the lead.
          </Term>
        </dl>
      </Section>

      <footer className="text-xs text-slate-muted italic pt-4 border-t border-border">
        Questions, feedback, or a section that's out of date? Slack
        Benjamin Armengolli.
      </footer>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-charcoal">{title}</h2>
      <div className="text-sm text-charcoal space-y-2">{children}</div>
    </section>
  );
}

function SubSection({
  title,
  children,
  beta,
}: {
  title: string;
  children: React.ReactNode;
  beta?: boolean;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium text-charcoal flex items-center gap-2">
        {title}
        {beta && (
          <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-warning/15 text-warning">
            Beta
          </span>
        )}
      </h3>
      <p className="text-sm text-slate-muted">{children}</p>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-slate-muted">{label}</span>
      <span className="text-charcoal">→ {children}</span>
    </li>
  );
}

function Term({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="font-medium text-charcoal inline">{name}.</dt>{' '}
      <dd className="text-slate-muted inline">{children}</dd>
    </div>
  );
}

function Strong({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-charcoal">{children}</span>;
}
