// Shared delta display (CLAUDE.md section 4). Renders a DeltaResult with an
// arrow, sign, textual label, and color. Color never carries meaning alone:
// every state also has an arrow/label and an accessible name. Neutral metrics
// and the no-data / no-change states read as neutral.

import type { DeltaResult } from '../../lib/reportingDeltas';
import { describeDelta } from '../../lib/reportingDeltas';

interface DeltaDisplayProps {
  result: DeltaResult;
  // Unit appended to the absolute value, e.g. "pp" for rate deltas.
  unit?: string;
}

// Tone -> text color token. Kept minimal and flat per brand rules.
const TONE_CLASS: Record<DeltaResult['tone'], string> = {
  positive: 'text-success',
  negative: 'text-danger',
  neutral: 'text-slate-muted',
};

// Arrow glyph per tone/kind. The arrow conveys direction without relying on
// color; no-data and no-change use a neutral dash.
function glyphFor(result: DeltaResult): string {
  if (result.kind === 'delta' || result.kind === 'new') {
    const abs = result.absolute ?? 0;
    if (abs > 0) return '↑'; // up arrow
    if (abs < 0) return '↓'; // down arrow
    return '→'; // right arrow (no movement)
  }
  return '–'; // en dash for no_change / no_*_data
}

export default function DeltaDisplay({ result, unit = '' }: DeltaDisplayProps) {
  const text = describeDelta(result, unit);
  const glyph = glyphFor(result);
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums ${TONE_CLASS[result.tone]}`}
      data-testid="delta-display"
      data-kind={result.kind}
      data-tone={result.tone}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{text}</span>
    </span>
  );
}
