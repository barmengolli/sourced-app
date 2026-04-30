import { useCallback, useState } from 'react';
import { parseCsv, type ParsedCsv } from '../../lib/csv';

interface DropZoneProps {
  onParsed: (parsed: ParsedCsv, file: File) => void;
}

export default function DropZone({ onParsed }: DropZoneProps) {
  const [hover, setHover] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!file.name.toLowerCase().endsWith('.csv')) {
        setError('Please drop a .csv file.');
        return;
      }
      setParsing(true);
      try {
        const parsed = await parseCsv(file);
        onParsed(parsed, file);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Parse failed');
      } finally {
        setParsing(false);
      }
    },
    [onParsed],
  );

  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setHover(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <div className="space-y-3">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        className={
          'block border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ' +
          (hover
            ? 'border-indigo bg-indigo/5'
            : 'border-border bg-muted hover:border-charcoal/30')
        }
      >
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          disabled={parsing}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <p className="text-sm text-charcoal">
          {parsing ? 'Parsing CSV' : 'Drop a CSV here or click to choose a file.'}
        </p>
        <p className="mt-1 text-xs text-slate-muted">
          The file is parsed in your browser. Nothing is uploaded until you
          confirm the diff on the next step.
        </p>
      </label>
      {error && (
        <div className="text-sm text-danger border border-danger/40 bg-danger/5 rounded px-3 py-2">
          {error}
        </div>
      )}
    </div>
  );
}
