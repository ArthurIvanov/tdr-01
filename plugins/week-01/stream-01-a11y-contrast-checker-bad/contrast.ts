// Pure color math (no Figma globals) so it can be unit-tested outside Figma.

interface Rgb {
  r: number
  g: number
  b: number
}

type Level = 'AA' | 'AAA'

const WHITE: Rgb = { r: 1, g: 1, b: 1 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

function toLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b)
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// Composites `top` with the given alpha over an opaque `bottom` color.
function blend(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  }
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

function toHex(c: Rgb): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase()
}

function floor2(n: number): number {
  return Math.floor(n * 100) / 100
}

// WCAG: large text is >= 18pt (24px), or >= 14pt (~18.66px) bold.
function isLargeText(size: number, weight: number): boolean {
  return size >= 24 || (size >= 18.66 && weight >= 700)
}

function requiredRatio(level: Level, large: boolean): number {
  if (level === 'AAA') return large ? 4.5 : 7
  return large ? 3 : 4.5
}

// APCA 0.0.98G-4g lightness contrast (Lc). Positive = dark text on light bg.
function apcaLc(fg: Rgb, bg: Rgb): number {
  const y = (c: Rgb) => {
    const v = 0.2126729 * Math.pow(c.r, 2.4) + 0.7151522 * Math.pow(c.g, 2.4) + 0.072175 * Math.pow(c.b, 2.4)
    return v < 0.022 ? v + Math.pow(0.022 - v, 1.414) : v
  }
  const yt = y(fg)
  const yb = y(bg)
  if (Math.abs(yb - yt) < 0.0005) return 0
  let out: number
  if (yb > yt) {
    const s = (Math.pow(yb, 0.56) - Math.pow(yt, 0.57)) * 1.14
    out = s < 0.1 ? 0 : s - 0.027
  } else {
    const s = (Math.pow(yb, 0.65) - Math.pow(yt, 0.62)) * 1.14
    out = s > -0.1 ? 0 : s + 0.027
  }
  return out * 100
}

// Smallest shift of `color` toward black or white for which `ratioOf` reaches
// `goal`; keeps the original hue as much as possible. Null if unreachable.
function searchShift(color: Rgb, ratioOf: (c: Rgb) => number, goal: number): Rgb | null {
  let best: { t: number; color: Rgb } | null = null
  for (const target of [BLACK, WHITE]) {
    if (ratioOf(target) < goal) continue
    let lo = 0
    let hi = 1
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (ratioOf(mix(color, target, mid)) >= goal) hi = mid
      else lo = mid
    }
    if (!best || hi < best.t) best = { t: hi, color: mix(color, target, hi) }
  }
  return best ? best.color : null
}
