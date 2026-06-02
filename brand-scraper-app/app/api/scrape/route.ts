import { NextRequest, NextResponse } from 'next/server';
import * as cheerio from 'cheerio';

// ── Types ──────────────────────────────────────────────────────────────────

interface ScrapeResult {
  siteName: string;
  url: string;
  primaryColors: string[];
  accentColors: string[];
  fonts: string[];
  logos: string[];
  brandVoice: string;
  brandStory: string;
  markdown: string;
}

interface GeminiAnalysis {
  brand_voice: string;
  brand_story: string;
  primary_colors: string[];
  accent_colors: string[];
  fonts: string[];
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

// ── Browserless fetch helpers ─────────────────────────────────────────────

/** Browserless base URL */
const BROWSERLESS_BASE = process.env.BROWSERLESS_BASE_URL || 'https://production-sfo.browserless.io';

/** Fetch fully-rendered HTML via Browserless (runs JS). Falls back to plain fetch. */
async function fetchRenderedHtml(url: string): Promise<string | null> {
  const token = process.env.BROWSERLESS_API_KEY;
  if (token) {
    try {
      const res = await fetch(`${BROWSERLESS_BASE}/chromium/content?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, waitForTimeout: 2000 }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return await res.text();
      console.error('Browserless content failed:', res.status, await res.text().then(t => t.slice(0, 300)));
    } catch (err) {
      console.error('Browserless content error:', err);
    }
  }
  return fetchStaticHtml(url);
}

/** Full-page screenshot for Gemini visual analysis. */
async function fetchScreenshot(url: string): Promise<{ data: string; mimeType: string } | null> {
  const token = process.env.BROWSERLESS_API_KEY;
  if (!token) return null;
  try {
    const res = await fetch(`${BROWSERLESS_BASE}/chromium/screenshot?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        waitForTimeout: 2000,
        options: { type: 'jpeg', quality: 85 },
        viewport: { width: 1280, height: 900 },
      }),
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) {
      console.error('Browserless screenshot failed:', res.status, await res.text().then(t => t.slice(0, 300)));
      return null;
    }
    const buffer = await res.arrayBuffer();
    return { data: Buffer.from(buffer).toString('base64'), mimeType: 'image/jpeg' };
  } catch (err) {
    console.error('Browserless screenshot error:', err);
    return null;
  }
}

