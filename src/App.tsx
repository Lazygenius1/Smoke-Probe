import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileJson,
  FileSpreadsheet,
  Globe,
  Loader2,
  Play,
  Search,
} from 'lucide-react';
import {useMemo, useState} from 'react';
import {LogGroup} from './components/LogGroup';
import {PythonSourcePanel} from './components/PythonSourcePanel';
import {ViewportPreview} from './components/ViewportPreview';
import type {Severity, SmokeTestReport, ViewportPreset} from './types';

type ActiveTab = 'results' | 'visual' | 'export' | 'python';

const VIEWPORT_OPTIONS: Array<{id: ViewportPreset; label: string; dimensions: string}> = [
  {id: 'desktop', label: 'Desktop', dimensions: '1280×800'},
  {id: 'tablet', label: 'Tablet', dimensions: '768×1024'},
  {id: 'mobile', label: 'Mobile', dimensions: '375×812'},
];

function isValidHttpUrl(input: string): {valid: boolean; message: string} {
  const trimmed = input.trim();
  if (!trimmed) {
    return {valid: false, message: 'Enter a target URL to start testing.'};
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return {valid: false, message: 'URL must start with http:// or https://.'};
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
      return {valid: false, message: 'Enter a complete hostname (e.g., https://example.com).'};
    }
    return {valid: true, message: ''};
  } catch {
    return {valid: false, message: 'Invalid URL syntax.'};
  }
}

