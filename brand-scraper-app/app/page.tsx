'use client';

import { useState } from 'react';
import BrandKit from './components/BrandKit';

interface BrandResult {
  siteName: string;
  url: string;
  colors: string[];
  fonts: string[];
  logos: string[];
  brandVoice: string;
  brandStory: string;
  screenshotUrl?: string;
  markdown: string;
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BrandResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScrape(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error || 'An unexpected error occurred.');
      } else {
        setResult(data);
      }
    } catch (err) {
      setError('Network error: could not reach the scrape API.');
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!result) return;
    const blob = new Blob([result.markdown], { type: 'text/markdown' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    const safeName = (result.siteName || 'brand')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    a.download = `${safeName}-brand-kit.md`;
    a.click();
    URL.revokeObjectURL(blobUrl);
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      {/* Hero / Input Section */}
      <div className="bg-gradient-to-br from-gray-900 via-gray-950 to-black border-b border-gray-800">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-indigo-900/40 border border-indigo-700/40 px-4 py-1.5 text-sm text-indigo-300">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
            Powered by Gemini 2.5 Flash
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4 bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
            Brand Scraper
          </h1>
          <p className="text-gray-400 text-lg mb-10 max-w-xl mx-auto">
            Enter any website URL and extract its brand colors, fonts, logo, brand voice, and brand story — instantly.
          </p>

          <form onSubmit={handleScrape} className="flex flex-col sm:flex-row gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              required
              className="flex-1 rounded-xl bg-gray-800 border border-gray-700 px-5 py-3.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed px-7 py-3.5 font-semibold text-white transition-colors flex items-center justify-center gap-2 min-w-[140px]"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Scraping…
                </>
              ) : (
                'Scrape Brand'
              )}
            </button>
          </form>

          {loading && (
            <p className="mt-4 text-sm text-gray-500 animate-pulse">
              Fetching site, parsing HTML, and asking Gemini… this may take 10–30s.
            </p>
          )}
        </div>
      </div>

      {/* Results Section */}
      <div className="max-w-5xl mx-auto px-6 py-12">
        {error && (
          <div className="rounded-xl bg-red-950/50 border border-red-800 px-6 py-4 text-red-300 mb-8">
            <strong className="font-semibold">Error:</strong> {error}
          </div>
        )}

        {result && (
          <div>
            <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
              <div>
                <h2 className="text-2xl font-bold text-white">{result.siteName}</h2>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 text-sm mt-1 inline-block"
                >
                  {result.url}
                </a>
              </div>
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 px-5 py-2.5 text-sm font-medium text-gray-200 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download .md
              </button>
            </div>

            <BrandKit result={result} />
          </div>
        )}
      </div>
    </main>
  );
}
