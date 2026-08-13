type RowWithId = { id: string };

/**
 * Offset pagination must never return the same database row twice. A duplicate
 * means at least one other row may have been skipped, so reporting should fail
 * closed instead of publishing a plausible but incorrect total.
 */
export function assertUniquePagedIds(
  rows: readonly RowWithId[],
  datasetLabel: string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new Error(
        `${datasetLabel} pagination returned duplicate rows; refusing incomplete reporting data.`,
      );
    }
    seen.add(row.id);
  }
}
