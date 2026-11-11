// Design tokens from the browser game's style.css (:root)
export const C = {
  bg: '#0f1722',
  bgDeep: '#0b111a',
  panel: '#172233',
  text: '#eef3f8',
  muted: '#9fb0c3',
  you: '#3aa0ff',
  cpu: '#ff5d5d',
  accent: '#d7f23b',
  overlay: 'rgba(8,12,20,0.72)',
  border: 'rgba(255,255,255,0.08)',
  input: '#0d1520',
};

/** Phones held sideways use the compact, two-column menus (CSS: landscape and max-height 560px). */
export const isShort = (h: number) => h <= 560;
