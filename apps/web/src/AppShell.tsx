import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Button, ErrorNotice } from './components/forms.js';
import { useSession } from './lib/session.js';
import { AlertsCenter } from './components/alerts-center.js';
import { SecuritySignals } from './components/security-signals.js';

export function AppShell() {
  const { user, logout, privacyError } = useSession(),
    navigate = useNavigate();
  const role =
    user?.role === 'doctor' ? 'Врач' : user?.role === 'admin' ? 'Администратор' : 'Пациент';
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <Link
            to="/"
            className="flex items-center gap-3 font-semibold tracking-tight text-slate-900"
          >
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-800 text-xl text-white"
            >
              ＋
            </span>
            Клинический компас
          </Link>
          <nav
            className="flex flex-wrap items-center gap-4 text-sm"
            aria-label="Основная навигация"
          >
            {user?.role === 'doctor' && (
              <Link to="/" className="text-teal-900">
                Пациенты
              </Link>
            )}
            {user?.role === 'admin' && (
              <>
                <Link to="/admin" className="text-teal-900">
                  Врачи и привязки
                </Link>
                <Link to="/audit" className="text-teal-900">
                  Аудит
                </Link>
              </>
            )}
            {user ? (
              <>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                  {role}
                </span>
                <Button
                  onClick={() => {
                    void logout().then(() => navigate({ to: '/' }));
                  }}
                >
                  Выйти
                </Button>
              </>
            ) : (
              <Link to="/login" className="font-medium text-teal-800">
                Вход специалиста
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main key={user?.id ?? 'anonymous'} className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <ErrorNotice message={privacyError} />
        {user?.role === 'doctor' && <AlertsCenter />}
        {user?.role === 'admin' && <SecuritySignals />}
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 text-xs leading-relaxed text-slate-500">
          <p>
            Решение по диагностике и лечению принимает врач.
            <br />
            Система не назначает терапию автоматически.
          </p>
        </div>
      </footer>
    </div>
  );
}