/** Header-only screenshot (top 120px) to capture the logo/navbar. */
async function fetchHeaderScreenshot(url: string): Promise<{ data: string; mimeType: string } | null> {
  const token = process.env.BROWSERLESS_API_KEY;
  if (!token) return null;
  try {
    const res = await fetch(`${BROWSERLESS_BASE}/chromium/screenshot?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        waitForTimeout: 2000,
        options: { type: 'png', clip: { x: 0, y: 0, width: 1280, height: 120 } },
        viewport: { width: 1280, height: 900 },
      }),
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return { data: Buffer.from(buffer).toString('base64'), mimeType: 'image/png' };
  } catch (err) {
    console.error('Browserless header screenshot error:', err);
    return null;
  }
}

async function fetchStaticHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text')) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchCss(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

function resolveUrl(href: string, base: string): string | null {
  try { return new URL(href, base).href; } catch { return null; }
}

// ── Color / font extraction ────────────────────────────────────────────────

function hexFrequency(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let h = m[1];
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    const hex = '#' + h.toUpperCase();
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return counts;
}

/** Extract hex colors from CSS, inline styles, and SVG fill/stroke — sorted by frequency. */
function extractColorsFromPage($: ReturnType<typeof cheerio.load>, externalCss: string): string[] {
  const sources: string[] = [];

  // 1. <style> block content
  $('style').each((_: number, el: any) => { sources.push($(el).text()); });

  // 2. Inline style attributes on visible elements (not script/style tags)
  $('[style]').each((_: number, el: any) => {
    const tag = (el as any).name?.toLowerCase() || '';
    if (tag !== 'script' && tag !== 'style') sources.push($(el).attr('style') || '');
  });

  // 3. SVG fill and stroke attributes
  $('[fill],[stroke]').each((_: number, el: any) => {
    const fill = $(el).attr('fill') || '';
    const stroke = $(el).attr('stroke') || '';
    if (fill.startsWith('#')) sources.push(fill);
    if (stroke.startsWith('#')) sources.push(stroke);
  });

  // 4. External CSS
  sources.push(externalCss);

  // Sort by frequency descending so the most-used colors appear first
  const freq = hexFrequency(sources.join('\n'));
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);
}

function extractFontFamilies(css: string): string[] {
  const SKIP = new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui',
    'inherit','initial','unset','-apple-system','blinkmacsystemfont','segoe ui',
    'helvetica neue','helvetica','arial','georgia','verdana','tahoma','courier new',
    'helvetica neue']);
  const seen = new Set<string>();
  const results: string[] = [];
  // Only match font-family inside @font-face or CSS rules, not arbitrary text
  const re = /font-family\s*:\s*([^;}{]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const first = m[1].split(',')[0].trim().replace(/['"]/g, '').trim();
    if (first && first.length < 60 && !SKIP.has(first.toLowerCase()) && !seen.has(first)) {
      seen.add(first); results.push(first);
    }
  }
  return results;
}

// ── Google Fonts extraction ────────────────────────────────────────────────

function extractGoogleFonts(html: string): string[] {
  const fonts: string[] = [];
  // Match both old-style (family=Foo|Bar) and new-style (family=Foo:wght@400) Google Fonts URLs
  const re = /fonts\.googleapis\.com\/css[^"'\s]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[0];
    // Extract each `family=` param value
    const famRe = /[?&]family=([^&"'\s]+)/gi;
    let fm: RegExpExecArray | null;
    while ((fm = famRe.exec(url)) !== null) {
      // Each value may contain multiple fonts separated by `|` or repeated `family=`
      for (const chunk of fm[1].split('|')) {
        // Strip weight/style suffixes: "Inter:ital,wght@0,700" → "Inter"
        const name = decodeURIComponent(chunk.split(':')[0].split('@')[0])
          .replace(/\+/g, ' ').trim();
        if (name && !fonts.includes(name)) fonts.push(name);
      }
    }
  }
  return fonts;
}

// ── Logo detection ─────────────────────────────────────────────────────────

/**
 * For Wix CDN URLs, parse the original crop dimensions to get the true aspect ratio,
 * and reconstruct a clean high-res URL by stripping blur/tiny resize transforms.
 */
function wixLogoUrl(src: string): { url: string; aspectRatio: number } | null {
  try {
    // Match: https://static.wixstatic.com/media/{hash}/v1/.../w_NNN,h_NNN,.../{filename}
    const m = src.match(/static\.wixstatic\.com\/media\/([^/]+)/);
    if (!m) return null;
    const hash = m[1];
    // Try to extract original dimensions from crop or fill params
    const cropM = src.match(/\/crop\/[^/]*[,/]w_(\d+)[,/][^/]*h_(\d+)/);
    const fillM = src.match(/\/fill\/[^/]*[,/]w_(\d+)[,/][^/]*h_(\d+)/);
    const dims = cropM || fillM;
    if (!dims) return null;
    const origW = parseInt(dims[1]);
    const origH = parseInt(dims[2]);
    if (!origW || !origH) return null;
    const aspectRatio = origW / origH;
    // Reconstruct a clean, reasonably sized URL
    const ext = hash.split('~mv2.')[1] || hash.split('.').pop() || 'png';
    const filename = src.split('/').pop() || `logo.${ext}`;
    const cleanUrl = `https://static.wixstatic.com/media/${hash}/v1/fill/w_400,al_c,q_90,enc_avif/${filename}`;
    return { url: cleanUrl, aspectRatio };
  } catch { return null; }
}

function extractLogos($: ReturnType<typeof cheerio.load>, targetUrl: string, parsedUrl: URL): string[] {
  const logosSet = new Set<string>();
  const logoPattern = /logo|brand|mark|emblem/i;

  function addSrc(src: string) {
    if (src && !src.startsWith('data:')) {
      const abs = resolveUrl(src, targetUrl);
      if (abs) logosSet.add(abs);
    }
  }

  function addInlineSvg(el: any) {
    const svgHtml = $.html(el) as string;
    if (!svgHtml || svgHtml.length < 10 || svgHtml.length > 100000) return;
    // Only skip clearly portrait/tall icons (h > 2× w) — allow squares and landscape
    const vb = $(el).attr('viewBox') || '';
    const w = parseFloat($(el).attr('width') || '0');
    const h = parseFloat($(el).attr('height') || '0');
    const parts = vb.split(/[\s,]+/).map(parseFloat);
    const vbW = parts[2] || 0;
    const vbH = parts[3] || 0;
    const effectiveW = w || vbW || 0;
    const effectiveH = h || vbH || 0;
    if (effectiveW > 0 && effectiveH > 0 && effectiveH > effectiveW * 2) return;
    logosSet.add(`data:image/svg+xml;base64,${Buffer.from(svgHtml).toString('base64')}`);
  }

  // Tier 1: any element with logo-related class/id containing img or svg
  $('[class*="logo"],[id*="logo"],[class*="brand"],[id*="brand"]').each((_: number, el: any) => {
    $(el).find('img').addBack('img').each((_2: number, img: any) => addSrc($(img).attr('src') || $(img).attr('data-src') || ''));
    $(el).find('svg').addBack('svg').each((_2: number, svg: any) => addInlineSvg(svg));
  });

  // Tier 2: imgs/svgs inside header/nav
  if (logosSet.size === 0) {
    const navCtx = $('header, nav, [class*="header"], [class*="navbar"], [class*="nav-bar"], [role="banner"]');
    navCtx.find('img').each((_: number, el: any) => addSrc($(el).attr('src') || $(el).attr('data-src') || ''));
    navCtx.find('svg').each((_: number, el: any) => addInlineSvg(el));
  }

  // Tier 3: <a href="/"> wrapping img/svg
  if (logosSet.size === 0) {
    $('a').each((_: number, el: any) => {
      const href = $(el).attr('href') || '';
      if (href === '/' || href === targetUrl || href === parsedUrl.origin + '/') {
        $(el).find('img').each((_2: number, img: any) => addSrc($(img).attr('src') || ''));
        $(el).find('svg').first().each((_2: number, svg: any) => addInlineSvg(svg));
      }
    });
  }

  // Tier 4: any img with logo-related keywords
  if (logosSet.size === 0) {
    $('img').each((_: number, el: any) => {
      const src = $(el).attr('src') || '';
      const signals = [src, $(el).attr('alt') || '', $(el).attr('class') || '', $(el).attr('id') || ''].join(' ');
      if (logoPattern.test(signals)) addSrc(src);
    });
  }

  // Tier 5: wide-aspect-ratio images (wordmarks) — catches Wix and similar CDN-hosted logos
  if (logosSet.size === 0) {
    let bestAR = 0;
    let bestUrl = '';
    $('img').each((_: number, el: any) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src) return;
      const parsed = wixLogoUrl(src);
      if (parsed && parsed.aspectRatio > 2.5 && parsed.aspectRatio > bestAR) {
        bestAR = parsed.aspectRatio;
        bestUrl = parsed.url;
      }
    });
    if (bestUrl) logosSet.add(bestUrl);
  }

  // Tier 7: og:image
  if (logosSet.size === 0) {
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    if (ogImage) { const abs = resolveUrl(ogImage, targetUrl); if (abs) logosSet.add(abs); }
  }

  // Tier 8: favicon
  if (logosSet.size === 0) {
    $('link[rel*="icon"]').each((_: number, el: any) => {
      const href = $(el).attr('href') || '';
      if (href) { const abs = resolveUrl(href, targetUrl); if (abs) logosSet.add(abs); }
    });
  }

  return [...logosSet].slice(0, 5);
}

