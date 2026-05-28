// Monday Workforms can usually be embedded by swapping the public
// /forms/{id} path for /forms/embed/{id}. If Monday's iframe policy
// blocks it on Sourced's domain, the "Open in new tab" button above
// is the always-working fallback.
const FORM_URL =
  'https://forms.monday.com/forms/6dbaf9a142e6359b06187cd773d1cf7d?r=use1';
const FORM_EMBED_URL =
  'https://forms.monday.com/forms/embed/6dbaf9a142e6359b06187cd773d1cf7d?r=use1';

export default function FeedbackPage() {
  return (
    <div className="p-8 space-y-4 max-w-4xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-charcoal">
            Feedback & Bug Reports
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Submit your feedback and bug reports here.
          </p>
        </div>
        <a
          href={FORM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm px-3 py-1.5 rounded bg-indigo text-white hover:bg-indigo/90 whitespace-nowrap shrink-0"
        >
          Open in new tab →
        </a>
      </header>

      <div className="border border-border rounded-lg bg-bg overflow-hidden">
        <iframe
          src={FORM_EMBED_URL}
          title="Sourced Feedback & Bug Report Form"
          className="w-full"
          style={{ height: '900px', border: 'none' }}
          loading="lazy"
        />
      </div>

      <p className="text-xs text-slate-muted italic">
        If the form doesn't load above, click "Open in new tab" to
        submit your feedback. All submissions land on Ben's Monday board
        and are triaged on a weekly cadence.
      </p>
    </div>
  );
}
