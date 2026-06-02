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

async function fetchScreenshotAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  // Microlink: free tier, reliable from server-side, returns JSON with screenshot URL
  try {
    // Step 1: get the screenshot image URL from Microlink
    const metaRes = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false`, {
      headers: { 'x-api-key': '' },
      signal: AbortSignal.timeout(30000),
    });
    if (!metaRes.ok) {
      console.error('Microlink meta fetch failed:', metaRes.status);
      return null;
    }
    const metaJson = await metaRes.json();
    const imgUrl: string | undefined = metaJson?.data?.screenshot?.url;
    if (!imgUrl) {
      console.error('Microlink returned no screenshot URL:', JSON.stringify(metaJson).slice(0, 200));
      return null;
    }

    // Step 2: fetch the actual image bytes
    const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
    if (!imgRes.ok) {
      console.error('Screenshot image fetch failed:', imgRes.status);
      return null;
    }
    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    return { data: base64, mimeType: ct.split(';')[0].trim() };
  } catch (err) {
    console.error('fetchScreenshotAsBase64 error:', err);
    return null;
  }
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
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

// ── Logo detection from DOM ────────────────────────────────────────────────

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
    if (svgHtml && svgHtml.length < 50000) {
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(svgHtml).toString('base64')}`;
      logosSet.add(dataUri);
    }
  }

  // Tier 1: imgs/svgs inside header/nav
  const navContext = $('header, nav, [class*="header"], [class*="navbar"], [class*="nav-bar"], [role="banner"]');
  navContext.find('img').each((_: number, el: any) => {
    addSrc($(el).attr('src') || $(el).attr('data-src') || '');
  });
  navContext.find('svg').first().each((_: number, el: any) => addInlineSvg(el));

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
    if (ogImage) {
      const abs = resolveUrl(ogImage, targetUrl);
      if (abs) logosSet.add(abs);
    }
  }

  // Tier 5: favicon
  if (logosSet.size === 0) {
    $('link[rel*="icon"]').each((_: number, el: any) => {
      const href = $(el).attr('href') || '';
      if (href) {
        const abs = resolveUrl(href, targetUrl);
        if (abs) logosSet.add(abs);
      }
    });
  }

  return [...logosSet].slice(0, 5);
}

// ── Gemini vision analysis ─────────────────────────────────────────────────