function escapeCsvField(value: string): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default function App() {
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [viewport, setViewport] = useState<ViewportPreset>('desktop');
  const [includeVisual, setIncludeVisual] = useState(true);
  const [scanScripts, setScanScripts] = useState(true);
  const [checkBrokenImages, setCheckBrokenImages] = useState(true);
  const [runA11ySeo, setRunA11ySeo] = useState(true);

  const [activeTab, setActiveTab] = useState<ActiveTab>('results');
  const [isRunning, setIsRunning] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressStage, setProgressStage] = useState('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [report, setReport] = useState<SmokeTestReport | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | Severity>('ALL');

  const urlValidation = useMemo(() => isValidHttpUrl(targetUrl), [targetUrl]);

  const executeSmokeTest = async (overrideUrl?: string) => {
    const urlToTest = (overrideUrl ?? targetUrl).trim();
    if (overrideUrl) {
      setTargetUrl(overrideUrl);
    }
    const check = isValidHttpUrl(urlToTest);
    if (!check.valid) {
      setErrorBanner(check.message);
      return;
    }

    setErrorBanner(null);
    setIsRunning(true);
    setProgressPct(18);
    setProgressStage('Phase 1/3: Checking HTTP status, redirects, and latency...');

    const stageTimer1 = setTimeout(() => {
      setProgressPct(52);
      setProgressStage('Phase 2/3: Probing DOM assets, scripts, and viewport layout...');
    }, 350);

    const stageTimer2 = setTimeout(() => {
      setProgressPct(80);
      setProgressStage('Phase 3/3: Running SEO & accessibility structural audit...');
    }, 850);

    try {
      const response = await fetch('/api/smoke-test', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          url: urlToTest,
          viewport,
          includeVisual,
          scanScripts,
          checkBrokenImages,
          runA11ySeo,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Smoke test failed (HTTP ${response.status})`);
      }

      setProgressPct(100);
      setProgressStage('All smoke test phases complete.');
      setReport(data as SmokeTestReport);
      if (activeTab === 'python') {
        setActiveTab('results');
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to complete smoke test.');
    } finally {
      clearTimeout(stageTimer1);
      clearTimeout(stageTimer2);
      setTimeout(() => {
        setIsRunning(false);
      }, 220);
    }
  };

  const downloadJson = () => {
    if (!report) return;
    const blob = new Blob(
      [JSON.stringify({summary: report.summary, checks: report.checks, redirectChain: report.redirectChain}, null, 2)],
      {type: 'application/json'},
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smoke_test_report_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadCsv = () => {
    if (!report) return;
    const headers = ['phase', 'checkName', 'status', 'summary', 'details', 'timestamp'];
    const rows = report.checks.map((c) =>
      [c.phase, c.checkName, c.status, c.summary, c.details, c.timestamp].map(escapeCsvField).join(','),
    );
    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smoke_test_report_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredChecks = useMemo(() => {
    if (!report) return [];
    const q = searchQuery.trim().toLowerCase();
    return report.checks.filter((c) => {
      if (statusFilter !== 'ALL' && c.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        c.phase.toLowerCase().includes(q) ||
        c.checkName.toLowerCase().includes(q) ||
        c.summary.toLowerCase().includes(q) ||
        c.details.toLowerCase().includes(q)
      );
    });
  }, [report, searchQuery, statusFilter]);

  const criticalChecks = useMemo(
    () => report?.checks.filter((c) => c.status === 'CRITICAL') ?? [],
    [report],
  );
  const warningChecks = useMemo(
    () => report?.checks.filter((c) => c.status === 'WARNING') ?? [],
    [report],
  );
  const passedChecks = useMemo(
    () => report?.checks.filter((c) => c.status === 'PASSED') ?? [],
    [report],
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="/"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            SmokeProbe
          </a>

          <nav
            aria-label="Dashboard sections"
            className="hidden md:flex items-center gap-6 text-sm font-medium"
          >
            {(
              [
                {id: 'results', label: 'Audit Results'},
                {id: 'visual', label: 'Visual Preview'},
                {id: 'export', label: 'Data & Export'},
                {id: 'python', label: 'Python Script'},
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                  activeTab === tab.id
                    ? 'border-slate-900 text-slate-900 font-semibold'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center shrink-0">
            <a
              href="/api/download/app.py"
              download="app.py"
              className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download app.py</span>
            </a>
          </div>
        </div>

        {/* Mobile tab navigation */}
        <div className="flex md:hidden items-center gap-4 overflow-x-auto border-t border-slate-100 px-4 py-2 text-xs font-medium">
          {(
            [
              {id: 'results', label: 'Audit Results'},
              {id: 'visual', label: 'Visual Preview'},
              {id: 'export', label: 'Data & Export'},
              {id: 'python', label: 'Python Script'},
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`py-1 whitespace-nowrap shrink-0 ${
                activeTab === tab.id ? 'text-slate-900 font-semibold underline underline-offset-4' : 'text-slate-500'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main Workspace */}
      <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col lg:flex-row gap-6 px-6 py-6">
        {/* Left Sidebar Configuration */}
        <aside className="w-full lg:w-[290px] shrink-0">
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-5">
            <div>
              <h1 className="text-sm font-semibold text-slate-900">Test Configuration</h1>
              <p className="mt-0.5 text-xs text-slate-500">
                Target URL, audit modules, and viewport profile.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="target-url-input" className="block text-xs font-semibold text-slate-700">
                Target Website URL
              </label>
              <div className="relative">
                <Globe
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="target-url-input"
                  type="url"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && urlValidation.valid && !isRunning) {
                      executeSmokeTest();
                    }
                  }}
                  placeholder="https://example.com"
                  className="w-full rounded-md border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>
              {targetUrl.trim().length > 0 && !urlValidation.valid && (
                <p className="text-xs text-red-700" role="alert">
                  {urlValidation.message}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-slate-500">
                <span>Presets:</span>
                {['https://example.com', 'https://news.ycombinator.com', 'https://www.wikipedia.org'].map(
                  (preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setTargetUrl(preset)}
                      className="font-medium text-slate-700 hover:text-slate-900 underline decoration-slate-300 underline-offset-2"
                    >
                      {preset.replace(/^https?:\/\/(www\.)?/, '')}
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4 space-y-2.5">
              <span className="block text-xs font-semibold text-slate-700">Audit Modules</span>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeVisual}
                  onChange={(e) => setIncludeVisual(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
                <span>Include viewport visual preview</span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scanScripts}
                  onChange={(e) => setScanScripts(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
                <span>Scan script assets &amp; mixed content</span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={checkBrokenImages}
                  onChange={(e) => setCheckBrokenImages(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
                <span>Check broken images</span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={runA11ySeo}
                  onChange={(e) => setRunA11ySeo(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
                <span>Run accessibility &amp; SEO checks</span>
              </label>
            </div>

            <div className="border-t border-slate-200 pt-4 space-y-2">
              <span className="block text-xs font-semibold text-slate-700">Viewport Size</span>
              <div className="grid grid-cols-1 gap-1.5">
                {VIEWPORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setViewport(opt.id)}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-xs transition-colors ${
                      viewport === opt.id
                        ? 'border-slate-900 bg-slate-900 text-white font-semibold'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 font-medium'
                    }`}
                  >
                    <span>{opt.label}</span>
                    <span
                      className={`font-mono tabular-nums ${
                        viewport === opt.id ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {opt.dimensions}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => executeSmokeTest()}
                disabled={!urlValidation.valid || isRunning}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>Running Smoke Test...</span>
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" aria-hidden="true" />
                    <span>Run Smoke Test</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="flex-1 min-w-0 space-y-6">
          {/* Error Banner */}
          {errorBanner && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">Smoke Test Execution Error</p>
                <p className="mt-0.5 text-xs text-red-700">{errorBanner}</p>
              </div>
            </div>
          )}

          {/* Dynamic Progress Indicator */}
          {isRunning && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                <span>{progressStage}</span>
                <span className="font-mono tabular-nums text-slate-500">{progressPct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-slate-900 transition-all duration-300"
                  style={{width: `${progressPct}%`}}
                />
              </div>
            </div>
          )}

          {activeTab === 'python' ? (
            <PythonSourcePanel />
          ) : !report ? (
            <div className="rounded-lg border border-slate-200 bg-white p-10 text-center space-y-4">
              <h2 className="text-lg font-semibold text-slate-900">
                Automated Web Smoke Testing Dashboard
              </h2>
              <p className="mx-auto max-w-xl text-sm text-slate-600 leading-relaxed">
                Validate any <code className="text-slate-900">http://</code> or{' '}
                <code className="text-slate-900">https://</code> endpoint across HTTP network health,
                asset &amp; script integrity, viewport layout risks, and SEO/accessibility structure.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => executeSmokeTest('https://example.com')}
                  disabled={isRunning}
                  className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition-colors"
                >
                  <Play className="h-4 w-4" aria-hidden="true" />
                  <span>Run Sample Audit (example.com)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('python')}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <span>Inspect Python app.py</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* 4-Column Summary Metrics Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <p className="text-xs font-medium text-slate-500">Checks Passed</p>
                  <p className="mt-1 text-2xl font-bold text-emerald-700 tabular-nums">
                    {report.summary.passed}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 tabular-nums">
                    Out of {report.summary.totalChecks} executed checks
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <p className="text-xs font-medium text-slate-500">Warnings</p>
                  <p
                    className={`mt-1 text-2xl font-bold tabular-nums ${
                      report.summary.warnings > 0 ? 'text-amber-700' : 'text-slate-900'
                    }`}
                  >
                    {report.summary.warnings}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Non-blocking SEO or latency flags
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <p className="text-xs font-medium text-slate-500">Critical Issues</p>
                  <p
                    className={`mt-1 text-2xl font-bold tabular-nums ${
                      report.summary.critical > 0 ? 'text-red-700' : 'text-slate-900'
                    }`}
                  >
                    {report.summary.critical}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Broken assets, errors, or layout overflow
                  </p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <p className="text-xs font-medium text-slate-500">HTTP &amp; Latency</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900 font-mono tabular-nums">
                    {report.summary.responseTimeMs !== null
                      ? `${report.summary.responseTimeMs} ms`
                      : 'N/A'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 tabular-nums">
                    {report.summary.httpStatus ? `HTTP ${report.summary.httpStatus}` : 'Conn Error'}
                    {' · '}
                    {report.summary.redirectHops} redirect(s)
                  </p>
                </div>
              </div>

              {/* Active Tab Content */}
              {activeTab === 'results' && (
                <div className="space-y-6">
                  {criticalChecks.length === 0 && warningChecks.length === 0 && (
                    <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" aria-hidden="true" />
                      <span>
                        All {report.summary.totalChecks} smoke checks passed cleanly for{' '}
                        <strong className="font-semibold">{report.summary.finalUrl}</strong>.
                      </span>
                    </div>
                  )}

                  <LogGroup
                    title="Critical Issues"
                    severity="CRITICAL"
                    items={criticalChecks}
                    defaultExpanded={true}
                  />

                  <LogGroup
                    title="Warnings"
                    severity="WARNING"
                    items={warningChecks}
                    defaultExpanded={true}
                  />

                  <LogGroup
                    title="Passed Checks"
                    severity="PASSED"
                    items={passedChecks}
                    defaultExpanded={false}
                  />

                  {report.redirectChain.length > 0 && (
                    <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                      <div className="border-b border-slate-200 px-4 py-3">
                        <h3 className="text-sm font-semibold text-slate-900">
                          HTTP Redirect Chain ({report.redirectChain.length} hop
                          {report.redirectChain.length > 1 ? 's' : ''})
                        </h3>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                            <tr>
                              <th className="px-4 py-2.5 font-semibold">Status</th>
                              <th className="px-4 py-2.5 font-semibold">From URL</th>
                              <th className="px-4 py-2.5 font-semibold">Location Target</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {report.redirectChain.map((hop, idx) => (
                              <tr key={idx}>
                                <td className="px-4 py-2.5 font-mono tabular-nums font-semibold text-slate-800">
                                  {hop.statusCode}
                                </td>
                                <td className="px-4 py-2.5 font-mono text-slate-600 break-all">
                                  {hop.fromUrl}
                                </td>
                                <td className="px-4 py-2.5 font-mono text-slate-800 break-all">
                                  {hop.toUrl}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                </div>
              )}

              {activeTab === 'visual' && (
                <ViewportPreview
                  summary={report.summary}
                  previewHtml={report.previewHtml}
                  images={report.images}
                  scripts={report.scripts}
                />
              )}

              {activeTab === 'export' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4">
                    <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[240px]">
                      <div className="relative flex-1 min-w-[200px] max-w-sm">
                        <Search
                          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                          aria-hidden="true"
                        />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Filter checks by keyword..."
                          className="w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                        />
                      </div>

                      <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
                        {(['ALL', 'CRITICAL', 'WARNING', 'PASSED'] as const).map((status) => (
                          <button
                            key={status}
                            type="button"
                            onClick={() => setStatusFilter(status)}
                            className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                              statusFilter === status
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {status === 'ALL' ? 'All' : status}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={downloadJson}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Download JSON</span>
                      </button>
                      <button
                        type="button"
                        onClick={downloadCsv}
                        className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Download CSV</span>
                      </button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                          <tr>
                            <th className="px-4 py-2.5 font-semibold">Phase</th>
                            <th className="px-4 py-2.5 font-semibold">Check</th>
                            <th className="px-4 py-2.5 font-semibold">Status</th>
                            <th className="px-4 py-2.5 font-semibold">Summary</th>
                            <th className="px-4 py-2.5 font-semibold text-right">Timestamp</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredChecks.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                                No audit records match the active filter.
                              </td>
                            </tr>
                          ) : (
                            filteredChecks.map((row, idx) => (
                              <tr key={`${row.checkName}-${idx}`} className="hover:bg-slate-50/70">
                                <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                                  {row.phase}
                                </td>
                                <td className="px-4 py-2.5 font-medium text-slate-900 whitespace-nowrap">
                                  {row.checkName}
                                </td>
                                <td className="px-4 py-2.5 font-semibold whitespace-nowrap">
                                  <span
                                    className={
                                      row.status === 'CRITICAL'
                                        ? 'text-red-700'
                                        : row.status === 'WARNING'
                                          ? 'text-amber-700'
                                          : 'text-emerald-700'
                                    }
                                  >
                                    {row.status}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-slate-700">{row.summary}</td>
                                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                                  {new Date(row.timestamp).toLocaleTimeString()}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
