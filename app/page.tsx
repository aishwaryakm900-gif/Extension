export default function HomePage() {
  return (
    <main className="min-h-screen bg-paper px-6 py-8 text-ink sm:px-12 sm:py-12">
      <div className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-5xl flex-col justify-between border-t border-line pt-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm font-semibold tracking-[0.18em]">
            <span className="text-lg">✦</span>
            <span>READER AI</span>
          </div>
          <span className="text-xs uppercase tracking-[0.2em] text-ink/45">Phase 01</span>
        </header>

        <section className="max-w-2xl py-24">
          <p className="mb-6 text-xs font-semibold uppercase tracking-[0.24em] text-ink/45">Read with more context</p>
          <h1 className="font-display text-5xl leading-[0.98] tracking-tight sm:text-7xl">
            Let every unfamiliar word open a door.
          </h1>
          <p className="mt-8 max-w-lg text-lg leading-8 text-ink/65">
            Reader AI notices what you select, gathers the sentence around it, and keeps your reading flow intact.
          </p>
          <div className="mt-12 inline-flex items-center gap-3 border border-line bg-white/60 px-4 py-3 text-sm shadow-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-600" />
            Extension MVP ready for local testing
          </div>
        </section>

        <footer className="flex flex-col gap-3 border-t border-line pt-5 text-xs uppercase tracking-[0.16em] text-ink/45 sm:flex-row sm:items-center sm:justify-between">
          <span>Select text anywhere. Stay in the story.</span>
          <span>Reader AI / 2026</span>
        </footer>
      </div>
    </main>
  );
}
