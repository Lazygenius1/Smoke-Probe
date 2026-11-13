import {AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, XCircle} from 'lucide-react';
import {useState} from 'react';
import type {CheckResult, Severity} from '../types';

interface LogGroupProps {
  title: string;
  severity: Severity;
  items: CheckResult[];
  defaultExpanded?: boolean;
}

const SEVERITY_STYLES: Record<
  Severity,
  {
    textClass: string;
    surfaceClass: string;
    borderClass: string;
    label: string;
  }
> = {
  CRITICAL: {
    textClass: 'text-red-700',
    surfaceClass: 'bg-red-50/70',
    borderClass: 'border-red-200',
    label: 'Critical',
  },
  WARNING: {
    textClass: 'text-amber-700',
    surfaceClass: 'bg-amber-50/70',
    borderClass: 'border-amber-200',
    label: 'Warning',
  },
  PASSED: {
    textClass: 'text-emerald-700',
    surfaceClass: 'bg-emerald-50/60',
    borderClass: 'border-emerald-200',
    label: 'Passed',
  },
};

function SeverityIcon({severity}: {severity: Severity}) {
  if (severity === 'CRITICAL') {
    return <XCircle className="h-4 w-4 text-red-600 shrink-0" aria-hidden="true" />;
  }
  if (severity === 'WARNING') {
    return <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" aria-hidden="true" />;
  }
  return <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" aria-hidden="true" />;
}

export function LogGroup({title, severity, items, defaultExpanded = false}: LogGroupProps) {
  const [openIndices, setOpenIndices] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    if (defaultExpanded) {
      items.forEach((_, idx) => {
        initial[idx] = true;
      });
    }
    return initial;
  });

  if (items.length === 0) {
    return null;
  }

  const styles = SEVERITY_STYLES[severity];

  const toggleItem = (idx: number) => {
    setOpenIndices((prev) => ({...prev, [idx]: !prev[idx]}));
  };

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between border-b border-slate-200 pb-2">
        <h3 className="text-sm font-semibold text-slate-900">
          {title}
          <span className="ml-2 font-mono text-xs font-medium text-slate-500 tabular-nums">
            ({items.length})
          </span>
        </h3>
        <span className={`text-xs font-medium ${styles.textClass}`}>{styles.label}</span>
      </div>

      <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white overflow-hidden">
        {items.map((item, idx) => {
          const isOpen = Boolean(openIndices[idx]);
          return (
            <div key={`${item.phase}-${item.checkName}-${idx}`}>
              <button
                type="button"
                onClick={() => toggleItem(idx)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <SeverityIcon severity={item.status} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                      <span className={`font-semibold ${styles.textClass}`}>{item.status}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.phase}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-slate-700">{item.checkName}</span>
                    </div>
                    <p className="mt-0.5 text-sm font-medium text-slate-900 break-words">
                      {item.summary}
                    </p>
                  </div>
                </div>
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                )}
              </button>

              {isOpen && (
                <div className={`border-t border-slate-200 px-4 py-3 ${styles.surfaceClass}`}>
                  {item.details ? (
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-800">
                      {item.details}
                    </pre>
                  ) : (
                    <p className="text-xs text-slate-600">No additional diagnostic output recorded.</p>
                  )}
                  <p className="mt-2 font-mono text-[11px] text-slate-500 tabular-nums">
                    Recorded {new Date(item.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
