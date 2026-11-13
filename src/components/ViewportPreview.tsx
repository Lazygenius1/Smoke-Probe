import {ExternalLink, Monitor, Smartphone, Tablet} from 'lucide-react';
import {useState} from 'react';
import type {ImageProbeResult, ScriptProbeResult, SmokeTestSummary} from '../types';

interface ViewportPreviewProps {
  summary: SmokeTestSummary;
  previewHtml: string;
  images: ImageProbeResult[];
  scripts: ScriptProbeResult[];
}

export function ViewportPreview({summary, previewHtml, images, scripts}: ViewportPreviewProps) {
  const [mode, setMode] = useState<'snapshot' | 'live'>(
    summary.iframeAllowed ? 'live' : 'snapshot',
  );

  const scale =
    summary.viewportWidth >= 1200 ? 0.68 : summary.viewportWidth >= 700 ? 0.8 : 1;
  const scaledHeight = Math.min(Math.round(summary.viewportHeight * scale), 620);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            {summary.viewportWidth >= 1200 ? (
              <Monitor className="h-4 w-4 text-slate-500 shrink-0" aria-hidden="true" />
            ) : summary.viewportWidth >= 700 ? (
              <Tablet className="h-4 w-4 text-slate-500 shrink-0" aria-hidden="true" />
            ) : (
              <Smartphone className="h-4 w-4 text-slate-500 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 truncate">
                {summary.viewportLabel}
              </p>
              <p className="text-xs text-slate-500 truncate">
                {summary.finalUrl}
                {!summary.iframeAllowed && summary.frameRestrictionReason
                  ? ` · ${summary.frameRestrictionReason} (showing sanitized HTML snapshot)`
                  : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {summary.iframeAllowed && (
              <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setMode('live')}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                    mode === 'live'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Live Frame
                </button>
                <button
                  type="button"
                  onClick={() => setMode('snapshot')}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                    mode === 'snapshot'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  HTML Snapshot
                </button>
              </div>
            )}

            <a
              href={summary.finalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <span>Open Target</span>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="flex justify-center overflow-x-auto bg-slate-100/80 p-6">
          {previewHtml || mode === 'live' ? (
            <div
              className="overflow-hidden rounded-md border border-slate-300 bg-white"
              style={{
                width: `${Math.round(summary.viewportWidth * scale)}px`,
                height: `${scaledHeight}px`,
              }}
            >
              {mode === 'live' && summary.iframeAllowed ? (
                <iframe
                  title={`Live viewport preview of ${summary.finalUrl}`}
                  src={summary.finalUrl}
                  style={{
                    width: `${summary.viewportWidth}px`,
                    height: `${Math.round(scaledHeight / scale)}px`,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                  }}
                  className="border-0 bg-white"
                />
              ) : (
                <iframe
                  title={`Sanitized HTML snapshot of ${summary.finalUrl}`}
                  srcDoc={previewHtml}
                  sandbox="allow-same-origin"
                  style={{
                    width: `${summary.viewportWidth}px`,
                    height: `${Math.round(scaledHeight / scale)}px`,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                  }}
                  className="border-0 bg-white"
                />
              )}
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-slate-500">
              Visual preview disabled or target returned non-HTML content.
            </div>
          )}
        </div>
      </div>

      {images.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Image Asset Probe ({images.length})
            </h3>
            <p className="text-xs text-slate-500">
              Server-verified HTTP reachability and alt attribute compliance across detected image tags.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Asset URL</th>
                  <th className="px-4 py-2.5 font-semibold">Alt Attribute</th>
                  <th className="px-4 py-2.5 font-semibold text-right">HTTP Status</th>
                  <th className="px-4 py-2.5 font-semibold text-right">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {images.map((img, idx) => (
                  <tr key={`${img.src}-${idx}`} className="hover:bg-slate-50/70">
                    <td className="max-w-md truncate px-4 py-2.5 font-mono text-slate-800" title={img.src}>
                      {img.src}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2.5 text-slate-600">
                      {img.hasAltAttr ? img.alt : <span className="text-amber-700">Missing alt</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">
                      {img.statusCode ?? 'ERR'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold">
                      {img.ok ? (
                        <span className="text-emerald-700">OK</span>
                      ) : (
                        <span className="text-red-700">BROKEN</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {scripts.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-900">
              External Script Asset Probe ({scripts.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Script Source</th>
                  <th className="px-4 py-2.5 font-semibold text-right">HTTP Status</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Protocol</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scripts.map((scr, idx) => (
                  <tr key={`${scr.src}-${idx}`} className="hover:bg-slate-50/70">
                    <td className="max-w-lg truncate px-4 py-2.5 font-mono text-slate-800" title={scr.src}>
                      {scr.src}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      <span className={scr.ok ? 'text-emerald-700' : 'text-red-700'}>
                        {scr.statusCode ?? 'ERR'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium">
                      {scr.mixedContent ? (
                        <span className="text-amber-700">Mixed HTTP</span>
                      ) : (
                        <span className="text-slate-600">Clean</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
