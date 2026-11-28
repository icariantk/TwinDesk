// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/look-early.js: the control window is marked still (ui-look.css pauses its animations) while
// it isn't the one in front, and not while it is.
// Run with: node shared/test/look-still.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
    addEventListener: (ev, fn) => { doc[ev] = fn; },
    documentElement: { classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'look-early.js'), 'utf8'), ctx);

assert.ok(classes.has('glass'));
assert.ok(classes.has('still'), 'not in front yet: still');
focused = true;
win.focus();
assert.ok(!classes.has('still'), 'in front: it animates');
focused = false;
win.blur();
assert.ok(classes.has('still'), 'another window in front: still');
focused = true;
hidden = true;
doc.visibilitychange();
assert.ok(classes.has('still'), 'hidden: still');
hidden = false;
doc.visibilitychange();
assert.ok(!classes.has('still'));

const css = fs.readFileSync(path.join(__dirname, '..', 'ui-look.css'), 'utf8');
assert.ok(/:root\.still \*[^{]*\{ animation-play-state: paused !important; \}/.test(css), 'ui-look.css pauses them');
for (const page of ['windows/mesh/app.html', 'windows/app.html', 'linux/mesh/app.html', 'linux/app.html', 'mac/mesh/control.html', 'mac/control.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', page), 'utf8');
  assert.ok(html.includes('look-early.js') && html.includes('ui-look.css'), page + ' has both');
}
console.log('look-still: ok');
