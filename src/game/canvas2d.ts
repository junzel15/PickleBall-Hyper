/**
 * A small HTML Canvas 2D–compatible drawing context on top of Skia.
 *
 * The browser game draws everything with the Canvas 2D API. Implementing the
 * subset it uses on top of Skia lets the rendering code be ported line by line,
 * so the court, players, referees, paddles and portraits look exactly the same.
 *
 * Supported: save/restore, translate/rotate/scale, paths (moveTo, lineTo,
 * quadraticCurveTo, bezierCurveTo, arc, arcTo, ellipse, rect, closePath),
 * fill/stroke/clip, fillRect/strokeRect/clearRect, fillText/strokeText/measureText,
 * linear + radial gradients, globalAlpha, line caps/joins, line dashes, shadows,
 * and drawing recorded pictures (used like canvas images).
 */
import {
  BlendMode,
  ClipOp,
  matchFont,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  TileMode,
} from '@shopify/react-native-skia';
import type {
  SkCanvas,
  SkColor,
  SkFont,
  SkPaint,
  SkPathBuilder,
  SkPicture,
  SkShader,
} from '@shopify/react-native-skia';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

// ---------- colours ----------
const colorCache = new Map<string, SkColor>();
function toColor(css: string): SkColor {
  let c = colorCache.get(css);
  if (!c) {
    c = Skia.Color(css);
    if (colorCache.size > 4000) colorCache.clear();
    colorCache.set(css, c);
  }
  return c;
}

// ---------- gradients ----------
export class CanvasGradient {
  private stops: { offset: number; color: string }[] = [];
  private shader: SkShader | null = null;
  constructor(
    private readonly kind: 'linear' | 'radial',
    private readonly args: number[],
  ) {}

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
    this.shader = null;
  }

  toShader(): SkShader {
    if (this.shader) return this.shader;
    const stops = this.stops.length ? this.stops : [{ offset: 0, color: 'rgba(0,0,0,0)' }];
    const sorted = stops.slice().sort((a, b) => a.offset - b.offset);
    // Skia needs at least two colours
    if (sorted.length === 1) sorted.push({ offset: 1, color: sorted[0].color });
    const colors = sorted.map(s => toColor(s.color));
    const pos = sorted.map(s => Math.max(0, Math.min(1, s.offset)));
    const a = this.args;
    this.shader =
      this.kind === 'linear'
        ? Skia.Shader.MakeLinearGradient({ x: a[0], y: a[1] }, { x: a[2], y: a[3] }, colors, pos, TileMode.Clamp)
        : Skia.Shader.MakeTwoPointConicalGradient(
            { x: a[0], y: a[1] }, Math.max(0, a[2]),
            { x: a[3], y: a[4] }, Math.max(0.0001, a[5]),
            colors, pos, TileMode.Clamp,
          );
    return this.shader;
  }
}

export type FillStyle = string | CanvasGradient;

// ---------- fonts ----------
// Canvas font strings look like "900 14px system-ui, sans-serif"
const fontCache = new Map<string, SkFont>();
function parseFont(spec: string): SkFont {
  let f = fontCache.get(spec);
  if (f) return f;
  const m = /(?:(\d{3}|bold|normal)\s+)?([\d.]+)px/.exec(spec);
  const weightRaw = m && m[1] ? m[1] : '400';
  const weight = (weightRaw === 'bold' ? '700' : weightRaw === 'normal' ? '400' : weightRaw) as
    '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
  const size = m ? Math.max(1, parseFloat(m[2])) : 10;
  f = matchFont({ fontFamily: 'sans-serif', fontSize: size, fontWeight: weight, fontStyle: 'normal' });
  if (fontCache.size > 400) fontCache.clear();
  fontCache.set(spec, f);
  return f;
}

type LineCap = 'butt' | 'round' | 'square';
type LineJoin = 'miter' | 'round' | 'bevel';
type TextAlign = 'left' | 'right' | 'center' | 'start' | 'end';
type TextBaseline = 'alphabetic' | 'top' | 'middle' | 'bottom' | 'hanging' | 'ideographic';

