/* ===== app.js — SPA routing, screen switching, init ===== */

const App = (() => {
  let currentScreen = 'tracker';

  function init() {
    // Nav tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        switchScreen(tab.dataset.screen);
      });
    });

    // Hash-based routing
    window.addEventListener('hashchange', onHashChange);
    onHashChange();
  }

  function onHashChange() {
    const hash = location.hash.replace('#', '') || 'tracker';
    if (hash === 'tracker' || hash === 'viewer') {
      switchScreen(hash);
    }
  }

  function switchScreen(name) {
    if (name === currentScreen) return;
    currentScreen = name;

    // Update nav
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.screen === name);
    });

    // Update screens
    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.toggle('active', screen.id === 'screen-' + name);
    });

    // Update hash without triggering hashchange
    history.replaceState(null, '', '#' + name);

    // Notify modules
    if (name === 'tracker' && typeof Tracker !== 'undefined') {
      Tracker.onShow();
    }
    if (name === 'viewer' && typeof Viewer !== 'undefined') {
      Viewer.onShow();
    }
  }

  return { init, switchScreen };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.init();
  if (typeof Tracker !== 'undefined') Tracker.init();
  if (typeof Viewer !== 'undefined') Viewer.init();
});
