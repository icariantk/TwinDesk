// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// In the control window's <head>, before it paints: Glass or Simple (General › Appearance › Style)
// from the window's ?look= query (the main process passes settings.ui.style), so the first frame is
// already the right one. Glass unless it says simple; UI.look keeps it in step afterwards.
'use strict';
try {
  const s = new URLSearchParams(location.search).get('look');
  document.documentElement.classList.toggle('glass', s !== 'simple');
} catch {
  document.documentElement.classList.add('glass');
}

// While the window isn't the one in front (behind another, or hidden), what animates on its own
// stands still (ui-look.css .still): a connected device's breathing dot alone repaints the whole
// window 60 times a second for as long as it's open. It goes on from there when the window is back.
(() => {
  const still = () => document.documentElement.classList.toggle('still', document.hidden || !document.hasFocus());
  addEventListener('focus', still);
  addEventListener('blur', still);
  document.addEventListener('visibilitychange', still);
  still();
})();
