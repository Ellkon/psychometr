import { Link, Outlet } from '@tanstack/react-router';

/**
 * Application shell: header and navigation placeholders.
 * Screens are filled in stages 2–6 of docs/TZ.md.
 */
export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-semibold text-slate-900 no-underline">
            Клинический компас
          </Link>
          <nav className="flex gap-4 text-sm text-slate-600" aria-label="Основная навигация">
            {/* Screens arrive in stages 2–6: patients, scales, alerts, audit. */}
            <span>Скоро: реестр пациентов</span>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-3 text-xs text-slate-500">
          Решение по диагностике и лечению принимает врач. Система не назначает терапию.
        </div>
      </footer>
    </div>
  );
}
