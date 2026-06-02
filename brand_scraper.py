#!/usr/bin/env python3
"""
Brand Scraper — extracts colors, fonts, logo, brand voice, and brand story
from a website and writes a markdown brand kit file.

Usage:
    python3 brand_scraper.py <url> [output_file.md]

Requires:
    pip install requests beautifulsoup4 anthropic lxml
    ANTHROPIC_API_KEY environment variable
"""

import re
import sys
import os
import json
import urllib.parse
from pathlib import Path

import requests
from bs4 import BeautifulSoup

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

# ─── Extraction helpers ────────────────────────────────────────────────────────

HEX_RE = re.compile(r'#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b')
RGB_RE = re.compile(r'rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})')
HSL_RE = re.compile(r'hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%')
FONT_FAMILY_RE = re.compile(r'font-family\s*:\s*([^;}{]+)', re.IGNORECASE)
GOOGLE_FONT_RE = re.compile(r'fonts\.googleapis\.com/css[^"\']*family=([^"\'&]+)', re.IGNORECASE)


def _hex_to_norm(h: str) -> str:
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return '#' + h.upper()


def _rgb_to_hex(r, g, b) -> str:
    return '#{:02X}{:02X}{:02X}'.format(int(r), int(g), int(b))


def _is_noise_color(hex_color: str) -> bool:
    """Filter out near-black, near-white, and fully transparent colors."""
    h = hex_color.lstrip('#')
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    brightness = (r + g + b) / 3
    return brightness < 15 or brightness > 240


def fetch_page(url: str) -> tuple[str, str, BeautifulSoup]:
    """Return (final_url, raw_html, soup)."""
    resp = requests.get(url, headers=HEADERS, timeout=15, allow_redirects=True)
    resp.raise_for_status()
    final_url = resp.url
    soup = BeautifulSoup(resp.text, 'lxml')
    return final_url, resp.text, soup


def fetch_css(soup: BeautifulSoup, base_url: str) -> str:
    """Fetch all linked stylesheets and return combined CSS text."""
    css_parts = []
    for tag in soup.find_all('link', rel=lambda v: v and 'stylesheet' in v):
        href = tag.get('href', '')
        if not href or href.startswith('//fonts.googleapis'):
            continue
        full = urllib.parse.urljoin(base_url, href)
        try:
            r = requests.get(full, headers=HEADERS, timeout=10)
            css_parts.append(r.text)
        except Exception:
            pass
    # Also grab inline <style> blocks
    for tag in soup.find_all('style'):
        css_parts.append(tag.get_text())
    return '\n'.join(css_parts)


def extract_colors(css_text: str, html_text: str) -> list[str]:
    combined = css_text + '\n' + html_text
    colors = set()

    for m in HEX_RE.finditer(combined):
        colors.add(_hex_to_norm(m.group(0)))

    for m in RGB_RE.finditer(combined):
        colors.add(_rgb_to_hex(m.group(1), m.group(2), m.group(3)))

    # Remove noise and deduplicate preserving order
    filtered = [c for c in sorted(colors) if not _is_noise_color(c)]
    # Limit to the 20 most distinct (rough heuristic: keep unique enough colors)
    return filtered[:20]


def extract_fonts(css_text: str, soup: BeautifulSoup) -> list[str]:
    fonts = []
    seen = set()

    # Google Fonts in <link> tags
    for tag in soup.find_all('link', href=True):
        m = GOOGLE_FONT_RE.search(tag['href'])
        if m:
            for name in m.group(1).replace('+', ' ').split('|'):
                clean = name.split(':')[0].strip()
                if clean and clean not in seen:
                    fonts.append(clean)
                    seen.add(clean)

    # font-family declarations in CSS
    for m in FONT_FAMILY_RE.finditer(css_text):
        raw = m.group(1)
        for part in raw.split(','):
            name = part.strip().strip("'\"")
            if name and name.lower() not in ('inherit', 'initial', 'unset', 'revert',
                                             'sans-serif', 'serif', 'monospace',
                                             'cursive', 'fantasy', 'system-ui',
                                             '-apple-system', 'blinkmacsystemfont',
                                             'segoe ui', 'roboto', 'helvetica neue',
                                             'arial', 'helvetica'):
                if name not in seen:
                    fonts.append(name)
                    seen.add(name)

    return fonts[:10]


def extract_logo(soup: BeautifulSoup, base_url: str) -> list[str]:
    candidates = []

    def add(url: str):
        if url:
            full = urllib.parse.urljoin(base_url, url)
            if full not in candidates:
                candidates.append(full)

    # <link rel="icon"> / apple-touch
    for tag in soup.find_all('link', rel=True):
        rel = ' '.join(tag.get('rel', []))
        if any(k in rel for k in ('icon', 'apple-touch', 'logo')):
            add(tag.get('href', ''))

    # <img> tags whose src/alt/class/id hint at logo
    logo_pattern = re.compile(r'logo|brand|mark|icon', re.IGNORECASE)
    for img in soup.find_all('img'):
        src = img.get('src', '') or img.get('data-src', '')
        alt = img.get('alt', '')
        cls = ' '.join(img.get('class', []))
        img_id = img.get('id', '')
        if logo_pattern.search(src + alt + cls + img_id):
            add(src)

    # SVG <use> or inline SVGs with logo-ish IDs
    for svg in soup.find_all('svg'):
        svg_id = svg.get('id', '') + ' '.join(svg.get('class', []))
        if logo_pattern.search(svg_id):
            candidates.append('[inline SVG logo found in page]')
            break

    # og:image as fallback
    og = soup.find('meta', property='og:image')
    if og:
        add(og.get('content', ''))

    return candidates[:5]


