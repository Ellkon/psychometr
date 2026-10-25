// Run synchronously before the router, React, service worker and asset requests.
// Invitation material stays in a closure, never URL state or browser storage.
(function () {
  let token;
  if (window.location.pathname.startsWith('/i/')) {
    const match = /^\/i\/([A-Za-z0-9_-]{43})$/.exec(window.location.pathname);
    token = match ? match[1] : undefined;
    window.history.replaceState(null, '', '/invite');
  }
  Object.defineProperty(window, 'takeCompassInvite', {
    value: function () {
      const value = token;
      token = undefined;
      return value;
    },
    writable: false,
    configurable: false,
  });
})();
