// 玩具恐龍插圖：圓滾滾的小恐龍，背上有骨板。全部用簡單形狀組成的 SVG，不需要圖片檔。
// 每張卡片會分到一種顏色；表情（mood）會依帳單狀態變化。

export const DINO_COLORS = Object.freeze({
  mint: { body: '#8FD3A8', dark: '#62B184', plate: '#F6C26B', belly: '#E9F7E6', soft: '#E3F5E9', deep: '#2B6A49' },
  sky: { body: '#9CC8F2', dark: '#6FA2D4', plate: '#F9B98C', belly: '#EDF5FD', soft: '#E3EFFB', deep: '#285A90' },
  peach: { body: '#F9B98C', dark: '#E2956A', plate: '#8FD3A8', belly: '#FEF0E6', soft: '#FDEBDD', deep: '#94461A' },
  butter: { body: '#F4D46E', dark: '#D7B14A', plate: '#F29A8E', belly: '#FDF7DE', soft: '#FCF2D0', deep: '#735300' },
  lavender: { body: '#C7B5EE', dark: '#A18FD6', plate: '#F6D776', belly: '#F4F0FC', soft: '#EFE9FB', deep: '#56419A' },
  pink: { body: '#F4A9B8', dark: '#DA8598', plate: '#9CC8F2', belly: '#FDEFF2', soft: '#FCE8ED', deep: '#94324E' },
  coral: { body: '#F5978E', dark: '#D9746B', plate: '#F6D776', belly: '#FDEAE7', soft: '#FDE4E1', deep: '#A2332A' },
});

/** 卡片可用的顏色（coral 保留給逾期警示）。 */
export const CARD_COLORS = Object.freeze(['mint', 'sky', 'peach', 'butter', 'lavender', 'pink']);

/** 依卡片 ID 固定分配顏色，刪除其他卡片時也不會變。 */
export function cardColorName(card) {
  const n = Math.max(1, Math.trunc(Number(card?.id) || 1));
  return CARD_COLORS[(n - 1) % CARD_COLORS.length];
}

/** 給 style 屬性用的 CSS 變數，例如 `--c:#8FD3A8;--c-soft:...`。 */
export function cardStyle(card) {
  const c = DINO_COLORS[cardColorName(card)];
  return `--c:${c.body};--c-dark:${c.dark};--c-soft:${c.soft};--c-deep:${c.deep};--c-plate:${c.plate}`;
}

const INK = '#3B352E';

function eyes(mood) {
  switch (mood) {
    case 'happy':
      // 瞇瞇眼 ^ ^
      return `<path d="M80.5 40.5 Q86 34 91.5 40.5" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>`;
    case 'alarmed':
      return `<circle cx="86" cy="38.5" r="6.6" fill="#fff" stroke="${INK}" stroke-width="1.6"/>
        <circle cx="87" cy="38.5" r="3.4" fill="${INK}"/>
        <circle cx="88.2" cy="37.2" r="1.1" fill="#fff"/>`;
    case 'worried':
      return `<path d="M80 30.5 L90 28" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="86" cy="38.5" r="4.6" fill="${INK}"/>
        <circle cx="87.6" cy="36.8" r="1.6" fill="#fff"/>`;
    default:
      return `<circle cx="86" cy="38.5" r="4.8" fill="${INK}"/>
        <circle cx="87.7" cy="36.7" r="1.7" fill="#fff"/>`;
  }
}

function mouth(mood) {
  switch (mood) {
    case 'happy':
      return `<path d="M95 57.5 Q101 63.5 107 56.5" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>`;
    case 'alarmed':
      return `<ellipse cx="101" cy="59" rx="3.6" ry="4.4" fill="${INK}"/>`;
    case 'worried':
      return `<path d="M95.5 60 Q98.5 57 101.5 60 Q104.5 63 107 59.5" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
    default:
      return `<path d="M96 58 Q101 61.5 106 57.5" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
  }
}

/** 一片圓頭骨板，以 (x, y) 為底部中心，朝 angle 度方向長出。 */
function plate(x, y, size, angle, color) {
  const w = size * 0.62;
  return `<path transform="rotate(${angle} ${x} ${y})" d="M${x - w} ${y + 3} Q${x - w * 0.55} ${y - size * 0.75} ${x} ${y - size} Q${x + w * 0.55} ${y - size * 0.75} ${x + w} ${y + 3} Z" fill="${color}"/>`;
}

/**
 * 產生恐龍 SVG 字串。
 * @param {object} opts
 * @param {string} [opts.color] DINO_COLORS 的名稱
 * @param {'happy'|'calm'|'worried'|'alarmed'} [opts.mood]
 * @param {boolean} [opts.holding] 是否抱著一張信用卡（首頁插圖用）
 * @param {boolean} [opts.shadow] 是否畫地面陰影
 * @param {boolean} [opts.head] 只顯示頭部（小頭像用）
 * @param {string} [opts.className]
 */