interface State {
  fillStyle: FillStyle;
  strokeStyle: FillStyle;
  lineWidth: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  globalAlpha: number;
  font: string;
  textAlign: TextAlign;
  textBaseline: TextBaseline;
  lineDash: number[];
  lineDashOffset: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

const defaultState = (): State => ({
  fillStyle: '#000',
  strokeStyle: '#000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  globalAlpha: 1,
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  lineDash: [],
  lineDashOffset: 0,
  shadowColor: 'rgba(0,0,0,0)',
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
});

const CAPS: Record<LineCap, StrokeCap> = { butt: StrokeCap.Butt, round: StrokeCap.Round, square: StrokeCap.Square };
const JOINS: Record<LineJoin, StrokeJoin> = { miter: StrokeJoin.Miter, round: StrokeJoin.Round, bevel: StrokeJoin.Bevel };

/** A recorded drawing that can be placed like a canvas image. */
export interface Sprite {
  picture: SkPicture;
  /** Logical size in pixels. */
  w: number;
  h: number;
}

export class Ctx2D {
  private s: State = defaultState();
  private stack: State[] = [];
  private builder: SkPathBuilder = Skia.PathBuilder.Make();
  private hasPoint = false;
  private startX = 0;
  private startY = 0;
  private curX = 0;
  private curY = 0;
  private readonly fillPaint: SkPaint;
  private readonly strokePaint: SkPaint;

  constructor(public canvas: SkCanvas) {
    this.fillPaint = Skia.Paint();
    this.fillPaint.setAntiAlias(true);
    this.fillPaint.setStyle(PaintStyle.Fill);
    this.strokePaint = Skia.Paint();
    this.strokePaint.setAntiAlias(true);
    this.strokePaint.setStyle(PaintStyle.Stroke);
  }

  /** Point this context at a new canvas (one per recorded frame). */
  reset(canvas: SkCanvas): void {
    this.canvas = canvas;
    this.s = defaultState();
    this.stack = [];
    this.beginPath();
  }

  // ---------- state ----------
  get fillStyle(): FillStyle { return this.s.fillStyle; }
  set fillStyle(v: FillStyle) { this.s.fillStyle = v; }
  get strokeStyle(): FillStyle { return this.s.strokeStyle; }
  set strokeStyle(v: FillStyle) { this.s.strokeStyle = v; }
  get lineWidth(): number { return this.s.lineWidth; }
  set lineWidth(v: number) { if (v > 0 && Number.isFinite(v)) this.s.lineWidth = v; }
  get lineCap(): LineCap { return this.s.lineCap; }
  set lineCap(v: LineCap) { this.s.lineCap = v; }
  get lineJoin(): LineJoin { return this.s.lineJoin; }
  set lineJoin(v: LineJoin) { this.s.lineJoin = v; }
  get globalAlpha(): number { return this.s.globalAlpha; }
  set globalAlpha(v: number) { if (Number.isFinite(v)) this.s.globalAlpha = Math.max(0, Math.min(1, v)); }
  get font(): string { return this.s.font; }
  set font(v: string) { this.s.font = v; }
  get textAlign(): TextAlign { return this.s.textAlign; }
  set textAlign(v: TextAlign) { this.s.textAlign = v; }
  get textBaseline(): TextBaseline { return this.s.textBaseline; }
  set textBaseline(v: TextBaseline) { this.s.textBaseline = v; }
  get lineDashOffset(): number { return this.s.lineDashOffset; }
  set lineDashOffset(v: number) { this.s.lineDashOffset = v; }
  get shadowColor(): string { return this.s.shadowColor; }
  set shadowColor(v: string) { this.s.shadowColor = v; }
  get shadowBlur(): number { return this.s.shadowBlur; }
  set shadowBlur(v: number) { this.s.shadowBlur = v; }
  get shadowOffsetX(): number { return this.s.shadowOffsetX; }
  set shadowOffsetX(v: number) { this.s.shadowOffsetX = v; }
  get shadowOffsetY(): number { return this.s.shadowOffsetY; }
  set shadowOffsetY(v: number) { this.s.shadowOffsetY = v; }
  setLineDash(d: number[]): void { this.s.lineDash = d.slice(); }

  save(): void {
    this.stack.push({ ...this.s, lineDash: this.s.lineDash.slice() });
    this.canvas.save();
  }
  restore(): void {
    const prev = this.stack.pop();
    if (!prev) return;
    this.s = prev;
    this.canvas.restore();
  }
  translate(x: number, y: number): void { this.canvas.translate(x, y); }
  rotate(rad: number): void { this.canvas.rotate(rad * DEG, 0, 0); }
  scale(x: number, y: number): void { this.canvas.scale(x, y); }

  // ---------- gradients ----------
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    return new CanvasGradient('linear', [x0, y0, x1, y1]);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
    return new CanvasGradient('radial', [x0, y0, r0, x1, y1, r1]);
  }

