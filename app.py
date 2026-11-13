"""
================================================================================
Web Smoke Testing Dashboard
Built with Streamlit, Playwright, BeautifulSoup4, Requests, and Pandas
================================================================================

INSTALLATION INSTRUCTIONS
-------------------------
1. Ensure Python 3.9+ is installed, then create & activate a virtual environment:
       python -m venv .venv
       source .venv/bin/activate        # macOS / Linux
       .venv\\Scripts\\activate         # Windows

2. Install required Python packages:
       pip install streamlit playwright beautifulsoup4 pandas requests

   (Or install from the included requirements file:)
       pip install -r requirements.txt

3. Install Playwright headless Chromium browser binaries:
       playwright install chromium

   (On Linux CI/servers, you may also need system dependencies:)
       playwright install-deps chromium

4. Run the Streamlit application:
       streamlit run app.py

================================================================================
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

import pandas as pd
import requests
import streamlit as st
from bs4 import BeautifulSoup
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

# ------------------------------------------------------------------------------
# Type Definitions & Data Models
# ------------------------------------------------------------------------------

Severity = Literal["PASSED", "WARNING", "CRITICAL"]

VIEWPORT_PRESETS: dict[str, tuple[int, int]] = {
    "Desktop (1280x800)": (1280, 800),
    "Tablet (768x1024)": (768, 1024),
    "Mobile (375x812)": (375, 812),
}

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36 SmokeTestBot/1.0"
)


@dataclass
class CheckResult:
    """Represents a single categorized smoke test finding."""

    phase: str
    check_name: str
    status: Severity
    summary: str
    details: str = ""
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )


@dataclass
class HttpAuditData:
    """Aggregated HTTP and network health metrics from Phase 1."""

    requested_url: str
    final_url: str = ""
    status_code: int | None = None
    response_time_ms: float | None = None
    redirect_chain: list[dict[str, Any]] = field(default_factory=list)
    content_type: str = ""
    html_content: str = ""
    error: str | None = None


@dataclass
class PlaywrightAuditData:
    """Aggregated browser DOM, layout, console, and screenshot artifacts from Phase 2."""

    viewport_label: str
    viewport_width: int
    viewport_height: int
    rendered_html: str = ""
    screenshot_bytes: bytes | None = None
    console_errors: list[str] = field(default_factory=list)
    console_warnings: list[str] = field(default_factory=list)
    page_errors: list[str] = field(default_factory=list)
    broken_images: list[dict[str, Any]] = field(default_factory=list)
    total_images: int = 0
    scroll_width: int = 0
    inner_width: int = 0
    has_horizontal_overflow: bool = False
    error: str | None = None


@dataclass
class SeoAccessibilityData:
    """Aggregated structural, SEO, and accessibility audit data from Phase 3."""

    title: str = ""
    h1_texts: list[str] = field(default_factory=list)
    unlabeled_inputs: list[dict[str, str]] = field(default_factory=list)
    total_form_controls: int = 0
    missing_alt_images: int = 0
    meta_description: str = ""
    has_viewport_meta: bool = False
    html_lang: str = ""


# ------------------------------------------------------------------------------
# URL Validation Utilities
# ------------------------------------------------------------------------------


def validate_target_url(raw_url: str) -> tuple[bool, str]:
    """
    Validate that the provided URL uses http:// or https:// and includes a valid host.

    Returns:
        (is_valid, message_or_normalized_url)
    """
    cleaned = raw_url.strip()
    if not cleaned:
        return False, "Please enter a target URL to begin testing."

    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https"):
        return (
            False,
            "Invalid protocol. Target URL must start with 'http://' or 'https://'.",
        )

    if not parsed.netloc or "." not in parsed.netloc and "localhost" not in parsed.netloc:
        return False, "Invalid domain/host. Please provide a complete URL (e.g., https://example.com)."

    return True, cleaned


# ------------------------------------------------------------------------------
# Phase 1: HTTP & Network Health (requests)
# ------------------------------------------------------------------------------


def run_http_health_check(url: str, timeout: int = 15) -> tuple[HttpAuditData, list[CheckResult]]:
    """
    Execute Phase 1 HTTP & Network Health checks using the requests library.
    Inspects status code, redirect chain, latency, headers, and connection errors.
    """
    audit = HttpAuditData(requested_url=url)
    checks: list[CheckResult] = []
    headers = {"User-Agent": DEFAULT_USER_AGENT, "Accept": "text/html,application/xhtml+xml,*/*"}

    start_time = time.perf_counter()
    try:
        response = requests.get(
            url,
            headers=headers,
            timeout=timeout,
            allow_redirects=True,
        )
        elapsed_ms = round((time.perf_counter() - start_time) * 1000.0, 2)

        audit.final_url = response.url
        audit.status_code = response.status_code
        audit.response_time_ms = elapsed_ms
        audit.content_type = response.headers.get("Content-Type", "")

        # Record redirect hops if any occurred
        for hop in response.history:
            audit.redirect_chain.append(
                {
                    "status_code": hop.status_code,
                    "from_url": hop.url,
                    "to_url": hop.headers.get("Location", ""),
                }
            )

        # Store HTML body for Phase 3 fallback if Playwright is disabled or blocked
        if "text/html" in audit.content_type.lower() or "<html" in response.text[:500].lower():
            audit.html_content = response.text

        # Evaluate HTTP Status Code
        if 200 <= response.status_code < 300:
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="HTTP Status Code",
                    status="PASSED",
                    summary=f"Server responded with HTTP {response.status_code} OK.",
                    details=f"Final URL: {audit.final_url} | Content-Type: {audit.content_type or 'N/A'}",
                )
            )
        elif 300 <= response.status_code < 400:
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="HTTP Status Code",
                    status="WARNING",
                    summary=f"Unresolved redirect status HTTP {response.status_code}.",
                    details=f"Final URL: {audit.final_url}",
                )
            )
        else:
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="HTTP Status Code",
                    status="CRITICAL",
                    summary=f"Endpoint returned error status HTTP {response.status_code}.",
                    details=f"Final URL: {audit.final_url} | Reason: {response.reason}",
                )
            )

        # Evaluate Redirect Chain
        hop_count = len(audit.redirect_chain)
        if hop_count == 0:
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="Redirect Chain",
                    status="PASSED",
                    summary="No redirects encountered; direct resolution.",
                    details=f"Resolved directly at {audit.final_url}",
                )
            )
        elif hop_count <= 2:
            hop_str = " -> ".join(f"[{h['status_code']}] {h['from_url']}" for h in audit.redirect_chain)
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="Redirect Chain",
                    status="PASSED",
                    summary=f"Clean redirect chain ({hop_count} hop{'s' if hop_count > 1 else ''}).",
                    details=f"{hop_str} -> {audit.final_url}",
                )
            )
        else:
            hop_str = " -> ".join(f"[{h['status_code']}] {h['from_url']}" for h in audit.redirect_chain)
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="Redirect Chain",
                    status="WARNING",
                    summary=f"Long redirect chain detected ({hop_count} hops).",
                    details=f"{hop_str} -> {audit.final_url}",
                )
            )

        # Evaluate Response Latency
        if elapsed_ms <= 1500:
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="Response Latency",
                    status="PASSED",
                    summary=f"Fast response time ({elapsed_ms:.0f} ms).",
                    details="Threshold: <= 1,500 ms optimal, > 3,000 ms slow.",
                )
            )
        elif elapsed_ms <= 3500:
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="Response Latency",
                    status="WARNING",
                    summary=f"Elevated response time ({elapsed_ms:.0f} ms).",
                    details="Consider inspecting server TTFB, CDN caching, or payload size.",
                )
            )
        else:
            checks.append(
                CheckResult(
                    phase="Phase 1: HTTP & Network",
                    check_name="Response Latency",
                    status="CRITICAL",
                    summary=f"Severe response latency ({elapsed_ms:.0f} ms).",
                    details="Response exceeded 3,500 ms smoke test threshold.",
                )
            )

    except requests.exceptions.SSLError as exc:
        audit.error = f"SSL/TLS verification failed: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 1: HTTP & Network",
                check_name="TLS / SSL Handshake",
                status="CRITICAL",
                summary="SSL certificate validation error.",
                details=str(exc),
            )
        )
    except requests.exceptions.Timeout as exc:
        audit.error = f"Request timed out after {timeout}s: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 1: HTTP & Network",
                check_name="Network Timeout",
                status="CRITICAL",
                summary=f"HTTP request timed out after {timeout} seconds.",
                details=str(exc),
            )
        )
    except requests.exceptions.ConnectionError as exc:
        audit.error = f"Connection failed: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 1: HTTP & Network",
                check_name="Network Connectivity",
                status="CRITICAL",
                summary="Unable to establish connection to target host.",
                details=str(exc),
            )
        )
    except requests.exceptions.TooManyRedirects as exc:
        audit.error = f"Too many redirects: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 1: HTTP & Network",
                check_name="Redirect Loop",
                status="CRITICAL",
                summary="Excessive redirects or redirect loop detected.",
                details=str(exc),
            )
        )
    except requests.exceptions.RequestException as exc:
        audit.error = f"HTTP request failed: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 1: HTTP & Network",
                check_name="HTTP Request",
                status="CRITICAL",
                summary="Unexpected HTTP client failure.",
                details=str(exc),
            )
        )

    return audit, checks


# ------------------------------------------------------------------------------
# Phase 2: UI & DOM Layout Audit (Playwright)
# ------------------------------------------------------------------------------


def _execute_playwright_in_thread(
    url: str,
    viewport_label: str,
    viewport_size: tuple[int, int],
    capture_screenshot: bool,
    scan_console: bool,
    check_broken_images: bool,
    timeout_ms: int,
) -> tuple[PlaywrightAuditData, list[CheckResult]]:
    """
    Internal Playwright runner executed inside a dedicated worker thread so it never
    conflicts with Streamlit's active asyncio/Tornado event loop.
    """
    if sys.platform.startswith("win"):
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    width, height = viewport_size
    audit = PlaywrightAuditData(
        viewport_label=viewport_label,
        viewport_width=width,
        viewport_height=height,
    )
    checks: list[CheckResult] = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent=DEFAULT_USER_AGENT,
                ignore_https_errors=False,
            )
            page = context.new_page()

            # Attach console and uncaught exception listeners before navigating
            if scan_console:
                def handle_console(msg: Any) -> None:
                    msg_type = (msg.type or "").lower()
                    text = msg.text or ""
                    if msg_type == "error":
                        audit.console_errors.append(text)
                    elif msg_type == "warning":
                        audit.console_warnings.append(text)

                page.on("console", handle_console)
                page.on("pageerror", lambda err: audit.page_errors.append(str(err)))

            # Attempt networkidle first; gracefully fall back to domcontentloaded for streaming/SPA sites
            try:
                page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            except PlaywrightTimeoutError:
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                page.wait_for_timeout(1200)

            # Give lazy assets a brief settle window
            page.wait_for_timeout(500)
            audit.rendered_html = page.content()

            # 1. Full-page screenshot capture
            if capture_screenshot:
                try:
                    audit.screenshot_bytes = page.screenshot(full_page=True, type="png")
                    checks.append(
                        CheckResult(
                            phase="Phase 2: UI & DOM Audit",
                            check_name="Full-Page Screenshot",
                            status="PASSED",
                            summary=f"Captured full-page PNG at {width}x{height} ({len(audit.screenshot_bytes) // 1024} KB).",
                            details="Inspect the rendered snapshot in the Visual Artifacts tab.",
                        )
                    )
                except PlaywrightError as exc:
                    checks.append(
                        CheckResult(
                            phase="Phase 2: UI & DOM Audit",
                            check_name="Full-Page Screenshot",
                            status="WARNING",
                            summary="Screenshot capture failed.",
                            details=str(exc),
                        )
                    )

            # 2. Horizontal Overflow / Layout Clipping Detection
            try:
                layout_metrics = page.evaluate(
                    """() => {
                        const doc = document.documentElement;
                        const body = document.body;
                        const scrollWidth = Math.max(
                            doc ? doc.scrollWidth : 0,
                            body ? body.scrollWidth : 0
                        );
                        const innerWidth = window.innerWidth;
                        return { scrollWidth, innerWidth };
                    }"""
                )
                audit.scroll_width = int(layout_metrics.get("scrollWidth", 0))
                audit.inner_width = int(layout_metrics.get("innerWidth", width))
                audit.has_horizontal_overflow = audit.scroll_width > audit.inner_width

                if audit.has_horizontal_overflow:
                    overflow_px = audit.scroll_width - audit.inner_width
                    checks.append(
                        CheckResult(
                            phase="Phase 2: UI & DOM Audit",
                            check_name="Horizontal Overflow Check",
                            status="CRITICAL",
                            summary=f"Horizontal overflow detected (+{overflow_px}px beyond {audit.inner_width}px viewport).",
                            details=(
                                f"scrollWidth={audit.scroll_width}px > innerWidth={audit.inner_width}px "
                                f"on {viewport_label}."
                            ),
                        )
                    )
                else:
                    checks.append(
                        CheckResult(
                            phase="Phase 2: UI & DOM Audit",
                            check_name="Horizontal Overflow Check",
                            status="PASSED",
                            summary=f"No horizontal overflow at {viewport_label}.",
                            details=f"scrollWidth={audit.scroll_width}px <= innerWidth={audit.inner_width}px.",
                        )
                    )
            except PlaywrightError as exc:
                checks.append(
                    CheckResult(
                        phase="Phase 2: UI & DOM Audit",
                        check_name="Horizontal Overflow Check",
                        status="WARNING",
                        summary="Unable to evaluate viewport overflow metrics.",
                        details=str(exc),
                    )
                )

            # 3. Broken Image Asset Scan (naturalWidth === 0)
            if check_broken_images:
                try:
                    img_report = page.evaluate(
                        """() => {
                            const imgs = Array.from(document.querySelectorAll('img'));
                            const broken = [];
                            for (const img of imgs) {
                                const src = img.currentSrc || img.getAttribute('src') || '';
                                const alt = img.getAttribute('alt') || '';
                                const isBroken = !img.complete || img.naturalWidth === 0;
                                if (isBroken) {
                                    broken.push({
                                        src: src || '(missing src)',
                                        alt: alt || '(no alt)',
                                        complete: Boolean(img.complete),
                                        naturalWidth: Number(img.naturalWidth || 0),
                                    });
                                }
                            }
                            return { total: imgs.length, broken };
                        }"""
                    )
                    audit.total_images = int(img_report.get("total", 0))
                    audit.broken_images = img_report.get("broken", [])

                    if audit.total_images == 0:
                        checks.append(
                            CheckResult(
                                phase="Phase 2: UI & DOM Audit",
                                check_name="Broken Images Scan",
                                status="PASSED",
                                summary="No <img> elements found on the rendered page.",
                                details="0 image assets inspected.",
                            )
                        )
                    elif len(audit.broken_images) == 0:
                        checks.append(
                            CheckResult(
                                phase="Phase 2: UI & DOM Audit",
                                check_name="Broken Images Scan",
                                status="PASSED",
                                summary=f"All {audit.total_images} <img> elements loaded cleanly (naturalWidth > 0).",
                                details="Zero broken image assets detected.",
                            )
                        )
                    else:
                        sample_list = "\n".join(
                            f"- {item['src']} (naturalWidth={item['naturalWidth']})"
                            for item in audit.broken_images[:10]
                        )
                        checks.append(
                            CheckResult(
                                phase="Phase 2: UI & DOM Audit",
                                check_name="Broken Images Scan",
                                status="CRITICAL",
                                summary=f"{len(audit.broken_images)} of {audit.total_images} images failed to load.",
                                details=sample_list,
                            )
                        )
                except PlaywrightError as exc:
                    checks.append(
                        CheckResult(
                            phase="Phase 2: UI & DOM Audit",
                            check_name="Broken Images Scan",
                            status="WARNING",
                            summary="Image inspection script failed.",
                            details=str(exc),
                        )
                    )

            # 4. Console Errors & Warnings Report
            if scan_console:
                total_errors = len(audit.console_errors) + len(audit.page_errors)
                total_warnings = len(audit.console_warnings)

                if total_errors == 0 and total_warnings == 0:
                    checks.append(
                        CheckResult(
                            phase="Phase 2: UI & DOM Audit",
                            check_name="Browser Console Audit",
                            status="PASSED",
                            summary="Zero JavaScript console errors or warnings detected.",
                            details="Clean runtime console output during page load.",
                        )
                    )
                else:
                    if total_errors > 0:
                        combined_errors = audit.page_errors + audit.console_errors
                        checks.append(
                            CheckResult(
                                phase="Phase 2: UI & DOM Audit",
                                check_name="Console & Page Errors",
                                status="CRITICAL",
                                summary=f"{total_errors} JavaScript error(s) recorded in browser console.",
                                details="\n".join(f"- {e}" for e in combined_errors[:15]),
                            )
                        )
                    if total_warnings > 0:
                        checks.append(
                            CheckResult(
                                phase="Phase 2: UI & DOM Audit",
                                check_name="Console Warnings",
                                status="WARNING",
                                summary=f"{total_warnings} console warning(s) emitted.",
                                details="\n".join(f"- {w}" for w in audit.console_warnings[:15]),
                            )
                        )

            context.close()
            browser.close()

    except PlaywrightTimeoutError as exc:
        audit.error = f"Playwright navigation timed out: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 2: UI & DOM Audit",
                check_name="Browser Navigation",
                status="CRITICAL",
                summary="Headless browser navigation timed out.",
                details=str(exc),
            )
        )
    except PlaywrightError as exc:
        audit.error = f"Playwright execution error: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 2: UI & DOM Audit",
                check_name="Headless Browser Launch",
                status="CRITICAL",
                summary="Playwright failed to render the target page (browser blocked or missing binaries).",
                details=(
                    f"{exc}\n\nTip: Ensure Chromium is installed via `playwright install chromium`."
                ),
            )
        )
    except Exception as exc:
        audit.error = f"Unexpected Playwright exception: {exc}"
        checks.append(
            CheckResult(
                phase="Phase 2: UI & DOM Audit",
                check_name="UI & DOM Audit",
                status="CRITICAL",
                summary="Unexpected error occurred during headless browser audit.",
                details=str(exc),
            )
        )

    return audit, checks


def run_playwright_audit(
    url: str,
    viewport_label: str,
    viewport_size: tuple[int, int],
    capture_screenshot: bool = True,
    scan_console: bool = True,
    check_broken_images: bool = True,
    timeout_ms: int = 20000,
) -> tuple[PlaywrightAuditData, list[CheckResult]]:
    """Thread-safe wrapper invoking Playwright headless Chromium audit."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            _execute_playwright_in_thread,
            url,
            viewport_label,
            viewport_size,
            capture_screenshot,
            scan_console,
            check_broken_images,
            timeout_ms,
        )
        return future.result()


