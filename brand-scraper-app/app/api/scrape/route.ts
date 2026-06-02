import { NextRequest, NextResponse } from 'next/server';
import * as cheerio from 'cheerio';

// ── Types ──────────────────────────────────────────────────────────────────

interface ScrapeResult {
  siteName: string;
  url: string;
  colors: string[];
  fonts: string[];
  logos: string[];
  brandVoice: string;
  brandStory: string;
  markdown: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Normalise hex to uppercase 6-char form, return null if invalid. */
function normaliseHex(raw: string): string | null {
  let h = raw.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return null;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return '#' + h.toUpperCase();
}

/** Return true when the hex is near-black or near-white (filter these out). */
function isNearBlackOrWhite(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // near-black: all channels < 16 (0x10)
  if (r < 16 && g < 16 && b < 16) return true;
  // near-white: all channels > 239 (0xEF)  — maps to > #EFEFEF
  if (r > 239 && g > 239 && b > 239) return true;
  return false;
}

/** Extract all hex colour values from a CSS string. */
function extractColorsFromCss(css: string): string[] {
  const results: string[] = [];
  // Match #RGB and #RRGGBB
  const matches = css.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) || [];
  for (const m of matches) {
    const norm = normaliseHex(m);
    if (norm && !isNearBlackOrWhite(norm)) results.push(norm);
  }
  return results;
}

/** Extract font-family values from a CSS string. */
function extractFontsFromCss(css: string): string[] {
  const fonts: string[] = [];
  // font-family: "Font Name", fallback
  const re = /font-family\s*:\s*([^;}{]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const parts = m[1].split(',');
    for (const part of parts) {
      const name = part.trim().replace(/['"]/g, '').trim();
      // skip generic families and variables
      const skip = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
        'inherit', 'initial', 'unset', '-apple-system', 'blinkmacsystemfont',
        'segoe ui', 'helvetica', 'arial', 'times new roman', 'georgia', 'verdana',
        'tahoma', 'trebuchet ms', 'impact', 'comic sans ms', 'courier new'];
      if (name && !skip.includes(name.toLowerCase()) && name.length < 60) {
        fonts.push(name);
      }
    }
  }
  return fonts;
}

/** Fetch HTML from a URL with a browser-like UA, return null on error. */
async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
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

/** Fetch a CSS file (plain text), return empty string on error. */
async function fetchCss(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/** Resolve a potentially relative URL against a base URL. */
function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// ── Gemini ─────────────────────────────────────────────────────────────────

interface GeminiInsights {
  brand_voice: string;
  brand_story: string;
}

async function callGemini(prompt: string): Promise<GeminiInsights> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // Try to parse JSON from the response (may be wrapped in markdown fences)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return {
        brand_voice: parsed.brand_voice ?? parsed.brandVoice ?? '',
        brand_story: parsed.brand_story ?? parsed.brandStory ?? '',
      };
    } catch {
      // fall through to plain text
    }
  }

  // Plain text fallback: split by headers if present
  return { brand_voice: text, brand_story: '' };
}

// ── Markdown builder ───────────────────────────────────────────────────────