// ── Gemini analysis ────────────────────────────────────────────────────────

async function analyzeWithGemini(
  pageText: string,
  allHexColors: string[],
  cssFonts: string[],
  googleFonts: string[],
  siteName: string,
  targetUrl: string,
  ogDescription: string,
  screenshot?: { data: string; mimeType: string },
): Promise<GeminiAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const allFonts = [...new Set([...cssFonts, ...googleFonts])];

  const hasScreenshot = !!screenshot;
  const colorSource = hasScreenshot
    ? 'the screenshot (most accurate) and the candidate list as a reference'
    : 'the CANDIDATE COLORS list extracted from CSS and inline styles';

  const prompt = `You are a brand analyst. Classify the CANDIDATE COLORS list into primary and accent brand colors.
${hasScreenshot ? 'A rendered screenshot is attached — use it to judge which candidate colors are visually prominent on the page.' : ''}

STRICT RULE: You MUST only return hex values that appear EXACTLY in the CANDIDATE COLORS list. Do not invent, approximate, or interpolate any color. Every hex value in your response must match one from the list verbatim.

Return a JSON object with EXACTLY these five keys:

1. "brand_voice": 2-4 sentences on the brand's tone, personality, and communication style.
2. "brand_story": 3-5 sentences on what this company does, its mission, and who it serves.
3. "primary_colors": Array of 2-4 hex values FROM THE CANDIDATE LIST. Pick the colors that appear most frequently — the ones that define the overall look of the page (backgrounds, dominant text color, primary brand color). Favor colors near the TOP of the candidate list since they are the most frequently used.
4. "accent_colors": Array of 4-8 hex values FROM THE CANDIDATE LIST. Include: recurring text/link/heading colors, button colors, graphic and illustration colors, gradient colors. If a color is used consistently for text or links throughout the site, it belongs here. EXCLUDE values where all RGB channels are below 50 or above 210.
5. "fonts": Array of 1-3 font names as REAL published names. Convert: "madefor-display" → "Wix Madefor Display", "madefor-text" → "Wix Madefor Text", "gt-walsheim" → "GT Walsheim". One entry per typeface family. Return [] if none found.

Website: ${targetUrl}
Site name: ${siteName}
Meta description: ${ogDescription}

CANDIDATE COLORS (sorted by frequency of use on the page — colors near the top appear more often in CSS and are more likely to be brand colors; ONLY return values from this exact list):
${allHexColors.slice(0, 300).join(', ')}

CANDIDATE FONTS:
${allFonts.join(', ') || '(none detected)'}

PAGE TEXT (truncated):
${pageText.slice(0, 2000)}

Return ONLY valid JSON, no markdown:
{"brand_voice":"...","brand_story":"...","primary_colors":["#RRGGBB",...],"accent_colors":["#RRGGBB",...],"fonts":["..."]}`;

  const parts: object[] = screenshot
    ? [{ inlineData: { mimeType: screenshot.mimeType, data: screenshot.data } }, { text: prompt }]
    : [{ text: prompt }];

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    const candidateSet = new Set(allHexColors.map(c => c.toUpperCase()));
    const validHex = (arr: unknown) => Array.isArray(arr)
      ? (arr as unknown[]).filter((c): c is string =>
          typeof c === 'string' &&
          /^#[0-9a-fA-F]{6}$/i.test(c) &&
          candidateSet.has(c.toUpperCase()))
      : [];
    return {
      brand_voice: parsed.brand_voice ?? '',
      brand_story: parsed.brand_story ?? '',
      primary_colors: validHex(parsed.primary_colors).slice(0, 3),
      accent_colors: validHex(parsed.accent_colors).slice(0, 8),
      fonts: Array.isArray(parsed.fonts) ? parsed.fonts.slice(0, 3) : [],
    };
  } catch {
    return { brand_voice: text, brand_story: '', primary_colors: [], accent_colors: [], fonts: [] };
  }
}

