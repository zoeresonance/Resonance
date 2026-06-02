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

interface GeminiAnalysis {
  brand_voice: string;
  brand_story: string;
  colors: string[];
  fonts: string[];
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string | null> {
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

function hexFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let h = m[1];
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    const hex = '#' + h.toUpperCase();
    if (!seen.has(hex)) { seen.add(hex); out.push(hex); }
  }
  return out;
}

/** Extract hex colors ONLY from CSS and inline style attributes — never from script content. */
function extractColorsFromPage($: ReturnType<typeof cheerio.load>, externalCss: string): string[] {
  const sources: string[] = [];

  // 1. <style> block content
  $('style').each((_: number, el: any) => { sources.push($(el).text()); });

  // 2. Inline style attributes on visible elements (not script/style tags)
  $('[style]').each((_: number, el: any) => {
    const tag = (el as any).name?.toLowerCase() || '';
    if (tag !== 'script' && tag !== 'style') sources.push($(el).attr('style') || '');
  });

  // 3. External CSS
  sources.push(externalCss);

  return hexFromText(sources.join('\n'));
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
  const re = /fonts\.googleapis\.com\/css[^"']*[?&]family=([^"'&]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    for (const fam of m[1].split('|')) {
      const name = decodeURIComponent(fam.split(':')[0]).replace(/\+/g, ' ').trim();
      if (name && !fonts.includes(name)) fonts.push(name);
    }
  }
  return fonts;
}

// ── Logo detection ─────────────────────────────────────────────────────────

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
    if (svgHtml && svgHtml.length > 10 && svgHtml.length < 100000) {
      logosSet.add(`data:image/svg+xml;base64,${Buffer.from(svgHtml).toString('base64')}`);
    }
  }

  // Tier 1: imgs/svgs inside header/nav
  const navCtx = $('header, nav, [class*="header"], [class*="navbar"], [class*="nav-bar"], [role="banner"]');
  navCtx.find('img').each((_: number, el: any) => addSrc($(el).attr('src') || $(el).attr('data-src') || ''));
  navCtx.find('svg').first().each((_: number, el: any) => addInlineSvg(el));

  // Tier 2: <a href="/"> wrapping img/svg
  $('a').each((_: number, el: any) => {
    const href = $(el).attr('href') || '';
    if (href === '/' || href === targetUrl || href === parsedUrl.origin + '/') {
      $(el).find('img').each((_2: number, img: any) => addSrc($(img).attr('src') || ''));
      $(el).find('svg').first().each((_2: number, svg: any) => addInlineSvg(svg));
    }
  });

  // Tier 3: any img with logo-related keywords
  if (logosSet.size === 0) {
    $('img').each((_: number, el: any) => {
      const src = $(el).attr('src') || '';
      const signals = [src, $(el).attr('alt') || '', $(el).attr('class') || '', $(el).attr('id') || ''].join(' ');
      if (logoPattern.test(signals)) addSrc(src);
    });
  }

  // Tier 4: og:image
  if (logosSet.size === 0) {
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    if (ogImage) { const abs = resolveUrl(ogImage, targetUrl); if (abs) logosSet.add(abs); }
  }

  // Tier 5: favicon
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
): Promise<GeminiAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const allFonts = [...new Set([...cssFonts, ...googleFonts])];

  const prompt = `You are a brand analyst. Analyze the website data below to extract brand identity.

Return a JSON object with EXACTLY these four keys:

1. "brand_voice": 2-4 sentences on the brand's tone, personality, and communication style.
2. "brand_story": 3-5 sentences on what this company does, its mission, and who it serves.
3. "colors": Pick 3-8 hex codes from the CANDIDATE COLORS list that represent the brand's intentional palette — accent colors, button colors, link colors, hero/section backgrounds, logo colors. EXCLUDE near-whites (all channels > 210) and near-blacks (all channels < 50) and pure grays (r≈g≈b) unless clearly a brand choice. Return as "#RRGGBB" strings.
4. "fonts": Pick 1-3 font names from the CANDIDATE FONTS list that are the primary typefaces. If the list is empty return an empty array.

Website: ${targetUrl}
Site name: ${siteName}
Meta description: ${ogDescription}

CANDIDATE COLORS (all hex values found on the page):
${allHexColors.slice(0, 300).join(', ')}

CANDIDATE FONTS:
${allFonts.join(', ') || '(none detected)'}

PAGE TEXT (truncated):
${pageText.slice(0, 2000)}

Return ONLY valid JSON, no markdown:
{"brand_voice":"...","brand_story":"...","colors":["#RRGGBB",...],"fonts":["..."]}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(60000),
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
    return {
      brand_voice: parsed.brand_voice ?? '',
      brand_story: parsed.brand_story ?? '',
      colors: Array.isArray(parsed.colors)
        ? parsed.colors.filter((c: unknown) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/i.test(c)).slice(0, 10)
        : [],
      fonts: Array.isArray(parsed.fonts) ? parsed.fonts.slice(0, 3) : [],
    };
  } catch {
    return { brand_voice: text, brand_story: '', colors: [], fonts: [] };
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
  if (result.colors.length > 0) {
    lines.push('## Color Palette', '');
    for (const c of result.colors) lines.push(`- \`${c}\``);
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

  // ── 1. Fetch HTML ───────────────────────────────────────────────────────
  const html = await fetchHtml(targetUrl);
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

  // ── 6. Logo (DOM) ───────────────────────────────────────────────────────
  const logos = extractLogos($, targetUrl, parsedUrl);

  // ── 7. Page text ────────────────────────────────────────────────────────
  $('script, style, noscript, iframe').remove();
  const pageText = $('body').text().replace(/\s+/g, ' ').trim();

  // ── 8. Gemini analysis ──────────────────────────────────────────────────
  let analysis: GeminiAnalysis = { brand_voice: '', brand_story: '', colors: [], fonts: [] };
  try {
    analysis = await analyzeWithGemini(pageText, allHexColors, cssFonts, googleFonts, siteName, targetUrl, ogDescription);
  } catch (err) {
    console.error('Gemini error:', err);
  }

  // ── 9. Merge fonts ──────────────────────────────────────────────────────
  const fonts = [...new Set([...analysis.fonts, ...googleFonts])].slice(0, 4);

  // ── 10. Build result ────────────────────────────────────────────────────
  const partial: Omit<ScrapeResult, 'markdown'> = {
    siteName,
    url: targetUrl,
    colors: analysis.colors,
    fonts,
    logos,
    brandVoice: analysis.brand_voice,
    brandStory: analysis.brand_story,
  };

  return NextResponse.json({ ...partial, markdown: buildMarkdown(partial) });
}