function buildMarkdown(result: Omit<ScrapeResult, 'markdown'>): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split('T')[0];

  lines.push(`# Brand Kit: ${result.siteName}`);
  lines.push(`> Generated by Brand Scraper on ${date}`);
  lines.push(`> Source: ${result.url}`);
  lines.push('');

  if (result.brandStory) {
    lines.push('## Brand Story');
    lines.push('');
    lines.push(result.brandStory);
    lines.push('');
  }

  if (result.brandVoice) {
    lines.push('## Brand Voice');
    lines.push('');
    lines.push(result.brandVoice);
    lines.push('');
  }

  if (result.colors.length > 0) {
    lines.push('## Color Palette');
    lines.push('');
    for (const c of result.colors) {
      lines.push(`- \`${c}\``);
    }
    lines.push('');
  }

  if (result.fonts.length > 0) {
    lines.push('## Typography');
    lines.push('');
    for (const f of result.fonts) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (result.logos.length > 0) {
    lines.push('## Logos & Icons');
    lines.push('');
    for (const l of result.logos) {
      lines.push(`- ${l}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const rawUrl = body?.url?.trim();
  if (!rawUrl) {
    return NextResponse.json({ error: 'Missing "url" field in request body.' }, { status: 400 });
  }

  // Ensure the URL has a protocol
  let targetUrl = rawUrl;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return NextResponse.json({ error: `Invalid URL: "${rawUrl}"` }, { status: 400 });
  }

  // ── 1. Fetch page HTML ──────────────────────────────────────────────────
  const html = await fetchHtml(targetUrl);
  if (!html) {
    return NextResponse.json({ error: `Could not fetch the page at ${targetUrl}. The site may be blocking scrapers or is unreachable.` }, { status: 422 });
  }

  const $ = cheerio.load(html);

  // ── 2. Meta ─────────────────────────────────────────────────────────────
  const title =
    $('meta[property="og:site_name"]').attr('content') ||
    $('title').first().text() ||
    parsedUrl.hostname;

  const siteName = title.trim().slice(0, 120) || parsedUrl.hostname;

  // ── 3. Inline CSS from <style> blocks ───────────────────────────────────
  let inlineCss = '';
  $('style').each((_, el) => {
    inlineCss += $(el).text() + '\n';
  });

  // Collect colors and fonts from inline CSS
  const colorsSet = new Set<string>(extractColorsFromCss(inlineCss));
  const fontsSet = new Set<string>(extractFontsFromCss(inlineCss));

  // ── 4. Inline style attributes ──────────────────────────────────────────
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    for (const c of extractColorsFromCss(style)) colorsSet.add(c);
  });

  // ── 5. Google Fonts from <link> tags ────────────────────────────────────
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('fonts.googleapis.com')) {
      // Extract family names from URL: ?family=Open+Sans:400|Roboto
      const match = href.match(/[?&]family=([^&]+)/);
      if (match) {
        const families = match[1].split('|');
        for (const fam of families) {
          const name = decodeURIComponent(fam.split(':')[0]).replace(/\+/g, ' ').trim();
          if (name) fontsSet.add(name);
        }
      }
    }
  });

  // ── 6. Fetch linked stylesheets (up to 3, skip Google Fonts) ───────────
  const cssLinks: string[] = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('fonts.googleapis.com') && cssLinks.length < 3) {
      const abs = resolveUrl(href, targetUrl);
      if (abs) cssLinks.push(abs);
    }
  });

  await Promise.all(
    cssLinks.map(async (cssUrl) => {
      const css = await fetchCss(cssUrl);
      if (!css) return;
      for (const c of extractColorsFromCss(css)) colorsSet.add(c);
      for (const f of extractFontsFromCss(css)) fontsSet.add(f);
    })
  );

  // ── 7. Logo detection ───────────────────────────────────────────────────
  const logosSet = new Set<string>();

  // <img> tags with logo-ish signals
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    const alt = ($(el).attr('alt') || '').toLowerCase();
    const cls = ($(el).attr('class') || '').toLowerCase();
    const id = ($(el).attr('id') || '').toLowerCase();
    const isLogo =
      /logo|brand|mark|emblem|icon/.test(src.toLowerCase()) ||
      /logo|brand|mark/.test(alt) ||
      /logo|brand|mark/.test(cls) ||
      /logo|brand|mark/.test(id);
    if (isLogo && src) {
      const abs = resolveUrl(src, targetUrl);
      if (abs) logosSet.add(abs);
    }
  });

  // <link rel="icon"> / apple-touch-icon
  $('link[rel*="icon"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href) {
      const abs = resolveUrl(href, targetUrl);
      if (abs) logosSet.add(abs);
    }
  });

  // ── 8. Page text (stripped) ─────────────────────────────────────────────
  $('script, style, noscript, iframe, nav, footer, header').remove();
  const bodyText = $('body')
    .text()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  const ogDescription =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';

  // ── 9. Gemini call ──────────────────────────────────────────────────────
  const prompt = `You are a brand analyst. Analyse the following website content and return a JSON object with exactly two keys:
- "brand_voice": A paragraph describing the brand's tone, communication style, and personality (2-4 sentences).
- "brand_story": A paragraph describing what the company does, its mission/values, and who it serves (3-5 sentences).

Website: ${targetUrl}
Site name: ${siteName}
Meta description: ${ogDescription}

Page content (truncated to 6000 chars):
${bodyText}

Return ONLY valid JSON, no markdown fences, no extra text:
{"brand_voice": "...", "brand_story": "..."}`;

  let geminiResult: GeminiInsights = { brand_voice: '', brand_story: '' };
  try {
    geminiResult = await callGemini(prompt);
  } catch (err) {
    // Non-fatal — return partial results with an empty voice/story
    console.error('Gemini error:', err);
  }

  // ── 10. Deduplicate and cap ─────────────────────────────────────────────
  const colors = [...colorsSet].slice(0, 20);
  const fonts = [...new Set([...fontsSet])].slice(0, 15);
  const logos = [...logosSet].slice(0, 8);

  // ── 11. Build result ────────────────────────────────────────────────────
  const partial: Omit<ScrapeResult, 'markdown'> = {
    siteName,
    url: targetUrl,
    colors,
    fonts,
    logos,
    brandVoice: geminiResult.brand_voice,
    brandStory: geminiResult.brand_story,
  };

  const markdown = buildMarkdown(partial);

  const result: ScrapeResult = { ...partial, markdown };

  return NextResponse.json(result);
}
