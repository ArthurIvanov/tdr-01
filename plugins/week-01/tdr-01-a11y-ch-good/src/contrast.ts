// Pure color and WCAG math shared by the plugin UI and the tests.

export type Rgb = [number, number, number]
export type Level = 'AA' | 'AAA'
export type Kind = 'text' | 'large' | 'ui'

export const isHex = (h: string): boolean => /^#[0-9a-f]{6}$/i.test(h)

export function parseHex(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function toHex(rgb: Rgb): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`.toUpperCase()
}

const linear = (v: number) => {
  v /= 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const gamma = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

// WCAG 2.x relative luminance.
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Composites `fg` with `alpha` over an opaque `bg`. */
export function blend(fg: string, bg: string, alpha: number): string {
  const f = parseHex(fg)
  const b = parseHex(bg)
  return toHex([0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as Rgb)
}

/** Required ratios [AA, AAA]. UI components have a single 3:1 level. */
export function thresholds(kind: Kind): [number, number] {
  return kind === 'text' ? [4.5, 7] : kind === 'large' ? [3, 4.5] : [3, 3]
}

/** Large text per WCAG: 18pt (24px) or 14pt (18.66px) bold. */
export const isLargeText = (fontSize: number, bold: boolean): boolean =>
  fontSize >= 24 || (bold && fontSize >= 18.66)

// --- OKLCH: perceptually even lightness, so one slider step feels the same for any hue.

export type Oklch = [number, number, number]

export function toOklch(hex: string): Oklch {
  const [r, g, b] = parseHex(hex).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(a, bb), (Math.atan2(bb, a) * 180) / Math.PI]
}

function oklchToLinear([L, C, h]: Oklch): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005)

/** Converts OKLCH to hex, reducing chroma until the color fits into sRGB. */
export function fromOklch([L, C, h]: Oklch): string {
  if (L <= 0) return '#000000'
  if (L >= 1) return '#FFFFFF'
  let lo = 0
  let hi = C
  let rgb = oklchToLinear([L, C, h])
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinear([L, mid, h]))) lo = mid
      else hi = mid
    }
    rgb = oklchToLinear([L, lo, h])
  }
  return toHex(rgb.map((v) => gamma(Math.max(0, Math.min(1, v))) ) as Rgb)
}

/** Lightness as a 0–100 integer (OKLCH L). */
export const lightnessOf = (hex: string): number => Math.round(toOklch(hex)[0] * 100)

export function withLightness(hex: string, percent: number): string {
  const [, c, h] = toOklch(hex)
  return fromOklch([percent / 100, c, h])
}

/**
 * Lightness (0–100) closest to the current one at which `fg` reaches `target`
 * over `bg`, or null when no lightness does.
 */
export function findLightness(fg: string, bg: string, alpha: number, target: number): number | null {
  const current = lightnessOf(fg)
  let best: number | null = null
  for (let i = 0; i <= 100; i++) {
    const candidate = withLightness(fg, i)
    if (contrast(blend(candidate, bg, alpha), bg) < target) continue
    if (best === null || Math.abs(i - current) < Math.abs(best - current)) best = i
  }
  return best
}