# ------------------------------------------------------------------------------
# Phase 3: Structural, SEO & Accessibility Audit (BeautifulSoup)
# ------------------------------------------------------------------------------


def run_beautifulsoup_audit(html: str, base_url: str) -> tuple[SeoAccessibilityData, list[CheckResult]]:
    """
    Execute Phase 3 static/rendered HTML structural & accessibility checks with BeautifulSoup.
    Checks <title>, <h1> uniqueness, unlabeled form controls, meta tags, and image alt attributes.
    """
    data = SeoAccessibilityData()
    checks: list[CheckResult] = []

    if not html or not html.strip():
        checks.append(
            CheckResult(
                phase="Phase 3: SEO & Accessibility",
                check_name="HTML Document Parsing",
                status="CRITICAL",
                summary="No HTML content available for structural audit.",
                details="Target endpoint returned an empty document or failed prior phases.",
            )
        )
        return data, checks

    try:
        soup = BeautifulSoup(html, "html.parser")

        # 1. Verify <title> presence and quality
        title_tag = soup.find("title")
        title_text = title_tag.get_text(strip=True) if title_tag else ""
        data.title = title_text

        if not title_text:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Page Title Presence",
                    status="CRITICAL",
                    summary="Missing or empty <title> tag.",
                    details="Every HTML document should define a descriptive <title> in <head>.",
                )
            )
        elif len(title_text) < 10 or len(title_text) > 70:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Page Title Presence",
                    status="WARNING",
                    summary=f"<title> present ({len(title_text)} chars), outside ideal 10-70 char range.",
                    details=f"Title: '{title_text}'",
                )
            )
        else:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Page Title Presence",
                    status="PASSED",
                    summary=f"Valid <title> detected ({len(title_text)} chars).",
                    details=f"Title: '{title_text}'",
                )
            )

        # 2. Check <h1> tag presence and uniqueness
        h1_tags = soup.find_all("h1")
        data.h1_texts = [h.get_text(" ", strip=True) for h in h1_tags]

        if len(h1_tags) == 0:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="H1 Heading Uniqueness",
                    status="WARNING",
                    summary="No <h1> heading found on the page.",
                    details="Recommended: Include exactly one primary <h1> describing page topic.",
                )
            )
        elif len(h1_tags) == 1:
            h1_preview = data.h1_texts[0] or "(empty text)"
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="H1 Heading Uniqueness",
                    status="PASSED",
                    summary="Single unique <h1> heading confirmed.",
                    details=f"H1 text: '{h1_preview[:140]}'",
                )
            )
        else:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="H1 Heading Uniqueness",
                    status="WARNING",
                    summary=f"Multiple <h1> tags found ({len(h1_tags)} total).",
                    details="Found H1 headings: " + " | ".join(f"'{t[:60]}'" for t in data.h1_texts[:5]),
                )
            )

        # 3. Scan for unlabeled form input elements
        label_for_ids = {
            lbl.get("for").strip()
            for lbl in soup.find_all("label")
            if lbl.get("for") and lbl.get("for").strip()
        }

        ignored_input_types = {"hidden", "submit", "button", "reset", "image"}
        form_controls = soup.find_all(["input", "select", "textarea"])

        for control in form_controls:
            tag_name = control.name.lower()
            input_type = (control.get("type") or "text").strip().lower() if tag_name == "input" else tag_name

            if tag_name == "input" and input_type in ignored_input_types:
                continue

            data.total_form_controls += 1

            control_id = (control.get("id") or "").strip()
            control_name = (control.get("name") or "").strip()
            aria_label = (control.get("aria-label") or "").strip()
            aria_labelledby = (control.get("aria-labelledby") or "").strip()
            title_attr = (control.get("title") or "").strip()
            wrapped_in_label = control.find_parent("label") is not None

            is_labeled = bool(
                (control_id and control_id in label_for_ids)
                or wrapped_in_label
                or aria_label
                or aria_labelledby
                or title_attr
            )

            if not is_labeled:
                data.unlabeled_inputs.append(
                    {
                        "tag": tag_name,
                        "type": input_type,
                        "id": control_id or "(none)",
                        "name": control_name or "(none)",
                        "placeholder": (control.get("placeholder") or "(none)").strip(),
                    }
                )

        if data.total_form_controls == 0:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Form Input Labels",
                    status="PASSED",
                    summary="No interactive form inputs found to audit.",
                    details="0 form controls detected.",
                )
            )
        elif len(data.unlabeled_inputs) == 0:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Form Input Labels",
                    status="PASSED",
                    summary=f"All {data.total_form_controls} form controls have accessible labels.",
                    details="Verified <label>, aria-label, aria-labelledby, or title attributes.",
                )
            )
        else:
            offenders = "\n".join(
                f"- <{item['tag']} type='{item['type']}' id='{item['id']}' name='{item['name']}'>"
                for item in data.unlabeled_inputs[:10]
            )
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Form Input Labels",
                    status="CRITICAL",
                    summary=(
                        f"{len(data.unlabeled_inputs)} of {data.total_form_controls} "
                        "form elements lack an accessible label."
                    ),
                    details=offenders,
                )
            )

        # 4. Supplementary SEO & Accessibility Checks (Meta Description, Viewport, HTML lang, Image Alt)
        meta_desc_tag = soup.find("meta", attrs={"name": lambda v: v and v.lower() == "description"})
        data.meta_description = (meta_desc_tag.get("content") or "").strip() if meta_desc_tag else ""
        if data.meta_description:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Meta Description",
                    status="PASSED",
                    summary=f"Meta description found ({len(data.meta_description)} chars).",
                    details=data.meta_description[:160],
                )
            )
        else:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Meta Description",
                    status="WARNING",
                    summary="Missing <meta name='description'> tag.",
                    details="Adding a meta description improves search snippet clarity.",
                )
            )

        viewport_tag = soup.find("meta", attrs={"name": lambda v: v and v.lower() == "viewport"})
        data.has_viewport_meta = viewport_tag is not None
        if data.has_viewport_meta:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Responsive Viewport Meta",
                    status="PASSED",
                    summary="Viewport meta tag is configured.",
                    details=f"content='{viewport_tag.get('content', '')}'",
                )
            )
        else:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Responsive Viewport Meta",
                    status="WARNING",
                    summary="Missing <meta name='viewport'> tag.",
                    details="Mobile rendering may scale incorrectly without a viewport directive.",
                )
            )

        html_tag = soup.find("html")
        data.html_lang = (html_tag.get("lang") or "").strip() if html_tag else ""
        if data.html_lang:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Document Language Attribute",
                    status="PASSED",
                    summary=f"HTML lang attribute set ('{data.html_lang}').",
                    details="Assists screen readers with pronunciation profiles.",
                )
            )
        else:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Document Language Attribute",
                    status="WARNING",
                    summary="Missing lang attribute on <html> element.",
                    details=f"Recommended for {urljoin(base_url, '/')}.",
                )
            )

        imgs = soup.find_all("img")
        missing_alt = [img for img in imgs if img.get("alt") is None]
        data.missing_alt_images = len(missing_alt)
        if imgs and missing_alt:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Image Alt Attributes",
                    status="WARNING",
                    summary=f"{len(missing_alt)} of {len(imgs)} <img> tags omit the alt attribute.",
                    details="Use descriptive alt text or alt='' for purely decorative images.",
                )
            )
        elif imgs:
            checks.append(
                CheckResult(
                    phase="Phase 3: SEO & Accessibility",
                    check_name="Image Alt Attributes",
                    status="PASSED",
                    summary=f"All {len(imgs)} <img> tags declare an alt attribute.",
                    details="Accessible alternative text contract satisfied.",
                )
            )

    except Exception as exc:
        checks.append(
            CheckResult(
                phase="Phase 3: SEO & Accessibility",
                check_name="BeautifulSoup Parser",
                status="CRITICAL",
                summary="Failed to parse HTML structure.",
                details=str(exc),
            )
        )

    return data, checks


