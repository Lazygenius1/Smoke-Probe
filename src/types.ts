export type Severity = 'PASSED' | 'WARNING' | 'CRITICAL';

export type ViewportPreset = 'desktop' | 'tablet' | 'mobile';

export interface CheckResult {
  phase: string;
  checkName: string;
  status: Severity;
  summary: string;
  details: string;
  timestamp: string;
}

export interface RedirectHop {
  statusCode: number;
  fromUrl: string;
  toUrl: string;
}

export interface ImageProbeResult {
  src: string;
  alt: string;
  hasAltAttr: boolean;
  statusCode: number | null;
  ok: boolean;
  error?: string;
}

export interface ScriptProbeResult {
  src: string;
  statusCode: number | null;
  ok: boolean;
  mixedContent: boolean;
  error?: string;
}

export interface SmokeTestSummary {
  targetUrl: string;
  finalUrl: string;
  executedAt: string;
  viewportLabel: string;
  viewportWidth: number;
  viewportHeight: number;
  httpStatus: number | null;
  responseTimeMs: number | null;
  redirectHops: number;
  totalChecks: number;
  passed: number;
  warnings: number;
  critical: number;
  contentType: string;
  iframeAllowed: boolean;
  frameRestrictionReason: string;
}

export interface SmokeTestReport {
  summary: SmokeTestSummary;
  checks: CheckResult[];
  redirectChain: RedirectHop[];
  images: ImageProbeResult[];
  scripts: ScriptProbeResult[];
  previewHtml: string;
}
