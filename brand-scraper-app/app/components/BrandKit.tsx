'use client';

interface BrandResult {
  siteName: string;
  url: string;
  colors: string[];
  fonts: string[];
  logos: string[];
  brandVoice: string;
  brandStory: string;
  markdown: string;
}

interface Props {
  result: BrandResult;
}

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|svg|webp|ico)(\?.*)?$/i;

function isImageUrl(url: string): boolean {
  return IMAGE_EXTENSIONS.test(url);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 p-6 mb-6">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-4">{title}</h3>
      {children}
    </div>
  );
}

export default function BrandKit({ result }: Props) {
  const { colors, fonts, logos, brandVoice, brandStory } = result;

  return (
    <div className="grid grid-cols-1 gap-0">
      {/* Brand Story */}
      {brandStory && (
        <Section title="Brand Story">
          <p className="text-gray-300 leading-relaxed whitespace-pre-wrap">{brandStory}</p>
        </Section>
      )}

      {/* Brand Voice */}
      {brandVoice && (
        <Section title="Brand Voice">
          <p className="text-gray-300 leading-relaxed whitespace-pre-wrap">{brandVoice}</p>
        </Section>
      )}

      {/* Color Palette */}
      {colors.length > 0 && (
        <Section title={`Color Palette (${colors.length})`}>
          <div className="flex flex-wrap gap-4">
            {colors.map((hex) => (
              <div key={hex} className="flex flex-col items-center gap-2">
                <div
                  className="w-16 h-16 rounded-xl shadow-lg border border-white/10 cursor-pointer transition-transform hover:scale-105"
                  style={{ backgroundColor: hex }}
                  title={hex}
                  onClick={() => navigator.clipboard?.writeText(hex)}
                />
                <span className="text-xs text-gray-400 font-mono">{hex}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-3">Click a swatch to copy the hex code.</p>
        </Section>
      )}

      {/* Fonts */}
      {fonts.length > 0 && (
        <Section title={`Typography (${fonts.length})`}>
          <ul className="space-y-2">
            {fonts.map((font) => (
              <li key={font} className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-indigo-500 flex-shrink-0" />
                <span className="text-gray-300 font-medium">{font}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Logos */}
      {logos.length > 0 && (
        <Section title={`Logos & Icons (${logos.length})`}>
          <div className="flex flex-wrap gap-6 items-start">
            {logos.map((logoUrl) =>
              isImageUrl(logoUrl) ? (
                <div
                  key={logoUrl}
                  className="flex flex-col items-center gap-2 group"
                >
                  <div className="rounded-xl bg-white p-3 shadow border border-gray-200/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={logoUrl}
                      alt="Logo"
                      className="max-h-16 max-w-[120px] object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </div>
                  <a
                    href={logoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 max-w-[140px] truncate"
                    title={logoUrl}
                  >
                    {logoUrl.split('/').pop() || 'logo'}
                  </a>
                </div>
              ) : (
                <div key={logoUrl} className="flex flex-col items-center gap-2">
                  <div className="rounded-xl bg-gray-800 border border-gray-700 px-4 py-3 text-gray-400 text-sm">
                    Non-image asset
                  </div>
                  <a
                    href={logoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 max-w-[200px] truncate"
                    title={logoUrl}
                  >
                    {logoUrl}
                  </a>
                </div>
              )
            )}
          </div>
        </Section>
      )}

      {/* Empty state */}
      {!brandStory && !brandVoice && colors.length === 0 && fonts.length === 0 && logos.length === 0 && (
        <div className="rounded-2xl bg-gray-900 border border-gray-800 p-10 text-center text-gray-500">
          No brand data could be extracted from this URL.
        </div>
      )}
    </div>
  );
}
