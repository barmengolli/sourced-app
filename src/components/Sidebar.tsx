import { useEffect, useState } from 'react';
import type { PageKey } from '../App';
import {
  SIDEBAR_SECTIONS,
  UTILITY_PAGES,
  resolveSectionTarget,
  type SidebarChild,
  type SidebarSection,
} from '../constants/sidebar';
import { readJson, writeJson } from '../lib/storage';

interface SidebarProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
}

export default function Sidebar({ page, onNavigate }: SidebarProps) {
  return (
    <aside className="w-56 border-r border-border bg-muted flex flex-col">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-border">
        <img
          src="/sourced-mark.png"
          alt=""
          className="w-7 h-7 object-contain"
        />
        <span className="text-lg font-semibold text-charcoal lowercase">
          sourced
        </span>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {SIDEBAR_SECTIONS.map((section) => (
          <SidebarSectionView
            key={section.id}
            section={section}
            page={page}
            onNavigate={onNavigate}
          />
        ))}

        <div className="my-2 border-t border-border" />

        {UTILITY_PAGES.map((u) => (
          <UtilityNavButton
            key={u.key}
            child={u}
            page={page}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </aside>
  );
}

interface SidebarSectionViewProps {
  section: SidebarSection;
  page: PageKey;
  onNavigate: (page: PageKey) => void;
}

function SidebarSectionView({
  section,
  page,
  onNavigate,
}: SidebarSectionViewProps) {
  const [expanded, setExpanded] = useState<boolean>(() =>
    readJson<boolean>(section.expandedStorageKey, true),
  );

  useEffect(() => {
    writeJson(section.expandedStorageKey, expanded);
  }, [section.expandedStorageKey, expanded]);

  const childIsActive = section.children.some((c) => c.key === page);

  const handleParentClick = () => {
    // Click the parent label = jump to whatever sub-tab the user was last on,
    // falling back to the section's default child. resolveSectionTarget
    // guards stale stored values pointing at hidden tabs.
    const last = readJson<PageKey | null>(section.lastTabStorageKey, null);
    onNavigate(resolveSectionTarget(section, last));
  };

  return (
    <div>
      <div
        className={
          'flex items-center gap-1 rounded-md transition-colors ' +
          (childIsActive
            ? 'border-l-2 border-indigo bg-indigo/5'
            : 'border-l-2 border-transparent')
        }
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? `Collapse ${section.label}` : `Expand ${section.label}`}
          aria-expanded={expanded}
          className="px-1 py-2 text-slate-muted hover:text-charcoal text-xs"
        >
          <span className="inline-block w-3">{expanded ? '▼' : '▶'}</span>
        </button>
        <button
          type="button"
          onClick={handleParentClick}
          className={
            'flex-1 text-left px-2 py-2 text-sm font-semibold transition-colors ' +
            (childIsActive
              ? 'text-charcoal'
              : 'text-charcoal hover:text-charcoal')
          }
        >
          {section.label}
        </button>
      </div>

      {expanded && (
        <div className="ml-4 mt-1 space-y-1">
          {section.children.map((child) => {
            const active = child.key === page;
            return (
              <button
                key={child.key}
                type="button"
                onClick={() => onNavigate(child.key)}
                className={
                  'w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors ' +
                  (active
                    ? 'bg-indigo text-white font-medium'
                    : 'text-charcoal hover:bg-border/60')
                }
              >
                <span className="flex items-center gap-1.5">
                  {child.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface UtilityNavButtonProps {
  child: SidebarChild;
  page: PageKey;
  onNavigate: (page: PageKey) => void;
}

function UtilityNavButton({ child, page, onNavigate }: UtilityNavButtonProps) {
  const active = child.key === page;
  return (
    <button
      type="button"
      onClick={() => onNavigate(child.key)}
      className={
        'w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ' +
        (active
          ? 'bg-indigo text-white'
          : 'text-charcoal hover:bg-border/60')
      }
    >
      <span className="flex items-center gap-1.5">
        {child.label}
      </span>
    </button>
  );
}
