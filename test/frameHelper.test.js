const test = require('node:test');
const assert = require('node:assert/strict');
const FrameHelper = require('../util/frameHelper');

function mockFrame(evaluateImpl, selectorImpl) {
    return {
        evaluate: async (fn, ...args) => evaluateImpl(fn, ...args),
        $: async (sel) => (selectorImpl ? selectorImpl(sel) : null)
    };
}
function mockPage(frames) { return { frames: () => frames }; }

test('findFrameWithSelector finds the first frame matching', async () => {
    const f1 = mockFrame(null, () => null);
    const f2 = mockFrame(null, (sel) => ({ sel }));
    const page = mockPage([f1, f2]);
    const frame = await FrameHelper.findFrameWithSelector(page, '.x');
    assert.equal(frame, f2);
});

test('hasSelector reflects frame scan', async () => {
    const page = mockPage([mockFrame(null, () => ({}))]);
    assert.equal(await FrameHelper.hasSelector(page, '.x'), true);
    assert.equal(await FrameHelper.hasSelector(mockPage([mockFrame(null, () => null)]), '.x'), false);
});

test('findMultiplierStrip returns frame + discovered path', async () => {
    const stripFrame = mockFrame(() => 'div:nth-of-type(2) > ul:nth-of-type(1)');
    const page = mockPage([mockFrame(() => null), stripFrame]);
    const found = await FrameHelper.findMultiplierStrip(page);
    assert.equal(found.frame, stripFrame);
    assert.ok(found.path.includes('nth-of-type'));
});

test('findMultiplierStrip survives frame errors', async () => {
    const bad = { evaluate: async () => { throw new Error('detached'); } };
    const good = mockFrame(() => 'div');
    const found = await FrameHelper.findMultiplierStrip(mockPage([bad, good]));
    assert.equal(found.frame, good);
});

test('findGameMarker prefers the classic selector, falls back to content scan', async () => {
    const classic = mockFrame(null, () => ({}));
    const page = mockPage([classic]);
    const hit = await FrameHelper.findGameMarker(page, '.bubble');
    assert.equal(hit.frame, classic);
    assert.equal(hit.stripPath, null);

    const stripOnly = mockFrame(() => 'div > ul');
    const page2 = mockPage([mockFrame(null, () => null), stripOnly]);
    const hit2 = await FrameHelper.findGameMarker(page2, '.bubble');
    assert.equal(hit2.frame, stripOnly);
    assert.equal(hit2.stripPath, 'div > ul');

    const empty = mockPage([mockFrame(null, () => null), mockFrame(() => null)]);
    assert.equal(await FrameHelper.findGameMarker(empty, '.bubble'), null);
});