export function dinoSvg({
  color = 'mint',
  mood = 'calm',
  holding = false,
  shadow = true,
  head = false,
  className = 'dino',
} = {}) {
  const c = DINO_COLORS[color] ?? DINO_COLORS.mint;
  const card = holding
    ? `<g transform="rotate(-10 86 82)">
        <rect x="70" y="70" width="34" height="23" rx="4.5" fill="#FFFFFF" stroke="${INK}" stroke-opacity="0.15" stroke-width="1.2"/>
        <rect x="70" y="75" width="34" height="5" fill="#9CC8F2"/>
        <rect x="74" y="84" width="11" height="4" rx="2" fill="#F6C26B"/>
      </g>`
    : '';
  const arm = holding
    ? `<ellipse cx="74" cy="80" rx="6.5" ry="4.5" transform="rotate(-25 74 80)" fill="${c.dark}"/>
       <ellipse cx="95" cy="81" rx="5.5" ry="4" transform="rotate(20 95 81)" fill="${c.dark}"/>`
    : `<rect x="74" y="72" width="13" height="7" rx="3.5" transform="rotate(28 80 75)" fill="${c.dark}"/>`;
  const sweat =
    mood === 'worried' || mood === 'alarmed'
      ? `<path d="M110 22 Q113.5 28.5 110 31 Q106.5 28.5 110 22 Z" fill="#7FB8EE"/>`
      : '';
  const viewBox = head ? '44 8 72 72' : '0 0 120 112';
  return `<svg class="${className}" viewBox="${viewBox}" aria-hidden="true" focusable="false">
    ${shadow && !head ? `<ellipse cx="58" cy="106" rx="34" ry="4.5" fill="${INK}" opacity="0.08"/>` : ''}
    ${plate(25, 70, 12, -62, c.plate)}
    ${plate(33, 58, 15, -46, c.plate)}
    ${plate(46, 49, 17, -30, c.plate)}
    ${plate(61, 26, 14, -18, c.plate)}
    <path d="M32 80 C18 84 8 79 3 68 C13 72 22 71 33 66 Z" fill="${c.body}"/>
    <rect x="36" y="86" width="15" height="19" rx="7" fill="${c.dark}"/>
    <rect x="60" y="88" width="14" height="17" rx="7" fill="${c.dark}"/>
    <ellipse cx="55" cy="77" rx="30" ry="23" fill="${c.body}"/>
    <ellipse cx="63" cy="83" rx="17" ry="14" fill="${c.belly}"/>
    <circle cx="43" cy="68" r="3.2" fill="${c.dark}" opacity="0.45"/>
    <circle cx="36" cy="77" r="2.3" fill="${c.dark}" opacity="0.45"/>
    <ellipse cx="78" cy="41" rx="26" ry="23" fill="${c.body}"/>
    <ellipse cx="95" cy="49" rx="16" ry="12.5" fill="${c.body}"/>
    <ellipse cx="68" cy="28" rx="9" ry="4.6" transform="rotate(-28 68 28)" fill="#fff" opacity="0.5"/>
    <ellipse cx="42" cy="64" rx="6" ry="2.8" transform="rotate(-25 42 64)" fill="#fff" opacity="0.35"/>
    <circle cx="106.5" cy="45" r="1.5" fill="${INK}" opacity="0.4"/>
    <ellipse cx="94" cy="52" rx="5.4" ry="3.4" fill="#FF7F98" opacity="0.62"/>
    ${eyes(mood)}
    ${mouth(mood)}
    ${sweat}
    ${card}
    ${arm}
  </svg>`;
}

/** 三趾恐龍腳印（裝飾用）。 */
export function footprintSvg(className = 'footprint') {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <ellipse cx="12" cy="17.6" rx="4.4" ry="4.2"/>
    <ellipse cx="12" cy="8.6" rx="2.3" ry="6.4"/>
    <ellipse cx="6.6" cy="11.6" rx="2.1" ry="5.8" transform="rotate(-40 6.6 11.6)"/>
    <ellipse cx="17.4" cy="11.6" rx="2.1" ry="5.8" transform="rotate(40 17.4 11.6)"/>
  </svg>`;
}

/** 依帳單狀態挑表情。 */
export function moodForTone(tone) {
  if (tone === 'danger') return 'alarmed';
  if (tone === 'warn') return 'worried';
  if (tone === 'ok' || tone === 'muted') return 'happy';
  return 'calm';
}