// ── Markdown builder ───────────────────────────────────────────────────────

function buildMarkdown(result: Omit<ScrapeResult, 'markdown'>): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split('T')[0];
  lines.push(`# Brand Kit: ${result.siteName}`);
  lines.push(`> Generated by Brand Scraper on ${date}`);
  lines.push(`> Source: ${result.url}`);
  lines.push('');
  if (result.brandStory) { lines.push('## Brand Story', '', result.brandStory, ''); }
  if (result.brandVoice) { lines.push('## Brand Voice', '', result.brandVoice, ''); }
  if (result.primaryColors.length > 0) {
    lines.push('## Primary Colors', '');
    for (const c of result.primaryColors) lines.push(`- \`${c}\``);
    lines.push('');
  }
  if (result.accentColors.length > 0) {
    lines.push('## Accent Colors', '');
    for (const c of result.accentColors) lines.push(`- \`${c}\``);
    lines.push('');
  }
  if (result.fonts.length > 0) {
    lines.push('## Typography', '');
    for (const f of result.fonts) lines.push(`- ${f}`);
    lines.push('');
  }
  if (result.logos.length > 0) {
    lines.push('## Logos & Icons', '');
    for (const l of result.logos) lines.push(`- ${l.startsWith('data:') ? '[inline SVG]' : l}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const rawUrl = body?.url?.trim();
  if (!rawUrl) return NextResponse.json({ error: 'Missing "url" field.' }, { status: 400 });

  let targetUrl = rawUrl;
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  let parsedUrl: URL;
  try { parsedUrl = new URL(targetUrl); }
  catch { return NextResponse.json({ error: `Invalid URL: "${rawUrl}"` }, { status: 400 }); }

  // ── 1. Fetch rendered HTML + screenshots in parallel (Browserless) ──────
  const [html, screenshot, headerScreenshot] = await Promise.all([
    fetchRenderedHtml(targetUrl),
    fetchScreenshot(targetUrl),
    fetchHeaderScreenshot(targetUrl),
  ]);
  if (!html) return NextResponse.json({ error: `Could not fetch ${targetUrl}.` }, { status: 422 });

  const $ = cheerio.load(html);

  // ── 2. Meta ─────────────────────────────────────────────────────────────
  const siteName = (
    $('meta[property="og:site_name"]').attr('content') ||
    $('title').first().text() ||
    parsedUrl.hostname
  ).trim().slice(0, 120);

  const ogDescription =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') || '';

  // ── 3. Collect CSS (inline <style> blocks + up to 3 external sheets) ─────
  let inlineCss = '';
  $('style').each((_: number, el: any) => { inlineCss += $(el).text() + '\n'; });

  const cssLinks: string[] = [];
  $('link[rel="stylesheet"]').each((_: number, el: any) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('fonts.googleapis.com') && cssLinks.length < 3) {
      const abs = resolveUrl(href, targetUrl);
      if (abs) cssLinks.push(abs);
    }
  });
  const externalCssParts = await Promise.all(cssLinks.map(fetchCss));
  const rawCss = inlineCss + externalCssParts.join('\n');

  // ── 4. Extract hex colors from CSS + inline styles only (not scripts) ────
  const externalCss = externalCssParts.join('\n');
  const allHexColors = extractColorsFromPage($, externalCss);
  const cssFonts = extractFontFamilies(rawCss + '\n' + externalCss);

  // ── 5. Google Fonts ─────────────────────────────────────────────────────
  const googleFonts = extractGoogleFonts(html);

  // ── 6. Logo — DOM extraction first, header screenshot as fallback only
  const domLogos = extractLogos($, targetUrl, parsedUrl);
  const logos: string[] = domLogos.length > 0
    ? domLogos
    : headerScreenshot
      ? [`data:${headerScreenshot.mimeType};base64,${headerScreenshot.data}`]
      : [];

  // ── 7. Page text ────────────────────────────────────────────────────────
  $('script, style, noscript, iframe').remove();
  const pageText = $('body').text().replace(/\s+/g, ' ').trim();

  // ── 8. Gemini analysis (with screenshot if available) ──────────────────
  let analysis: GeminiAnalysis;
  try {
    analysis = await analyzeWithGemini(pageText, allHexColors, cssFonts, googleFonts, siteName, targetUrl, ogDescription, screenshot ?? undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Gemini error:', msg);
    return NextResponse.json({ error: `Gemini analysis failed: ${msg}` }, { status: 502 });
  }

  // ── 9. Merge fonts ──────────────────────────────────────────────────────
  const fonts = [...new Set([...analysis.fonts, ...googleFonts])].slice(0, 4);

  // ── 10. Build result ────────────────────────────────────────────────────
  const partial: Omit<ScrapeResult, 'markdown'> = {
    siteName,
    url: targetUrl,
    primaryColors: analysis.primary_colors,
    accentColors: analysis.accent_colors,
    fonts,
    logos,
    brandVoice: analysis.brand_voice,
    brandStory: analysis.brand_story,
  };

  return NextResponse.json({ ...partial, markdown: buildMarkdown(partial) });
}
