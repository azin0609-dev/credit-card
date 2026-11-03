import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CARD_COLORS, DINO_COLORS, cardColorName, cardStyle, dinoSvg, footprintSvg, moodForTone } from '../../web/dino.js';

describe('恐龍插圖', () => {
  test('卡片顏色依 ID 固定分配並循環', () => {
    assert.equal(cardColorName({ id: 1 }), 'mint');
    assert.equal(cardColorName({ id: 2 }), 'sky');
    assert.equal(cardColorName({ id: 7 }), 'mint');
    assert.equal(cardColorName({}), 'mint');
    for (const name of CARD_COLORS) assert.ok(DINO_COLORS[name], name);
  });

  test('cardStyle 只輸出色碼', () => {
    assert.match(cardStyle({ id: 3 }), /^--c:#[0-9A-F]{6};--c-dark:#[0-9A-F]{6};--c-soft:#[0-9A-F]{6};--c-deep:#[0-9A-F]{6};--c-plate:#[0-9A-F]{6}$/i);
  });

  test('不同表情產生不同圖', () => {
    const svgs = ['happy', 'calm', 'worried', 'alarmed'].map((mood) => dinoSvg({ mood }));
    assert.equal(new Set(svgs).size, 4);
    for (const svg of svgs) {
      assert.ok(svg.startsWith('<svg'));
      assert.ok(!svg.includes('undefined'));
      assert.match(svg, /aria-hidden="true"/);
    }
  });

  test('頭像只顯示頭部、未知顏色退回薄荷綠', () => {
    assert.match(dinoSvg({ head: true }), /viewBox="44 8 72 72"/);
    assert.equal(dinoSvg({ color: 'nope' }), dinoSvg({ color: 'mint' }));
    assert.ok(dinoSvg({ holding: true }).includes('rect'));
  });

  test('狀態對應表情', () => {
    assert.equal(moodForTone('danger'), 'alarmed');
    assert.equal(moodForTone('warn'), 'worried');
    assert.equal(moodForTone('ok'), 'happy');
    assert.equal(moodForTone('info'), 'calm');
  });

  test('腳印', () => {
    assert.match(footprintSvg(), /<ellipse/);
  });
});
