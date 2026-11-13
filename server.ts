import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as cheerio from 'cheerio';
import express from 'express';
import {createServer as createViteServer} from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Severity = 'PASSED' | 'WARNING' | 'CRITICAL';

interface CheckResult {
  phase: string;
  checkName: string;
  status: Severity;
  summary: string;
  details: string;
  timestamp: string;
}

interface RedirectHop {
  statusCode: number;
  fromUrl: string;
  toUrl: string;
}

interface ImageProbeResult {
  src: string;
  alt: string;
  hasAltAttr: boolean;
  statusCode: number | null;
  ok: boolean;
  error?: string;
}

interface ScriptProbeResult {
  src: string;
  statusCode: number | null;
  ok: boolean;
  mixedContent: boolean;
  error?: string;
}

interface SmokeTestRequest {
  url: string;
  viewport?: 'desktop' | 'tablet' | 'mobile';
  includeVisual?: boolean;
  scanScripts?: boolean;
  checkBrokenImages?: boolean;
  runA11ySeo?: boolean;
  timeoutSeconds?: number;
}

const VIEWPORT_MAP: Record<string, {label: string; width: number; height: number}> = {
  desktop: {label: 'Desktop (1280x800)', width: 1280, height: 800},
  tablet: {label: 'Tablet (768x1024)', width: 768, height: 1024},
  mobile: {label: 'Mobile (375x812)', width: 375, height: 812},
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 SmokeProbe/1.0';

function nowIso(): string {
  return new Date().toISOString();
}

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === '169.254.169.254' || lower === 'metadata.google.internal') {
    return true;
  }
  if (lower.startsWith('169.254.')) {
    return true;
  }
  return false;
}

function validateUrl(rawUrl: string): {valid: true; url: URL} | {valid: false; error: string} {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return {valid: false, error: 'Please enter a target URL.'};
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {valid: false, error: 'Invalid URL format. Include http:// or https://.'};
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {valid: false, error: 'Target URL must begin with http:// or https://.'};
  }
  if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
    return {valid: false, error: 'Please provide a valid hostname (e.g., https://example.com).'};
  }
  if (isBlockedHost(parsed.hostname)) {
    return {valid: false, error: 'Target hostname is restricted for security reasons.'};
  }
  return {valid: true, url: parsed};
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

async function probeAsset(url: string, timeoutMs = 5000): Promise<{statusCode: number | null; ok: boolean; error?: string}> {
  try {
    let res = await fetchWithTimeout(
      url,
      {
        method: 'HEAD',
        redirect: 'follow',
        headers: {'User-Agent': USER_AGENT},
      },
      timeoutMs,
    );
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          redirect: 'follow',
          headers: {'User-Agent': USER_AGENT, Range: 'bytes=0-1023'},
        },
        timeoutMs,
      );
    }
    return {
      statusCode: res.status,
      ok: res.status >= 200 && res.status < 400,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Request failed';
    return {statusCode: null, ok: false, error: message};
  }
}

function buildSanitizedPreviewHtml(rawHtml: string, finalUrl: string): string {
  const $ = cheerio.load(rawHtml);
  $('script').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="X-Frame-Options"]').remove();

  // Resolve relative stylesheet and image URLs cleanly via <base>
  const head = $('head');
  if (head.length > 0) {
    $('base').remove();
    head.prepend(`<base href="${finalUrl.replace(/"/g, '&quot;')}" target="_blank" />`);
  } else {
    $.root().prepend(`<head><base href="${finalUrl.replace(/"/g, '&quot;')}" target="_blank" /></head>`);
  }
  return $.html();
}

