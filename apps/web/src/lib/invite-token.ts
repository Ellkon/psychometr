declare global {
  interface Window {
    takeCompassInvite?: () => string | undefined;
  }
}
// Consume exactly once at module initialization, not in a StrictMode component.
let token = window.takeCompassInvite?.();
export function getInviteToken(): string | undefined {
  return token;
}
export function clearInviteToken(): void {
  token = undefined;
}
