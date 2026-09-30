/**
 * Measure text the way the browser will draw it: a canvas where one exists,
 * a per-character estimate otherwise (Node, jsdom). Shared by the layout (box
 * and label sizes) and the label declutterer, so what is measured is what is
 * drawn.
 */

let measureCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Width in px of `text` in CSS font `font`. Uses a canvas where one exists (the
 * browser) and a per-character estimate otherwise (Node, jsdom), so the size is
 * exact where it is drawn and conservative where it is only tested.
 */
export function textWidth(text: string, font: string, avgCharPx: number): number {
  if (measureCtx === undefined) {
    try {
      measureCtx =
        typeof document !== 'undefined' ? (document.createElement('canvas').getContext('2d') ?? null) : null;
    } catch {
      measureCtx = null;
    }
  }
  if (measureCtx) {
    measureCtx.font = font;
    const w = measureCtx.measureText(text).width;
    if (Number.isFinite(w) && w > 0) return w;
  }
  return text.length * avgCharPx;
}