async function runSmokeTest(body: SmokeTestRequest) {
  const validation = validateUrl(body.url);
  if (!validation.valid) {
    return {error: validation.error, statusCode: 400};
  }

  const targetUrl = validation.url.toString();
  const viewportKey = body.viewport && VIEWPORT_MAP[body.viewport] ? body.viewport : 'desktop';
  const viewport = VIEWPORT_MAP[viewportKey];
  const includeVisual = body.includeVisual !== false;
  const scanScripts = body.scanScripts !== false;
  const checkBrokenImages = body.checkBrokenImages !== false;
  const runA11ySeo = body.runA11ySeo !== false;
  const timeoutMs = Math.min(Math.max(Number(body.timeoutSeconds) || 15, 5), 45) * 1000;

  const checks: CheckResult[] = [];
  const redirectChain: RedirectHop[] = [];
  let finalUrl = targetUrl;
  let httpStatus: number | null = null;
  let responseTimeMs: number | null = null;
  let contentType = '';
  let htmlContent = '';
  let iframeAllowed = true;
  let frameRestrictionReason = '';

  // ---------------------------------------------------------------------------
  // Phase 1: HTTP & Network Health
  // ---------------------------------------------------------------------------
  const startTime = performance.now();
  try {
    let currentUrl = targetUrl;
    let response: Response | null = null;
    const maxHops = 10;

    for (let hop = 0; hop <= maxHops; hop++) {
      response = await fetchWithTimeout(
        currentUrl,
        {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
        timeoutMs,
      );

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          break;
        }
        const nextUrl = new URL(location, currentUrl).toString();
        redirectChain.push({
          statusCode: response.status,
          fromUrl: currentUrl,
          toUrl: nextUrl,
        });
        currentUrl = nextUrl;
        finalUrl = nextUrl;
        if (hop === maxHops) {
          throw new Error(`Exceeded maximum redirect hops (${maxHops}).`);
        }
      } else {
        finalUrl = currentUrl;
        break;
      }
    }

    responseTimeMs = Math.round(performance.now() - startTime);

    if (!response) {
      throw new Error('No HTTP response received.');
    }

    httpStatus = response.status;
    contentType = response.headers.get('content-type') || '';

    const xFrame = (response.headers.get('x-frame-options') || '').toLowerCase();
    const csp = (response.headers.get('content-security-policy') || '').toLowerCase();
    if (xFrame.includes('deny') || xFrame.includes('sameorigin')) {
      iframeAllowed = false;
      frameRestrictionReason = `X-Frame-Options: ${response.headers.get('x-frame-options')}`;
    } else if (csp.includes('frame-ancestors')) {
      iframeAllowed = false;
      frameRestrictionReason = 'Content-Security-Policy restricts frame-ancestors';
    }

    const bodyText = await response.text();
    if (contentType.toLowerCase().includes('text/html') || bodyText.slice(0, 600).toLowerCase().includes('<html')) {
      htmlContent = bodyText;
    }

    // Status Code Check
    if (httpStatus >= 200 && httpStatus < 300) {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'HTTP Status Code',
        status: 'PASSED',
        summary: `Server responded with HTTP ${httpStatus} OK.`,
        details: `Final URL: ${finalUrl} | Content-Type: ${contentType || 'N/A'}`,
        timestamp: nowIso(),
      });
    } else if (httpStatus >= 300 && httpStatus < 400) {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'HTTP Status Code',
        status: 'WARNING',
        summary: `Unresolved redirect status HTTP ${httpStatus}.`,
        details: `Final URL: ${finalUrl}`,
        timestamp: nowIso(),
      });
    } else {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'HTTP Status Code',
        status: 'CRITICAL',
        summary: `Endpoint returned error status HTTP ${httpStatus}.`,
        details: `Final URL: ${finalUrl} | Status: ${httpStatus} ${response.statusText}`,
        timestamp: nowIso(),
      });
    }

    // Redirect Chain Check
    if (redirectChain.length === 0) {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'Redirect Chain',
        status: 'PASSED',
        summary: 'No redirects encountered; direct resolution.',
        details: `Resolved directly at ${finalUrl}`,
        timestamp: nowIso(),
      });
    } else if (redirectChain.length <= 2) {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'Redirect Chain',
        status: 'PASSED',
        summary: `Clean redirect chain (${redirectChain.length} hop${redirectChain.length > 1 ? 's' : ''}).`,
        details: redirectChain.map((h) => `[${h.statusCode}] ${h.fromUrl} -> ${h.toUrl}`).join('\n'),
        timestamp: nowIso(),
      });
    } else {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'Redirect Chain',
        status: 'WARNING',
        summary: `Long redirect chain detected (${redirectChain.length} hops).`,
        details: redirectChain.map((h) => `[${h.statusCode}] ${h.fromUrl} -> ${h.toUrl}`).join('\n'),
        timestamp: nowIso(),
      });
    }

    // Latency Check
    if (responseTimeMs <= 1500) {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'Response Latency',
        status: 'PASSED',
        summary: `Fast response time (${responseTimeMs} ms).`,
        details: 'Threshold: <= 1,500 ms optimal, > 3,500 ms critical.',
        timestamp: nowIso(),
      });
    } else if (responseTimeMs <= 3500) {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'Response Latency',
        status: 'WARNING',
        summary: `Elevated response time (${responseTimeMs} ms).`,
        details: 'Consider inspecting server TTFB, CDN caching, or payload size.',
        timestamp: nowIso(),
      });
    } else {
      checks.push({
        phase: 'Phase 1: HTTP & Network',
        checkName: 'Response Latency',
        status: 'CRITICAL',
        summary: `Severe response latency (${responseTimeMs} ms).`,
        details: 'Response exceeded 3,500 ms smoke test threshold.',
        timestamp: nowIso(),
      });
    }
  } catch (err) {
    responseTimeMs = Math.round(performance.now() - startTime);
    const message = err instanceof Error ? err.message : 'Network request failed';
    const isAbort = err instanceof Error && err.name === 'AbortError';
    checks.push({
      phase: 'Phase 1: HTTP & Network',
      checkName: isAbort ? 'Network Timeout' : 'Network Connectivity',
      status: 'CRITICAL',
      summary: isAbort
        ? `HTTP request timed out after ${timeoutMs / 1000} seconds.`
        : 'Unable to establish HTTP connection to target host.',
      details: message,
      timestamp: nowIso(),
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 2: DOM Assets, Script Integrity & Layout Risk Probes
  // ---------------------------------------------------------------------------
  const imageResults: ImageProbeResult[] = [];
  const scriptResults: ScriptProbeResult[] = [];
  let previewHtml = '';

  if (htmlContent) {
    const $ = cheerio.load(htmlContent);

    if (includeVisual) {
      previewHtml = buildSanitizedPreviewHtml(htmlContent, finalUrl);
    }

    // Check inline fixed widths / viewport overflow heuristics
    const viewportMetaContent = ($('meta[name="viewport"]').attr('content') || '').trim();
    const wideInlineElements: string[] = [];
    $('[style]').each((_, el) => {
      const style = ($(el).attr('style') || '').toLowerCase();
      const widthMatch = style.match(/(?:^|;)\s*(?:min-)?width\s*:\s*(\d+(?:\.\d+)?)px/);
      if (widthMatch) {
        const px = Number(widthMatch[1]);
        if (px > viewport.width) {
          wideInlineElements.push(`<${el.tagName} style="...width:${px}px...">`);
        }
      }
    });

    if (wideInlineElements.length > 0) {
      checks.push({
        phase: 'Phase 2: DOM & Asset Probe',
        checkName: 'Viewport Overflow Risk',
        status: 'CRITICAL',
        summary: `${wideInlineElements.length} element(s) declare fixed inline width > ${viewport.width}px (${viewport.label}).`,
        details: wideInlineElements.slice(0, 8).join('\n'),
        timestamp: nowIso(),
      });
    } else if (viewport.width < 1024 && !viewportMetaContent) {
      checks.push({
        phase: 'Phase 2: DOM & Asset Probe',
        checkName: 'Viewport Overflow Risk',
        status: 'WARNING',
        summary: `No <meta name="viewport"> found while testing ${viewport.label}.`,
        details: 'Mobile/tablet browsers may render a zoomed-out desktop layout causing horizontal scroll.',
        timestamp: nowIso(),
      });
    } else {
      checks.push({
        phase: 'Phase 2: DOM & Asset Probe',
        checkName: 'Viewport Overflow Risk',
        status: 'PASSED',
        summary: `No fixed-width inline overflow triggers detected for ${viewport.label}.`,
        details: viewportMetaContent
          ? `Viewport meta configured: ${viewportMetaContent}`
          : `Checked inline styles against ${viewport.width}px width.`,
        timestamp: nowIso(),
      });
    }

    // Broken Images Probe
    if (checkBrokenImages) {
      const imgElements = $('img').toArray();
      const rawImgs = imgElements.slice(0, 24).map((el) => {
        const rawSrc = ($(el).attr('src') || $(el).attr('data-src') || '').trim();
        const altAttr = $(el).attr('alt');
        let resolvedSrc = rawSrc;
        if (rawSrc && !rawSrc.startsWith('data:')) {
          try {
            resolvedSrc = new URL(rawSrc, finalUrl).toString();
          } catch {
            resolvedSrc = rawSrc;
          }
        }
        return {
          rawSrc,
          resolvedSrc,
          alt: altAttr || '(none)',
          hasAltAttr: altAttr !== undefined,
        };
      });

      const probed = await Promise.all(
        rawImgs.map(async (item): Promise<ImageProbeResult> => {
          if (!item.rawSrc) {
            return {
              src: '(missing src)',
              alt: item.alt,
              hasAltAttr: item.hasAltAttr,
              statusCode: null,
              ok: false,
              error: 'Empty or missing src attribute',
            };
          }
          if (item.rawSrc.startsWith('data:')) {
            return {
              src: `${item.rawSrc.slice(0, 48)}...`,
              alt: item.alt,
              hasAltAttr: item.hasAltAttr,
              statusCode: 200,
              ok: true,
            };
          }
          const result = await probeAsset(item.resolvedSrc);
          return {
            src: item.resolvedSrc,
            alt: item.alt,
            hasAltAttr: item.hasAltAttr,
            statusCode: result.statusCode,
            ok: result.ok,
            error: result.error,
          };
        }),
      );

      imageResults.push(...probed);
      const broken = probed.filter((p) => !p.ok);

      if (imgElements.length === 0) {
        checks.push({
          phase: 'Phase 2: DOM & Asset Probe',
          checkName: 'Image Asset Integrity',
          status: 'PASSED',
          summary: 'No <img> elements found on the page.',
          details: '0 image assets inspected.',
          timestamp: nowIso(),
        });
      } else if (broken.length === 0) {
        checks.push({
          phase: 'Phase 2: DOM & Asset Probe',
          checkName: 'Image Asset Integrity',
          status: 'PASSED',
          summary: `All ${probed.length} inspected image assets returned HTTP 2xx/3xx.`,
          details:
            imgElements.length > 24
              ? `Inspected first 24 of ${imgElements.length} total <img> elements.`
              : `Total <img> elements verified: ${probed.length}.`,
          timestamp: nowIso(),
        });
      } else {
        checks.push({
          phase: 'Phase 2: DOM & Asset Probe',
          checkName: 'Image Asset Integrity',
          status: 'CRITICAL',
          summary: `${broken.length} of ${probed.length} inspected image assets failed to load.`,
          details: broken
            .slice(0, 10)
            .map((b) => `- ${b.src} (${b.statusCode ? `HTTP ${b.statusCode}` : b.error || 'Error'})`)
            .join('\n'),
          timestamp: nowIso(),
        });
      }
    }

    // External Script Integrity & Mixed Content Scan
    if (scanScripts) {
      const isHttpsPage = finalUrl.startsWith('https://');
      const scriptTags = $('script[src]').toArray().slice(0, 18);

      const probedScripts = await Promise.all(
        scriptTags.map(async (el): Promise<ScriptProbeResult> => {
          const rawSrc = ($(el).attr('src') || '').trim();
          let resolved = rawSrc;
          try {
            resolved = new URL(rawSrc, finalUrl).toString();
          } catch {
            resolved = rawSrc;
          }
          const mixedContent = isHttpsPage && resolved.startsWith('http://');
          const res = await probeAsset(resolved);
          return {
            src: resolved,
            statusCode: res.statusCode,
            ok: res.ok,
            mixedContent,
            error: res.error,
          };
        }),
      );

      scriptResults.push(...probedScripts);
      const failedScripts = probedScripts.filter((s) => !s.ok);
      const mixedScripts = probedScripts.filter((s) => s.mixedContent);

      if (failedScripts.length === 0 && mixedScripts.length === 0) {
        checks.push({
          phase: 'Phase 2: DOM & Asset Probe',
          checkName: 'Script Assets & Mixed Content',
          status: 'PASSED',
          summary:
            probedScripts.length === 0
              ? 'No external <script src> dependencies failed or triggered mixed-content warnings.'
              : `All ${probedScripts.length} external script assets resolved cleanly over matching protocol.`,
          details: `External <script src> tags audited: ${probedScripts.length}.`,
          timestamp: nowIso(),
        });
      } else {
        if (failedScripts.length > 0) {
          checks.push({
            phase: 'Phase 2: DOM & Asset Probe',
            checkName: 'External Script Reachability',
            status: 'CRITICAL',
            summary: `${failedScripts.length} external <script> bundle(s) failed to load.`,
            details: failedScripts
              .slice(0, 10)
              .map((s) => `- ${s.src} (${s.statusCode ? `HTTP ${s.statusCode}` : s.error || 'Error'})`)
              .join('\n'),
            timestamp: nowIso(),
          });
        }
        if (mixedScripts.length > 0) {
          checks.push({
            phase: 'Phase 2: DOM & Asset Probe',
            checkName: 'Mixed Content Scripts',
            status: 'WARNING',
            summary: `${mixedScripts.length} HTTP script(s) referenced from an HTTPS page.`,
            details: mixedScripts.map((s) => `- ${s.src}`).join('\n'),
            timestamp: nowIso(),
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // Phase 3: Structural, SEO & Accessibility Audit (Cheerio)
    // -------------------------------------------------------------------------
    if (runA11ySeo) {
      // 1. <title>
      const titleText = $('title').first().text().trim();
      if (!titleText) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Page Title Presence',
          status: 'CRITICAL',
          summary: 'Missing or empty <title> tag.',
          details: 'Every HTML document should define a descriptive <title> in <head>.',
          timestamp: nowIso(),
        });
      } else if (titleText.length < 10 || titleText.length > 70) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Page Title Presence',
          status: 'WARNING',
          summary: `<title> present (${titleText.length} chars), outside ideal 10-70 char range.`,
          details: `Title: '${titleText}'`,
          timestamp: nowIso(),
        });
      } else {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Page Title Presence',
          status: 'PASSED',
          summary: `Valid <title> detected (${titleText.length} chars).`,
          details: `Title: '${titleText}'`,
          timestamp: nowIso(),
        });
      }

      // 2. <h1> uniqueness
      const h1s = $('h1')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim());

      if (h1s.length === 0) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'H1 Heading Uniqueness',
          status: 'WARNING',
          summary: 'No <h1> heading found on the page.',
          details: 'Recommended: Include exactly one primary <h1> describing the page topic.',
          timestamp: nowIso(),
        });
      } else if (h1s.length === 1) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'H1 Heading Uniqueness',
          status: 'PASSED',
          summary: 'Single unique <h1> heading confirmed.',
          details: `H1 text: '${(h1s[0] || '(empty)').slice(0, 140)}'`,
          timestamp: nowIso(),
        });
      } else {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'H1 Heading Uniqueness',
          status: 'WARNING',
          summary: `Multiple <h1> tags found (${h1s.length} total).`,
          details: h1s
            .slice(0, 5)
            .map((t) => `- '${t.slice(0, 60)}'`)
            .join('\n'),
          timestamp: nowIso(),
        });
      }

      // 3. Unlabeled form controls
      const labelForIds = new Set<string>();
      $('label[for]').each((_, el) => {
        const forVal = ($(el).attr('for') || '').trim();
        if (forVal) labelForIds.add(forVal);
      });

      const ignoredTypes = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
      let totalFormControls = 0;
      const unlabeledControls: Array<{tag: string; type: string; id: string; name: string}> = [];

      $('input, select, textarea').each((_, el) => {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? ($(el).attr('type') || 'text').trim().toLowerCase() : tag;
        if (tag === 'input' && ignoredTypes.has(type)) {
          return;
        }
        totalFormControls += 1;

        const id = ($(el).attr('id') || '').trim();
        const name = ($(el).attr('name') || '').trim();
        const ariaLabel = ($(el).attr('aria-label') || '').trim();
        const ariaLabelledBy = ($(el).attr('aria-labelledby') || '').trim();
        const titleAttr = ($(el).attr('title') || '').trim();
        const wrappedInLabel = $(el).parents('label').length > 0;

        const isLabeled = Boolean(
          (id && labelForIds.has(id)) || wrappedInLabel || ariaLabel || ariaLabelledBy || titleAttr,
        );
        if (!isLabeled) {
          unlabeledControls.push({
            tag,
            type,
            id: id || '(none)',
            name: name || '(none)',
          });
        }
      });

      if (totalFormControls === 0) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Form Input Labels',
          status: 'PASSED',
          summary: 'No interactive form inputs found to audit.',
          details: '0 form controls detected.',
          timestamp: nowIso(),
        });
      } else if (unlabeledControls.length === 0) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Form Input Labels',
          status: 'PASSED',
          summary: `All ${totalFormControls} form controls have accessible labels.`,
          details: 'Verified <label>, aria-label, aria-labelledby, or title attributes.',
          timestamp: nowIso(),
        });
      } else {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Form Input Labels',
          status: 'CRITICAL',
          summary: `${unlabeledControls.length} of ${totalFormControls} form elements lack an accessible label.`,
          details: unlabeledControls
            .slice(0, 10)
            .map((c) => `- <${c.tag} type='${c.type}' id='${c.id}' name='${c.name}'>`)
            .join('\n'),
          timestamp: nowIso(),
        });
      }

      // 4. Meta Description
      const metaDesc = ($('meta[name="description"], meta[name="Description"]').attr('content') || '').trim();
      if (metaDesc) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Meta Description',
          status: 'PASSED',
          summary: `Meta description found (${metaDesc.length} chars).`,
          details: metaDesc.slice(0, 160),
          timestamp: nowIso(),
        });
      } else {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Meta Description',
          status: 'WARNING',
          summary: "Missing <meta name='description'> tag.",
          details: 'Adding a meta description improves search snippet clarity.',
          timestamp: nowIso(),
        });
      }

      // 5. HTML lang
      const htmlLang = ($('html').attr('lang') || '').trim();
      if (htmlLang) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Document Language Attribute',
          status: 'PASSED',
          summary: `HTML lang attribute set ('${htmlLang}').`,
          details: 'Assists screen readers with pronunciation profiles.',
          timestamp: nowIso(),
        });
      } else {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Document Language Attribute',
          status: 'WARNING',
          summary: 'Missing lang attribute on <html> element.',
          details: 'Specify e.g. <html lang="en"> for assistive technologies.',
          timestamp: nowIso(),
        });
      }

      // 6. Image alt attributes
      const allImgs = $('img').toArray();
      const missingAltCount = allImgs.filter((el) => $(el).attr('alt') === undefined).length;
      if (allImgs.length > 0 && missingAltCount > 0) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Image Alt Attributes',
          status: 'WARNING',
          summary: `${missingAltCount} of ${allImgs.length} <img> tags omit the alt attribute.`,
          details: 'Provide descriptive alt text or alt="" for decorative graphics.',
          timestamp: nowIso(),
        });
      } else if (allImgs.length > 0) {
        checks.push({
          phase: 'Phase 3: SEO & Accessibility',
          checkName: 'Image Alt Attributes',
          status: 'PASSED',
          summary: `All ${allImgs.length} <img> tags declare an alt attribute.`,
          details: 'Accessible alternative text contract satisfied.',
          timestamp: nowIso(),
        });
      }
    }
  } else {
    checks.push({
      phase: 'Phase 3: SEO & Accessibility',
      checkName: 'HTML Document Parsing',
      status: 'CRITICAL',
      summary: 'No HTML content available for structural audit.',
      details: `Content-Type: ${contentType || 'unknown'}`,
      timestamp: nowIso(),
    });
  }

  const passedCount = checks.filter((c) => c.status === 'PASSED').length;
  const warningCount = checks.filter((c) => c.status === 'WARNING').length;
  const criticalCount = checks.filter((c) => c.status === 'CRITICAL').length;

  return {
    statusCode: 200,
    payload: {
      summary: {
        targetUrl,
        finalUrl,
        executedAt: nowIso(),
        viewportLabel: viewport.label,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        httpStatus,
        responseTimeMs,
        redirectHops: redirectChain.length,
        totalChecks: checks.length,
        passed: passedCount,
        warnings: warningCount,
        critical: criticalCount,
        contentType,
        iframeAllowed,
        frameRestrictionReason,
      },
      checks,
      redirectChain,
      images: imageResults,
      scripts: scriptResults,
      previewHtml,
    },
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.post('/api/smoke-test', async (req, res) => {
    try {
      const result = await runSmokeTest(req.body || {});
      if ('error' in result) {
        return res.status(result.statusCode).json({error: result.error});
      }
      return res.json(result.payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({error: msg});
    }
  });

  app.get('/api/python-source', async (_req, res) => {
    try {
      const [appPy, requirementsTxt] = await Promise.all([
        fs.readFile(path.join(__dirname, 'app.py'), 'utf-8'),
        fs.readFile(path.join(__dirname, 'requirements.txt'), 'utf-8'),
      ]);
      return res.json({appPy, requirementsTxt});
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to read Python files';
      return res.status(500).json({error: msg});
    }
  });

  app.get('/api/download/app.py', async (_req, res) => {
    try {
      const content = await fs.readFile(path.join(__dirname, 'app.py'), 'utf-8');
      res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="app.py"');
      return res.send(content);
    } catch {
      return res.status(404).send('app.py not found');
    }
  });

  app.get('/api/download/requirements.txt', async (_req, res) => {
    try {
      const content = await fs.readFile(path.join(__dirname, 'requirements.txt'), 'utf-8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="requirements.txt"');
      return res.send(content);
    } catch {
      return res.status(404).send('requirements.txt not found');
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`SmokeProbe server running on http://0.0.0.0:${port}`);
  });
}

startServer();