# ------------------------------------------------------------------------------
# Reporting & Export Helpers (Pandas + JSON)
# ------------------------------------------------------------------------------


def build_export_payloads(
    report_summary: dict[str, Any],
    checks: list[CheckResult],
) -> tuple[pd.DataFrame, bytes, bytes]:
    """
    Convert check results into a Pandas DataFrame, CSV bytes, and structured JSON bytes.
    """
    records = [asdict(c) for c in checks]
    df = pd.DataFrame(records)
    if not df.empty:
        df = df[["phase", "check_name", "status", "summary", "details", "timestamp"]]

    csv_bytes = df.to_csv(index=False).encode("utf-8")
    json_payload = {
        "summary": report_summary,
        "checks": records,
    }
    json_bytes = json.dumps(json_payload, indent=2, default=str).encode("utf-8")
    return df, csv_bytes, json_bytes


# ------------------------------------------------------------------------------
# Streamlit UI & Custom Styling
# ------------------------------------------------------------------------------


def inject_custom_css() -> None:
    """Apply clean, modern styling to metrics, tabs, and log cards."""
    st.markdown(
        """
        <style>
        .block-container {
            padding-top: 2rem;
            padding-bottom: 3rem;
            max-width: 1320px;
        }
        .metric-card {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            padding: 1rem 1.15rem;
        }
        .metric-label {
            font-size: 0.78rem;
            font-weight: 600;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 0.3rem;
        }
        .metric-value {
            font-size: 1.75rem;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            color: #0f172a;
            line-height: 1.2;
        }
        .metric-sub {
            font-size: 0.78rem;
            color: #64748b;
            margin-top: 0.25rem;
        }
        .status-banner {
            padding: 0.65rem 0.9rem;
            border-radius: 8px;
            border: 1px solid;
            margin-bottom: 0.5rem;
            font-size: 0.9rem;
        }
        .status-passed {
            background-color: #f0fdf4;
            border-color: #bbf7d0;
            color: #166534;
        }
        .status-warning {
            background-color: #fffbeb;
            border-color: #fde68a;
            color: #92400e;
        }
        .status-critical {
            background-color: #fef2f2;
            border-color: #fecaca;
            color: #991b1b;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def render_metric_card(label: str, value: str, subtext: str, accent_hex: str = "#0f172a") -> None:
    """Render a crisp single-elevation KPI card."""
    st.markdown(
        f"""
        <div class="metric-card">
            <div class="metric-label">{label}</div>
            <div class="metric-value" style="color: {accent_hex};">{value}</div>
            <div class="metric-sub">{subtext}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_log_group(title: str, items: list[CheckResult], css_class: str, expanded: bool) -> None:
    """Render color-coded expandable audit log entries."""
    if not items:
        return

    st.subheader(f"{title} ({len(items)})")
    for item in items:
        header = f"[{item.status}] {item.phase} — {item.check_name}: {item.summary}"
        with st.expander(header, expanded=expanded):
            st.markdown(
                f'<div class="status-banner {css_class}"><strong>{item.status}:</strong> {item.summary}</div>',
                unsafe_allow_html=True,
            )
            if item.details:
                st.code(item.details, language="text")
            st.caption(f"Recorded at {item.timestamp}")


def main() -> None:
    st.set_page_config(
        page_title="Web Smoke Testing Dashboard",
        page_icon="🩺",
        layout="wide",
        initial_sidebar_state="expanded",
    )
    inject_custom_css()

    # Initialize session state for persistent results across reruns
    if "last_report" not in st.session_state:
        st.session_state["last_report"] = None

    # --------------------------------------------------------------------------
    # Sidebar Configuration
    # --------------------------------------------------------------------------
    with st.sidebar:
        st.title("Test Configuration")
        st.caption("Configure target URL, browser viewport, and audit modules.")

        target_url = st.text_input(
            "Target Website URL",
            value="https://example.com",
            placeholder="https://your-app.example.com",
            help="Must begin with http:// or https://",
        )

        url_valid, url_msg = validate_target_url(target_url)
        if target_url.strip() and not url_valid:
            st.error(url_msg)

        st.divider()
        st.subheader("Audit Modules")
        opt_screenshot = st.checkbox("Include full-page screenshot", value=True)
        opt_console = st.checkbox("Scan console errors & warnings", value=True)
        opt_images = st.checkbox("Check broken images", value=True)
        opt_a11y_seo = st.checkbox("Run accessibility & SEO checks", value=True)

        st.divider()
        st.subheader("Viewport Preset")
        viewport_label = st.selectbox(
            "Browser Viewport Size",
            options=list(VIEWPORT_PRESETS.keys()),
            index=0,
        )
        viewport_size = VIEWPORT_PRESETS[viewport_label]

        with st.expander("Advanced Network Settings", expanded=False):
            request_timeout = st.slider("Timeout (seconds)", min_value=5, max_value=45, value=15)

        st.divider()
        run_clicked = st.button(
            "Run Smoke Test",
            type="primary",
            use_container_width=True,
            disabled=not url_valid,
        )

    # --------------------------------------------------------------------------
    # Header
    # --------------------------------------------------------------------------
    st.title("Web Smoke Testing Dashboard")
    st.markdown(
        "Automated multi-phase health inspection across HTTP transport, headless Chromium layout, "
        "asset integrity, and semantic accessibility."
    )

    # --------------------------------------------------------------------------
    # Execution Pipeline
    # --------------------------------------------------------------------------
    if run_clicked and url_valid:
        normalized_url = url_msg
        all_checks: list[CheckResult] = []
        progress_bar = st.progress(0, text="Initializing smoke test runner...")

        with st.status(f"Running smoke test suite on {normalized_url}...", expanded=True) as status_box:
            # Phase 1: HTTP & Network Health
            st.write("Phase 1/3: Checking HTTP status, redirect chain, and response latency...")
            http_data, http_checks = run_http_health_check(normalized_url, timeout=request_timeout)
            all_checks.extend(http_checks)
            progress_bar.progress(33, text="Phase 1 complete (HTTP & Network Health).")

            # Phase 2: Playwright Browser Audit
            st.write(f"Phase 2/3: Launching headless Chromium ({viewport_label}) for DOM & visual audit...")
            pw_data, pw_checks = run_playwright_audit(
                url=http_data.final_url or normalized_url,
                viewport_label=viewport_label,
                viewport_size=viewport_size,
                capture_screenshot=opt_screenshot,
                scan_console=opt_console,
                check_broken_images=opt_images,
                timeout_ms=request_timeout * 1000,
            )
            all_checks.extend(pw_checks)
            progress_bar.progress(68, text="Phase 2 complete (Playwright UI & DOM Audit).")

            # Phase 3: BeautifulSoup Structural & Accessibility Audit
            seo_data: SeoAccessibilityData | None = None
            if opt_a11y_seo:
                st.write("Phase 3/3: Running BeautifulSoup SEO & accessibility checks...")
                html_source = pw_data.rendered_html or http_data.html_content
                seo_data, seo_checks = run_beautifulsoup_audit(
                    html=html_source,
                    base_url=http_data.final_url or normalized_url,
                )
                all_checks.extend(seo_checks)
            progress_bar.progress(100, text="All smoke test phases complete.")

            critical_n = sum(1 for c in all_checks if c.status == "CRITICAL")
            warning_n = sum(1 for c in all_checks if c.status == "WARNING")
            state_label = "complete" if critical_n == 0 else "error"
            status_box.update(
                label=f"Smoke test finished — {critical_n} critical, {warning_n} warnings.",
                state="complete" if critical_n == 0 else "complete",
                expanded=False,
            )

        summary_meta = {
            "target_url": normalized_url,
            "final_url": http_data.final_url or normalized_url,
            "executed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "viewport": viewport_label,
            "http_status": http_data.status_code,
            "response_time_ms": http_data.response_time_ms,
            "redirect_hops": len(http_data.redirect_chain),
            "total_checks": len(all_checks),
            "passed": sum(1 for c in all_checks if c.status == "PASSED"),
            "warnings": warning_n,
            "critical": critical_n,
            "has_horizontal_overflow": pw_data.has_horizontal_overflow,
            "broken_images_count": len(pw_data.broken_images),
            "console_errors_count": len(pw_data.console_errors) + len(pw_data.page_errors),
        }

        st.session_state["last_report"] = {
            "summary": summary_meta,
            "checks": all_checks,
            "http": http_data,
            "playwright": pw_data,
            "seo": seo_data,
        }

    # --------------------------------------------------------------------------
    # Results Presentation
    # --------------------------------------------------------------------------
    report = st.session_state.get("last_report")
    if not report:
        st.info(
            "Enter a target URL in the sidebar, select your audit options and viewport size, "
            "and click **Run Smoke Test** to inspect the application."
        )
        return

    summary = report["summary"]
    checks: list[CheckResult] = report["checks"]
    pw_data: PlaywrightAuditData = report["playwright"]
    http_data: HttpAuditData = report["http"]

    # Summary Metrics Row
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        render_metric_card(
            "Checks Passed",
            str(summary["passed"]),
            f"Out of {summary['total_checks']} total checks",
            accent_hex="#16A34A",
        )
    with col2:
        render_metric_card(
            "Warnings",
            str(summary["warnings"]),
            "Non-blocking SEO or latency flags",
            accent_hex="#D97706" if summary["warnings"] else "#0F172A",
        )
    with col3:
        render_metric_card(
            "Critical Issues",
            str(summary["critical"]),
            "Broken assets, errors, or overflow",
            accent_hex="#DC2626" if summary["critical"] else "#0F172A",
        )
    with col4:
        latency_str = f"{summary['response_time_ms']:.0f} ms" if summary["response_time_ms"] is not None else "N/A"
        status_str = f"HTTP {summary['http_status']}" if summary["http_status"] else "Connection Error"
        render_metric_card(
            "HTTP & Latency",
            latency_str,
            f"{status_str} · {summary['redirect_hops']} redirect(s)",
            accent_hex="#0F172A",
        )

    st.write("")

    df, csv_bytes, json_bytes = build_export_payloads(summary, checks)

    tab_logs, tab_visual, tab_export = st.tabs(
        ["Detailed Logs", "Visual Artifacts", "Data Table & Export"]
    )

    with tab_logs:
        critical_items = [c for c in checks if c.status == "CRITICAL"]
        warning_items = [c for c in checks if c.status == "WARNING"]
        passed_items = [c for c in checks if c.status == "PASSED"]

        if not critical_items and not warning_items:
            st.success("All executed smoke checks passed without warnings or critical issues.")

        render_log_group("Critical Issues", critical_items, "status-critical", expanded=True)
        render_log_group("Warnings", warning_items, "status-warning", expanded=True)
        render_log_group("Passed Checks", passed_items, "status-passed", expanded=False)

        if http_data.redirect_chain:
            with st.expander("HTTP Redirect Chain Trace", expanded=False):
                st.dataframe(pd.DataFrame(http_data.redirect_chain), use_container_width=True, hide_index=True)

    with tab_visual:
        if pw_data.screenshot_bytes:
            st.caption(
                f"Full-page screenshot captured at **{pw_data.viewport_label}** "
                f"({pw_data.viewport_width}x{pw_data.viewport_height}px) for `{summary['final_url']}`."
            )
            st.image(pw_data.screenshot_bytes, use_container_width=True)
            st.download_button(
                label="Download Full-Page Screenshot (.png)",
                data=pw_data.screenshot_bytes,
                file_name="smoke_test_screenshot.png",
                mime="image/png",
            )
        elif pw_data.error:
            st.error(f"Screenshot unavailable because headless browser failed: {pw_data.error}")
        else:
            st.info("Full-page screenshot capture was disabled for this run.")

    with tab_export:
        st.subheader("Structured Audit Report")
        st.dataframe(df, use_container_width=True, hide_index=True)

        exp_col1, exp_col2 = st.columns(2)
        timestamp_slug = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        with exp_col1:
            st.download_button(
                label="Download Report as JSON",
                data=json_bytes,
                file_name=f"smoke_test_report_{timestamp_slug}.json",
                mime="application/json",
                use_container_width=True,
            )
        with exp_col2:
            st.download_button(
                label="Download Report as CSV",
                data=csv_bytes,
                file_name=f"smoke_test_report_{timestamp_slug}.csv",
                mime="text/csv",
                use_container_width=True,
            )


if __name__ == "__main__":
    main()
