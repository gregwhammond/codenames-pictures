'use strict';
// Touch behaviour that differs between engines.

const { test, expect } = require('../lib/table');
const { knownBug } = require('../lib/known-bug');

// PROBABLE BUG, not confirmed on a real iPhone.
//
// In Playwright's WebKit with touch input, a tap on the dimmed backdrop beside
// the menu sheet or the zoom sheet does not close it. The page gets
// pointerdown, touchstart, pointerup and touchend on the backdrop, but no
// mousedown, mouseup or click. The app closes sheets from one click listener
// on `document` (web/app.js:832, `[data-close]` / `[data-close-menu]`), and
// the backdrops are plain <div>s (web/style.css:318).
//
// Measured in this engine (WebKit 26.0, build 2215): the tap does produce a
// click, and closes the sheet, as soon as the backdrop itself or an ancestor
// below <body> (#app) has a click listener of its own, or the backdrop has an
// `onclick` attribute. A listener on `document` alone is not enough. That is
// the rule iOS Safari is documented to follow for elements that are not
// links, buttons or form controls, which is why this is listed as probable.
// On a real iPhone `cursor: pointer` is also said to help; in this engine it
// does not, so the two are not identical. Chromium sends the click either way,
// and so does a mouse click in WebKit.
//
// If it is real, it matters most for the menu: it has no Close button and its
// sheet covers the ☰ button, so on an iPhone it could only be left by picking
// one of its actions or reloading the page. The zoom sheet has a Close button.
//
// The harness steps around it with table.known.backdropTap (closeMenu()
// presses Escape on WebKit) so that other tests can run.
const BACKDROP = {
  id: 'backdrop-tap-webkit',
  title: 'WebKit with touch input: a tap on the dimmed backdrop beside the menu sheet or the zoom sheet sends no click, so the sheet stays open (probable on iOS Safari, not confirmed on a device)',
  where: 'web/app.js:832-854 (one click listener on document closes sheets) and web/style.css:318 (.sheet-backdrop, .zoom-backdrop are plain divs)',
  shows: /sheet is still open after a tap on (the|its) backdrop/,
};

test.describe('Touch taps on backdrops', () => {
  test('a tap beside the menu sheet closes it', async ({ table, browserName }) => {
    const [ada, ben] = await table.setupRoom();
    for (const p of [ada, ben]) {
      await p.openMenu();
      await table.check(`with ${p.name}'s menu open`);
    }
    await knownBug(table, BACKDROP, async () => {
      for (const p of [ada, ben]) {
        await p.closeMenu({ how: 'backdrop' });
        await table.check(`after ${p.name} taps beside the menu`);
      }
    }, { when: browserName === 'webkit' && table.input === 'tap' });
  });

  test('a tap beside the zoom sheet closes it', async ({ table, browserName }) => {
    const [ada, ben] = await table.setupRoom();
    for (const p of [ada, ben]) {
      await p.openCard(7);
      await table.check(`with ${p.name}'s zoom sheet open`);
    }
    await knownBug(table, BACKDROP, async () => {
      for (const p of [ada, ben]) {
        await p.closeCard({ how: 'backdrop' });
        await table.check(`after ${p.name} taps beside the zoom sheet`);
      }
    }, { when: browserName === 'webkit' && table.input === 'tap' });
  });

  test('a mouse click beside either sheet closes it on every engine', async ({ table }) => {
    const [ada] = await table.setupRoom();
    table.input = 'click';
    await ada.openMenu();
    await ada.closeMenu({ how: 'backdrop' });
    await ada.openCard(7);
    await ada.closeCard({ how: 'backdrop' });
    await table.check('after closing both sheets with the mouse');
  });

  test('the zoom sheet closes with its Close button, and both sheets close with Escape', async ({ table }) => {
    const [ada] = await table.setupRoom();
    await ada.openCard(7);
    await ada.closeCard();
    await ada.openMenu();
    await ada.closeMenu({ how: 'escape' });
    await ada.openCard(3);
    await ada.page.keyboard.press('Escape');
    await expect(ada.page.locator('.zoom')).toHaveCount(0);
    // closeMenu() with no argument works on every project (see table.known.backdropTap).
    await ada.openMenu();
    await ada.closeMenu();
    await table.check('after opening and closing both sheets');
  });
});
