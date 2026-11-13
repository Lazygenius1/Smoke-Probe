import {Check, Copy, Download, Terminal} from 'lucide-react';
import {useEffect, useState} from 'react';

export function PythonSourcePanel() {
  const [appPy, setAppPy] = useState('');
  const [requirementsTxt, setRequirementsTxt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'cmd' | 'code' | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/python-source')
      .then(async (res) => {
        if (!res.ok) {
          throw new Error('Failed to load Python script source.');
        }
        return res.json();
      })
      .then((data) => {
        if (active) {
          setAppPy(data.appPy || '');
          setRequirementsTxt(data.requirementsTxt || '');
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load source.');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const installCommands = `pip install streamlit playwright beautifulsoup4 pandas requests\nplaywright install chromium\nstreamlit run app.py`;

  const copyText = async (text: string, key: 'cmd' | 'code') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Streamlit + Playwright + BeautifulSoup + Pandas Script
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Complete single-file Python implementation (<code className="text-slate-900">app.py</code>)
              for local or CI execution with headless Chromium full-page screenshots and JS console interception.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/api/download/requirements.txt"
              download="requirements.txt"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>requirements.txt</span>
            </a>
            <a
              href="/api/download/app.py"
              download="app.py"
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download app.py</span>
            </a>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3.5">
          <div className="flex items-center justify-between gap-2 pb-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Terminal className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
              <span>Quick Start Commands</span>
            </div>
            <button
              type="button"
              onClick={() => copyText(installCommands, 'cmd')}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              {copiedKey === 'cmd' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
          <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-slate-800">
            {installCommands}
          </pre>
        </div>

        {requirementsTxt && (
          <p className="mt-3 text-xs text-slate-500">
            Dependencies: <span className="font-mono text-slate-700">{requirementsTxt.trim().split('\n').join(' · ')}</span>
          </p>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <span className="font-mono text-xs font-semibold text-slate-700">app.py</span>
          <button
            type="button"
            onClick={() => copyText(appPy, 'code')}
            disabled={!appPy}
            className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {copiedKey === 'code' ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                <span>Copied Source</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Copy Source</span>
              </>
            )}
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading app.py source...</div>
        ) : error ? (
          <div className="p-6 text-sm text-red-700">{error}</div>
        ) : (
          <pre className="max-h-[620px] overflow-auto bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">
            <code>{appPy}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
