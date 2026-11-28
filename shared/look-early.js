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

// While the window isn't the one in front (behind another, or hidden), the animations that never
// end wait where they are: a connected device's breathing dot alone repaints the whole window 60
// times a second for as long as it's open. Only those, and only ours: a header that rises in once
// still does, and what the page paused itself stays paused. They go on when the window is back.
(() => {
  const root = document.documentElement;
  const held = new Set(); // what this paused
  const endless = (a) => { try { return a.effect.getTiming().iterations === Infinity; } catch { return false; } };
  const hold = (a) => {
    if (!endless(a) || a.playState !== 'running') return;
    a.pause();
    held.add(a);
    if (held.size > 500) for (const x of held) if (!(x.effect && x.effect.target && x.effect.target.isConnected)) held.delete(x);
  };
  const still = () => {
    const now = document.hidden || !document.hasFocus();
    root.classList.toggle('still', now);
    if (!document.getAnimations) return;
    if (now) document.getAnimations().forEach(hold);
    else {
      for (const a of held) try { a.play(); } catch { /* gone */ }
      held.clear();
    }
  };
  // One that starts meanwhile (a list drawn again) waits too.
  addEventListener('animationstart', (e) => {
    if (root.classList.contains('still') && e.target && e.target.getAnimations) e.target.getAnimations().forEach(hold);
  }, true);
  addEventListener('focus', still);
  addEventListener('blur', still);
  document.addEventListener('visibilitychange', still);
  still();
})();
