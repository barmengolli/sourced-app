interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}

export default function ChartCard({
  title,
  subtitle,
  children,
  className = '',
}: ChartCardProps) {
  return (
    <section
      className={
        'border border-border rounded-lg bg-bg shadow-sm p-4 space-y-2 ' +
        className
      }
    >
      <header>
        <h3 className="text-sm font-semibold text-charcoal">{title}</h3>
        {subtitle && (
          <p className="text-xs text-slate-muted">{subtitle}</p>
        )}
      </header>
      {children}
    </section>
  );
}
