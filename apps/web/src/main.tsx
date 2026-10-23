import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './lib/invite-token.js';
import { AppShell } from './AppShell.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { InvitePage } from './pages/InvitePage.js';
import { PatientPage } from './pages/PatientPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { ScaleFormPage } from './pages/ScaleFormPage.js';
import { queryClient, SessionProvider } from './lib/session.js';
import './styles.css';
import { z } from 'zod';

// CSP forbids eval; skip zod's `new Function` JIT probe so the browser never
// reports a script-src violation.
z.config({ jitless: true });

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <p>Страница не найдена.</p>,
});
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});
const patientLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/patient-login',
  component: () => <LoginPage patient />,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite',
  component: InvitePage,
});
const patientRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/patients/$patientId',
  component: PatientPage,
});
const scaleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/patients/$patientId/scales/$scaleId',
  component: ScaleFormPage,
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminPage,
});
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    loginRoute,
    patientLoginRoute,
    inviteRoute,
    patientRoute,
    scaleRoute,
    adminRoute,
    auditRoute,
  ]),
  defaultPreload: false,
  defaultErrorComponent: () => (
    <p role="alert">Не удалось открыть страницу. Вернитесь на главный экран.</p>
  ),
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