def extract_page_text(soup: BeautifulSoup) -> str:
    """Pull readable body text for AI analysis."""
    for tag in soup(['script', 'style', 'nav', 'footer', 'aside']):
        tag.decompose()
    text = soup.get_text(separator='\n', strip=True)
    # Trim to a reasonable size for the AI prompt
    return text[:8000]


def extract_meta(soup: BeautifulSoup) -> dict:
    meta = {}
    title = soup.find('title')
    meta['title'] = title.get_text(strip=True) if title else ''

    for tag in soup.find_all('meta'):
        name = tag.get('name', '') or tag.get('property', '')
        content = tag.get('content', '')
        if name in ('description', 'og:description', 'og:site_name',
                    'og:title', 'twitter:description'):
            meta[name] = content

    return meta


# ─── AI analysis ──────────────────────────────────────────────────────────────

def analyze_with_claude(page_text: str, meta: dict, url: str) -> dict:
    if not ANTHROPIC_AVAILABLE:
        return {"brand_voice": "N/A (anthropic package not installed)", "brand_story": "N/A"}

    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        return {"brand_voice": "N/A (ANTHROPIC_API_KEY not set)", "brand_story": "N/A"}

    client = anthropic.Anthropic(api_key=api_key)

    meta_str = json.dumps(meta, indent=2)
    prompt = f"""You are a brand strategist. Analyze the website content below and extract:

1. **Brand Voice** — 3-5 adjectives and a 2-sentence description of how the brand communicates (tone, style, personality).
2. **Brand Story** — A concise 2-4 sentence summary of the brand's origin, mission, or value proposition based only on what is evident in the content.

Website URL: {url}

Page metadata:
{meta_str}

Page content (truncated):
{page_text}

Respond in this exact JSON format:
{{
  "brand_voice": "...",
  "brand_story": "..."
}}"""

    message = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = message.content[0].text.strip()
    # Extract JSON even if wrapped in markdown code fences
    json_match = re.search(r'\{.*\}', raw, re.DOTALL)
    if json_match:
        return json.loads(json_match.group(0))
    return {"brand_voice": raw, "brand_story": ""}


# ─── Markdown writer ──────────────────────────────────────────────────────────

def build_markdown(url: str, meta: dict, colors: list, fonts: list,
                   logos: list, ai: dict) -> str:
    site_name = meta.get('og:site_name') or meta.get('title') or url
    description = (meta.get('og:description') or meta.get('description') or
                   meta.get('twitter:description') or '')

    lines = [
        f"# Brand Kit — {site_name}",
        "",
        f"> Scraped from: {url}",
        "",
    ]

    if description:
        lines += [f"_{description}_", ""]

    # Brand Story
    lines += [
        "## Brand Story",
        "",
        ai.get("brand_story") or "_Could not be determined from page content._",
        "",
    ]

    # Brand Voice
    lines += [
        "## Brand Voice",
        "",
        ai.get("brand_voice") or "_Could not be determined from page content._",
        "",
    ]

    # Colors
    lines += ["## Brand Colors", ""]
    if colors:
        lines.append("| Swatch | Hex |")
        lines.append("|--------|-----|")
        for c in colors:
            lines.append(f"| ![{c}](https://placehold.co/40x20/{c.lstrip('#')}/{c.lstrip('#')}) | `{c}` |")
    else:
        lines.append("_No colors detected._")
    lines.append("")

    # Fonts
    lines += ["## Typography", ""]
    if fonts:
        for f in fonts:
            lines.append(f"- `{f}`")
    else:
        lines.append("_No custom fonts detected._")
    lines.append("")

    # Logo
    lines += ["## Logo / Mark", ""]
    if logos:
        for l in logos:
            if l.startswith('['):
                lines.append(f"- {l}")
            elif l.endswith(('.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico')):
                lines.append(f"- [{l}]({l})")
                lines.append(f"  ![logo]({l})")
            else:
                lines.append(f"- [{l}]({l})")
    else:
        lines.append("_No logo detected._")
    lines.append("")

    return '\n'.join(lines)


# ─── Entry point ──────────────────────────────────────────────────────────────

def scrape(url: str, output_path: str | None = None) -> str:
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url

    print(f"Fetching {url} …")
    final_url, html, soup = fetch_page(url)

    print("Fetching stylesheets …")
    css = fetch_css(soup, final_url)

    print("Extracting colors …")
    colors = extract_colors(css, html)

    print("Extracting fonts …")
    fonts = extract_fonts(css, soup)

    print("Finding logo …")
    logos = extract_logo(soup, final_url)

    print("Reading page text …")
    page_text = extract_page_text(soup)
    meta = extract_meta(soup)

    print("Analyzing brand voice & story with Claude …")
    ai = analyze_with_claude(page_text, meta, final_url)

    print("Building markdown …")
    md = build_markdown(final_url, meta, colors, fonts, logos, ai)

    if output_path is None:
        domain = urllib.parse.urlparse(final_url).netloc.replace('www.', '')
        output_path = f"{domain}_brand_kit.md"

    Path(output_path).write_text(md, encoding='utf-8')
    print(f"\nSaved → {output_path}")
    return output_path


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    target_url = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else None
    scrape(target_url, out_file)
