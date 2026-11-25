import { useEffect, useState } from 'react';
import { Check, KeyRound, Plus } from 'lucide-react';

export type AppView = 'workspace' | 'tools' | 'library' | 'architecture';

interface TopBarProps {
  activeView: AppView;
  onNavigate: (view: AppView) => void;
  onNewTranscription: () => void;
}

export function TopBar({ activeView, onNavigate, onNewTranscription }: TopBarProps) {
  // App-wide AI provider pill: tells the user at a glance which engine is
  // active (Groq Free or Gemini) on every tab — Workspace, Media Tools, etc.
  const [provider, setProvider] = useState<{ provider?: string; groqConfigured?: boolean; hasApiKey?: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setProvider({
            provider: data.provider,
            groqConfigured: Boolean(data.groqConfigured),
            hasApiKey: Boolean(data.hasApiKey),
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const navItems: Array<{ id: AppView; label: string }> = [
    { id: 'workspace', label: 'Workspace' },
    { id: 'tools', label: 'Media Tools' },
    { id: 'library', label: 'Library' },
    { id: 'architecture', label: 'Pipeline' },
  ];

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-[#E2E8F0]">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4 sm:gap-8">
        <button
          type="button"
          onClick={() => onNavigate('workspace')}
          className="inline-flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-[#0F172A] whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded-md"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <rect width="28" height="28" rx="7" fill="#0F172A" />
            <rect x="6.5" y="10.5" width="2.5" height="7" rx="1.25" fill="#93C5FD" />
            <rect x="11" y="6.5" width="2.5" height="15" rx="1.25" fill="#2563EB" />
            <rect x="15.5" y="8.5" width="2.5" height="11" rx="1.25" fill="#60A5FA" />
            <rect x="20" y="11" width="2.5" height="6" rx="1.25" fill="#FFFFFF" />
          </svg>
          <span>Hanzx Studio</span>
        </button>

        <nav className="hidden md:flex items-center gap-7" aria-label="Primary navigation">
          {navItems.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`relative py-1 text-sm font-medium transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded-sm ${
                  isActive ? 'text-[#0F172A]' : 'text-[#64748B] hover:text-[#0F172A]'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 right-0 -bottom-[21px] h-[2px] bg-[#2563EB]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {provider !== null && (
            <span
              title={
                provider.provider === 'groq' && provider.groqConfigured
                  ? 'Groq Free active — transcription + clips free mein chalenge'
                  : provider.provider === 'gemini' && provider.hasApiKey
                    ? 'Gemini active'
                    : 'Koi AI key nahi — Media Tools > Auto Clips > Add API Key se Groq free key lagao'
              }
              className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${
                provider.provider === 'groq' && provider.groqConfigured
                  ? 'bg-[#DCFCE7] text-[#15803D]'
                  : provider.provider === 'gemini' && provider.hasApiKey
                    ? 'bg-[#DCFCE7] text-[#15803D]'
                    : 'bg-[#FEF2F2] text-[#B91C1C]'
              }`}
            >
              {provider.provider === 'groq' && provider.groqConfigured ? (
                <>
                  <Check className="w-3 h-3" aria-hidden="true" />
                  <span>Groq Free</span>
                </>
              ) : provider.provider === 'gemini' && provider.hasApiKey ? (
                <>
                  <Check className="w-3 h-3" aria-hidden="true" />
                  <span>Gemini</span>
                </>
              ) : (
                <>
                  <KeyRound className="w-3 h-3" aria-hidden="true" />
                  <span>No AI key</span>
                </>
              )}
            </span>
          )}
          <button
            type="button"
            onClick={onNewTranscription}
            className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
          >
            <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">New Transcription</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </div>

      {/* Compact mobile nav row */}
      <nav
        aria-label="Mobile primary navigation"
        className="md:hidden flex items-center justify-between gap-2 px-4 border-t border-[#F1F5F9] overflow-x-auto"
      >
        {navItems.map((item) => {
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`relative text-xs font-medium whitespace-nowrap shrink-0 min-h-[42px] px-2 flex items-center cursor-pointer transition-colors ${
                isActive ? 'text-[#2563EB] font-semibold' : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              {item.label}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute left-1 right-1 bottom-0 h-[2px] bg-[#2563EB]"
                />
              )}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
