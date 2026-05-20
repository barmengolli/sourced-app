// Shared chronology + terminal-mutex validator for the deal-stage
// dates entered across the Create HPP modal's bulk-entry section and
// the Edit modal's "Other stage dates" section.
//
// Validation contract:
// 1. The non-terminal chain (HPP -> Opp -> Pursuit) must be
//    non-decreasing across the dates the user actually entered.
//    Empty dates are skipped, so a deal with just HPP + Pursuit is
//    valid as long as Pursuit >= HPP.
// 2. At most one of closeWon / closeLost may be set.
// 3. If a terminal date is set, it must be >= the latest non-terminal
//    date the user entered.

export interface DealStageDatesInput {
  hpp?: string;
  opp?: string;
  pursuit?: string;
  closeWon?: string;
  closeLost?: string;
}

export interface DealStageDatesValidation {
  ok: boolean;
  // Human-readable message for the inline error block. Null when
  // ok=true.
  error: string | null;
  // Disaggregated reason flags so callers can render finer-grained
  // UI hints (e.g. highlight a specific input) without re-parsing the
  // message string.
  bothTerminal: boolean;
  outOfOrder: boolean;
}

export function validateDealStageDates(
  input: DealStageDatesInput,
): DealStageDatesValidation {
  const { hpp, opp, pursuit, closeWon, closeLost } = input;

  const bothTerminal = Boolean(closeWon && closeLost);
  if (bothTerminal) {
    return {
      ok: false,
      error: 'A deal can be Closed Won or Closed Lost, not both.',
      bothTerminal: true,
      outOfOrder: false,
    };
  }

  const chronOrder = [hpp, opp, pursuit].filter(
    (d): d is string => Boolean(d),
  );
  for (let i = 1; i < chronOrder.length; i++) {
    if (chronOrder[i] < chronOrder[i - 1]) {
      return {
        ok: false,
        error:
          'Dates must be in chronological order: HPP <= Opp <= Pursuit <= Close.',
        bothTerminal: false,
        outOfOrder: true,
      };
    }
  }

  const terminal = closeWon || closeLost;
  if (terminal) {
    const lastNonTerminal = pursuit || opp || hpp;
    if (lastNonTerminal && terminal < lastNonTerminal) {
      return {
        ok: false,
        error:
          'Dates must be in chronological order: HPP <= Opp <= Pursuit <= Close.',
        bothTerminal: false,
        outOfOrder: true,
      };
    }
  }

  return { ok: true, error: null, bothTerminal: false, outOfOrder: false };
}