  // ---------- paths ----------
  beginPath(): void {
    this.builder.reset();
    this.hasPoint = false;
  }
  moveTo(x: number, y: number): void {
    this.builder.moveTo(x, y);
    this.hasPoint = true;
    this.startX = this.curX = x;
    this.startY = this.curY = y;
  }
  lineTo(x: number, y: number): void {
    if (!this.hasPoint) { this.moveTo(x, y); return; }
    this.builder.lineTo(x, y);
    this.curX = x;
    this.curY = y;
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.hasPoint) this.moveTo(cx, cy);
    this.builder.quadTo(cx, cy, x, y);
    this.curX = x;
    this.curY = y;
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!this.hasPoint) this.moveTo(c1x, c1y);
    this.builder.cubicTo(c1x, c1y, c2x, c2y, x, y);
    this.curX = x;
    this.curY = y;
  }
  closePath(): void {
    if (!this.hasPoint) return;
    this.builder.close();
    this.curX = this.startX;
    this.curY = this.startY;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (!this.hasPoint) this.moveTo(x1, y1);
    if (r <= 0) { this.lineTo(x1, y1); return; }
    this.builder.arcToTangent(x1, y1, x2, y2, r);
    const last = this.builder.getLastPt();
    this.curX = last.x;
    this.curY = last.y;
  }

  /** Canvas arc(): a line joins the current point to the start of the arc. */
  arc(x: number, y: number, r: number, start: number, end: number, ccw = false): void {
    if (!(r > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const sweep = arcSweep(start, end, ccw);
    if (!this.hasPoint && Math.abs(sweep) >= TAU - 1e-6) {
      // full circle on a fresh subpath
      this.builder.addCircle(x, y, r);
      this.hasPoint = true;
      this.startX = this.curX = x + r;
      this.startY = this.curY = y;
      return;
    }
    const oval = Skia.XYWHRect(x - r, y - r, r * 2, r * 2);
    const sx = x + Math.cos(start) * r, sy = y + Math.sin(start) * r;
    if (!this.hasPoint) this.moveTo(sx, sy);
    else this.lineTo(sx, sy);
    // Skia arcs of a full turn are split in two so they always draw
    const sDeg = start * DEG;
    const wDeg = sweep * DEG;
    if (Math.abs(wDeg) >= 359.999) {
      this.builder.arcToOval(oval, sDeg, wDeg / 2, false);
      this.builder.arcToOval(oval, sDeg + wDeg / 2, wDeg / 2, false);
    } else if (wDeg !== 0) {
      this.builder.arcToOval(oval, sDeg, wDeg, false);
    }
    const e = start + sweep;
    this.curX = x + Math.cos(e) * r;
    this.curY = y + Math.sin(e) * r;
  }

  ellipse(x: number, y: number, rx: number, ry: number, rot: number, start: number, end: number, ccw = false): void {
    if (!(rx > 0) || !(ry > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const sweep = arcSweep(start, end, ccw);
    if (rot === 0 && !this.hasPoint && Math.abs(sweep) >= TAU - 1e-6) {
      this.builder.addOval(Skia.XYWHRect(x - rx, y - ry, rx * 2, ry * 2));
      this.hasPoint = true;
      this.startX = this.curX = x + rx;
      this.startY = this.curY = y;
      return;
    }
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const n = Math.max(8, Math.ceil((Math.abs(sweep) / TAU) * 48));
    for (let i = 0; i <= n; i++) {
      const t = start + (sweep * i) / n;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      const px = x + cr * ex - sr * ey, py = y + sr * ex + cr * ey;
      if (i === 0 && !this.hasPoint) this.moveTo(px, py);
      else this.lineTo(px, py);
    }
  }

  // ---------- painting ----------
  private applyShadow(p: SkPaint): void {
    const s = this.s;
    if (s.shadowBlur > 0 || s.shadowOffsetX || s.shadowOffsetY) {
      const c = toColor(s.shadowColor);
      if (c[3] > 0) {
        p.setImageFilter(Skia.ImageFilter.MakeDropShadow(s.shadowOffsetX, s.shadowOffsetY, s.shadowBlur / 2, s.shadowBlur / 2, c, null));
        return;
      }
    }
    p.setImageFilter(null);
  }

  private setupStyle(p: SkPaint, style: FillStyle): void {
    const ga = this.s.globalAlpha;
    if (typeof style === 'string') {
      p.setShader(null);
      const c = toColor(style);
      p.setColor(c);
      if (ga < 1) p.setAlphaf(c[3] * ga);
    } else {
      p.setColor(toColor('#000000'));
      p.setShader(style.toShader());
      p.setAlphaf(ga);
    }
    this.applyShadow(p);
  }

  private get fillP(): SkPaint {
    this.setupStyle(this.fillPaint, this.s.fillStyle);
    return this.fillPaint;
  }

  private get strokeP(): SkPaint {
    const p = this.strokePaint;
    this.setupStyle(p, this.s.strokeStyle);
    p.setStrokeWidth(this.s.lineWidth);
    p.setStrokeCap(CAPS[this.s.lineCap]);
    p.setStrokeJoin(JOINS[this.s.lineJoin]);
    const d = this.s.lineDash;
    p.setPathEffect(d.length ? Skia.PathEffect.MakeDash(d.length % 2 ? d.concat(d) : d, this.s.lineDashOffset) : null);
    return p;
  }

  fill(): void {
    if (!this.hasPoint) return;
    this.canvas.drawPath(this.builder.build(), this.fillP);
  }
  stroke(): void {
    if (!this.hasPoint) return;
    this.canvas.drawPath(this.builder.build(), this.strokeP);
  }
  clip(): void {
    this.canvas.clipPath(this.builder.build(), ClipOp.Intersect, true);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (!(Math.abs(w) > 0 && Math.abs(h) > 0)) return;
    this.canvas.drawRect(Skia.XYWHRect(Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h)), this.fillP);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.canvas.drawRect(Skia.XYWHRect(x, y, w, h), this.strokeP);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    const p = Skia.Paint();
    p.setBlendMode(BlendMode.Clear);
    this.canvas.drawRect(Skia.XYWHRect(x, y, w, h), p);
  }

  // ---------- text ----------
  measureText(text: string): { width: number } {
    return { width: parseFont(this.s.font).getTextWidth(text) };
  }

  private drawTextImpl(text: string, x: number, y: number, paint: SkPaint, maxWidth?: number): void {
    if (!text) return;
    const font = parseFont(this.s.font);
    const w = font.getTextWidth(text);
    const m = font.getMetrics();
    let bx = x;
    const align = this.s.textAlign;
    const squeeze = maxWidth !== undefined && maxWidth > 0 && w > maxWidth ? maxWidth / w : 1;
    const ew = w * squeeze;
    if (align === 'center') bx = x - ew / 2;
    else if (align === 'right' || align === 'end') bx = x - ew;
    let by = y;
    switch (this.s.textBaseline) {
      case 'middle': by = y - (m.ascent + m.descent) / 2; break;
      case 'top': case 'hanging': by = y - m.ascent; break;
      case 'bottom': case 'ideographic': by = y - m.descent; break;
      default: break;
    }
    if (squeeze !== 1) {
      this.canvas.save();
      this.canvas.translate(bx, by);
      this.canvas.scale(squeeze, 1);
      this.canvas.drawText(text, 0, 0, paint, font);
      this.canvas.restore();
    } else {
      this.canvas.drawText(text, bx, by, paint, font);
    }
  }
  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.drawTextImpl(text, x, y, this.fillP, maxWidth);
  }
  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    const p = this.strokeP;
    p.setPathEffect(null);
    this.drawTextImpl(text, x, y, p, maxWidth);
  }

  // ---------- images ----------
  /** Like drawImage(img, x, y, w, h) for a recorded sprite. */
  drawSprite(sp: Sprite, x: number, y: number, w: number, h: number): void {
    this.canvas.save();
    this.canvas.translate(x, y);
    this.canvas.scale(w / sp.w, h / sp.h);
    if (this.s.globalAlpha < 1) {
      const p = Skia.Paint();
      p.setAlphaf(this.s.globalAlpha);
      this.canvas.saveLayer(p);
      this.canvas.drawPicture(sp.picture);
      this.canvas.restore();
    } else {
      this.canvas.drawPicture(sp.picture);
    }
    this.canvas.restore();
  }
}

/** Sweep (radians, signed) of a canvas arc from start to end. */
function arcSweep(start: number, end: number, ccw: boolean): number {
  if (!ccw) {
    if (end - start >= TAU) return TAU;
    let d = (end - start) % TAU;
    if (d < 0) d += TAU;
    return d;
  }
  if (start - end >= TAU) return -TAU;
  let d = (start - end) % TAU;
  if (d < 0) d += TAU;
  return -d;
}

/** Record drawing commands into a reusable picture (a canvas "image"). */
export function recordSprite(w: number, h: number, draw: (ctx: Ctx2D) => void): Sprite {
  const rec = Skia.PictureRecorder();
  const canvas = rec.beginRecording(Skia.XYWHRect(0, 0, Math.max(1, w), Math.max(1, h)));
  const ctx = new Ctx2D(canvas);
  draw(ctx);
  return { picture: rec.finishRecordingAsPicture(), w, h };
}