async function analyzeWithGemini(
  screenshotB64: string,
  mimeType: string,
  pageText: string,
  siteName: string,
  targetUrl: string,
  ogDescription: string,
): Promise<GeminiAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const prompt = `You are a brand analyst. You have been given a screenshot of a website plus its page text.

Analyze the screenshot and text carefully, then return a JSON object with EXACTLY these four keys:

1. "brand_voice": 2-4 sentences describing the brand's tone, personality, and communication style based on the visual design and copy.
2. "brand_story": 3-5 sentences describing what this company does, its mission, and who it serves.
3. "colors": An array of 3-8 hex color strings (e.g. "#1A2B3C") representing the brand's PRIMARY colors as visually rendered on the page — the most prominent and intentional colors you can see. Do NOT include near-white backgrounds or near-black text unless they are clearly a brand color choice. Focus on accent colors, button colors, logo colors, and hero section colors.
4. "fonts": An array of 1-3 font name strings for the most prominent typefaces used in headings and body text (e.g. ["Inter", "Playfair Display"]).

Website: ${targetUrl}
Site name: ${siteName}
Meta description: ${ogDescription}

Page text (truncated):
${pageText.slice(0, 3000)}

Return ONLY valid JSON with no markdown fences:
{"brand_voice":"...","brand_story":"...","colors":["#RRGGBB",...],"fonts":["..."]}`;

  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: screenshotB64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.2 },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // Strip markdown fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      brand_voice: parsed.brand_voice ?? parsed.brandVoice ?? '',
      brand_story: parsed.brand_story ?? parsed.brandStory ?? '',
      colors: Array.isArray(parsed.colors) ? parsed.colors.filter((c: unknown) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/i.test(c)) : [],
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
    for (const c of result.colors) lines.push(`- \`${c}\``);
    lines.push('');
  }

  if (result.fonts.length > 0) {
    lines.push('## Typography');
    lines.push('');
    for (const f of result.fonts) lines.push(`- ${f}`);
    lines.push('');
  }

  if (result.logos.length > 0) {
    lines.push('## Logos & Icons');
    lines.push('');
    for (const l of result.logos) lines.push(`- ${l}`);
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
    return NextResponse.json({ error: 'Missing "url" field.' }, { status: 400 });
  }

  let targetUrl = rawUrl;
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return NextResponse.json({ error: `Invalid URL: "${rawUrl}"` }, { status: 400 });
  }

  // ── 1. Fetch HTML and screenshot in parallel ────────────────────────────
  const [html, screenshot] = await Promise.all([
    fetchHtml(targetUrl),
    fetchScreenshotAsBase64(targetUrl),
  ]);

  if (!html) {
    return NextResponse.json({ error: `Could not fetch ${targetUrl}. The site may be blocking scrapers.` }, { status: 422 });
  }

  const $ = cheerio.load(html);

  // ── 2. Site name + meta ─────────────────────────────────────────────────
  const siteName = (
    $('meta[property="og:site_name"]').attr('content') ||
    $('title').first().text() ||
    parsedUrl.hostname
  ).trim().slice(0, 120);

  const ogDescription =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') || '';

  // ── 3. Page text ────────────────────────────────────────────────────────
  $('script, style, noscript, iframe').remove();
  const pageText = $('body').text().replace(/\s+/g, ' ').trim();

  // ── 4. Logo (DOM) ───────────────────────────────────────────────────────
  const logos = extractLogos($, targetUrl, parsedUrl);

  // ── 5. Google Fonts (DOM) ───────────────────────────────────────────────
  const googleFonts = extractGoogleFonts(html);

  // ── 6. Gemini vision analysis ───────────────────────────────────────────
  let analysis: GeminiAnalysis = { brand_voice: '', brand_story: '', colors: [], fonts: [] };

  if (screenshot) {
    try {
      analysis = await analyzeWithGemini(
        screenshot.data,
        screenshot.mimeType,
        pageText,
        siteName,
        targetUrl,
        ogDescription,
      );
    } catch (err) {
      console.error('Gemini vision error:', err);
    }
  } else {
    // Screenshot failed — fall back to text-only Gemini call
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const prompt = `Analyze this website and return JSON with keys brand_voice (2-4 sentences), brand_story (3-5 sentences), colors (empty array), fonts (empty array).
Website: ${targetUrl}
Text: ${pageText.slice(0, 5000)}
Return ONLY JSON: {"brand_voice":"...","brand_story":"...","colors":[],"fonts":[]}`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(60000),
        });
        if (res.ok) {
          const data = await res.json();
          const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
          if (m) {
            const parsed = JSON.parse(m[1].trim());
            analysis.brand_voice = parsed.brand_voice ?? '';
            analysis.brand_story = parsed.brand_story ?? '';
          }
        }
      } catch (err) {
        console.error('Gemini text fallback error:', err);
      }
    }
  }

  // ── 7. Merge fonts: Gemini visual + Google Fonts from DOM ───────────────
  const fonts = [...new Set([...analysis.fonts, ...googleFonts])].slice(0, 4);

  // ── 8. Build result ─────────────────────────────────────────────────────
  const partial: Omit<ScrapeResult, 'markdown'> = {
    siteName,
    url: targetUrl,
    colors: analysis.colors,
    fonts,
    logos,
    brandVoice: analysis.brand_voice,
    brandStory: analysis.brand_story,
  };

  const markdown = buildMarkdown(partial);
  return NextResponse.json({ ...partial, markdown });
}
