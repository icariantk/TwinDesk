// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/look-early.js: while the control window isn't the one in front, its endless animations
// wait (a breathing dot repaints the window 60 times a second); one-time ones and what the page
// paused itself are left alone, and what it paused goes on when the window is back. And the kits'
// hints and notes leave the same text alone (a new text node repaints too).
// Run with: node shared/test/look-still.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const anim = (name, iterations, playState = 'running') => ({
  name, playState, effect: { getTiming: () => ({ iterations }), target: { isConnected: true } },
  pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; },
});
const breathe = anim('breathe', Infinity);
const rise = anim('rise', 1);
const wiggleHovered = anim('wiggle', Infinity, 'paused'); // the page's own pause (CSS :hover)
let all = [breathe, rise, wiggleHovered];

const classes = new Set();
const win = {}, doc = {};
let focused = false;
let hidden = false;
const ctx = {
  location: { search: '?look=glass' },
  URLSearchParams,
  addEventListener: (ev, fn) => { win[ev] = fn; },
  document: {
    get hidden() { return hidden; },
    hasFocus: () => focused,
    getAnimations: () => all,
    addEventListener: (ev, fn) => { doc[ev] = fn; },
    documentElement: { classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) } },
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'look-early.js'), 'utf8'), ctx);

assert.ok(classes.has('glass'));
assert.ok(classes.has('still'), 'not in front yet: still');
assert.strictEqual(breathe.playState, 'paused', 'an endless animation waits');
assert.strictEqual(rise.playState, 'running', 'a one-time one plays on');

// A list drawn again meanwhile: its new dot waits too.
const fresh = anim('breathe', Infinity);
all = [...all, fresh];
win.animationstart({ target: { getAnimations: () => [fresh] } });
assert.strictEqual(fresh.playState, 'paused');

focused = true;
win.focus();
assert.ok(!classes.has('still'), 'in front: it animates');
assert.strictEqual(breathe.playState, 'running');
assert.strictEqual(fresh.playState, 'running');
assert.strictEqual(wiggleHovered.playState, 'paused', 'what the page paused itself stays paused');

win.animationstart({ target: { getAnimations: () => [fresh] } });
assert.strictEqual(fresh.playState, 'running', 'in front: nothing waits');

focused = false;
win.blur();
assert.ok(classes.has('still'));
assert.strictEqual(breathe.playState, 'paused', 'another window in front: waits');
focused = true;
hidden = true;
doc.visibilitychange();
assert.ok(classes.has('still'), 'hidden: still');
hidden = false;
doc.visibilitychange();
assert.ok(!classes.has('still'));
assert.strictEqual(breathe.playState, 'running');

for (const page of ['windows/mesh/app.html', 'windows/app.html', 'linux/mesh/app.html', 'linux/app.html', 'mac/mesh/control.html', 'mac/control.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', page), 'utf8');
  assert.ok(html.includes('look-early.js'), page + ' loads look-early.js');
}

// The kits: a hint or note set to the text it has doesn't touch the DOM.
for (const kit of ['windows/ui-kit.js', 'linux/ui-kit.js', 'mac/control.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', kit), 'utf8');
  assert.ok(/if \(hintEl\.textContent !== text\) hintEl\.textContent = text;/.test(src), kit + ': setHint leaves the same text');
  assert.ok(/if \(n\.textContent !== v\) n\.textContent = v;/.test(src), kit + ': note.set leaves the same text');
}
console.log('look-still: ok');
