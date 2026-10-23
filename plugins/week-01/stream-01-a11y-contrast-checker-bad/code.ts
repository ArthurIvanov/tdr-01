// A11y contrast checker: scans text layers (and optionally icons / control
// borders) in the selection or on the page, reports WCAG 2.x violations and
// applies undoable fixes. Pure color math lives in contrast.ts.

type Lang = 'ru' | 'en'
type Target = 'range' | 'fills' | 'strokes'
type FixMode = 'edit' | 'detach' | 'bg'
type SkipReason = 'image' | 'unsupported' | 'fg-unsupported'

interface Settings {
  level: Level
  nonText: boolean
  lang?: Lang
}

interface Fix {
  color: Rgb
  opacity: number
  hex: string
  ratio: number
}

interface BgFix {
  color: Rgb
  hex: string
  ratio: number
  nodeId: string
  nodeName: string
}

interface Bound {
  kind: 'style' | 'variable'
  id: string
  name: string
}

interface Issue {
  key: string
  id: string
  kind: 'text' | 'nontext'
  target: Target
  start: number
  end: number
  name: string
  label: string
  frame: string
  ratio: number
  required: number
  apca: number
  fg: string
  bg: string
  fontSize: number
  large: boolean
  approx: boolean
  fix: Fix | null
  bgFix: BgFix | null
  bound: Bound | null
}

interface Skipped {
  id: string
  name: string
  label: string
  reason: SkipReason
}

interface Ignored {
  id: string
  name: string
  label: string
}

type PluginMessage =
  | { type: 'settings'; settings: Settings; selection: number }
  | { type: 'selection'; count: number }
  | { type: 'progress'; done: number; total: number }
  | {
      type: 'result'
      scope: 'selection' | 'page'
      checked: number
      issues: Issue[]
      skipped: Skipped[]
      ignored: Ignored[]
    }
  | { type: 'fixed'; keys: string[]; failed: number }

interface FixRequest {
  key: string
  id: string
  start: number
  end: number
  target: Target
  mode: FixMode
  color: Rgb
  opacity: number
  bound: Bound | null
  bgNodeId?: string
}

type UiMessage =
  | { type: 'ready' }
  | { type: 'scan'; settings: Settings }
  | { type: 'focus'; id: string }
  | { type: 'fix'; items: FixRequest[] }
  | { type: 'ignore'; ids: string[] }
  | { type: 'unignore'; id: string }

const CHUNK = 60
const BBOX_TOLERANCE = 1
const MAX_ICON_SIZE = 64
const NON_TEXT_REQUIRED = 3
const IGNORE_KEY = 'a11y-ignore'
const CONTROL_NAME = /input|field|checkbox|radio|toggle|switch|select|textarea|dropdown/i
const ICON_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'] as const
const CONTROL_TYPES = ['FRAME', 'RECTANGLE', 'INSTANCE', 'COMPONENT'] as const

// ---------------------------------------------------------------- paints

// Topmost visible paint, or null; `figma.mixed` yields 'mixed'.
function topPaint(paints: readonly Paint[] | typeof figma.mixed): Paint | 'mixed' | null {
  if (paints === figma.mixed) return 'mixed'
  for (let i = paints.length - 1; i >= 0; i--) {
    if (paints[i].visible !== false) return paints[i]
  }
  return null
}

function replaceTopSolid(paints: readonly Paint[], color: Rgb, opacity: number): Paint[] {
  const out = paints.slice()
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i]
    if (p.visible === false) continue
    // Fresh paint on purpose: drops any variable binding on the old one.
    out[i] = { type: 'SOLID', color, opacity, visible: true, blendMode: p.blendMode }
    break
  }
  return out
}

// ------------------------------------------------------------- backdrop

interface Pair {
  fg: Rgb
  bg: Rgb
}

interface BgSource {
  node: SceneNode
  paint: SolidPaint
}

interface Layer {
  colors: { color: Rgb; alpha: number }[] // several entries = gradient stops
}

interface Backdrop {
  evaluate(fg: Rgb, alpha: number): Pair[]
  approx: boolean
  source: BgSource | null // sole opaque topmost fill, safe to recolor
}

function contains(outer: Rect, inner: Rect): boolean {
  const t = BBOX_TOLERANCE
  return (
    outer.x <= inner.x + t &&
    outer.y <= inner.y + t &&
    outer.x + outer.width >= inner.x + inner.width - t &&
    outer.y + outer.height >= inner.y + inner.height - t
  )
}

function fadedAncestor(node: BaseNode): SceneNode | null {
  let cur = node.parent
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    if ('opacity' in cur && cur.opacity < 1) return cur as SceneNode
    cur = cur.parent
  }
  return null
}

function hasBinding(n: SceneNode, p: SolidPaint): boolean {
  const style = 'fillStyleId' in n ? n.fillStyleId : ''
  return (typeof style === 'string' && style !== '') || !!p.boundVariables?.color
}

// Walks up the tree. At each level lower siblings that fully cover the node
// count as backdrop, then the parent's own fill. Opacity of an ancestor group
// is applied to the whole group composite over *its* backdrop (resolved
// recursively), which is how Figma renders it.
function resolveBackdrop(node: SceneNode): Backdrop | SkipReason {
  const box = node.absoluteBoundingBox
  const layers: Layer[] = [] // topmost first
  let source: BgSource | null = null
  let opaque = false
  let gradients = 0
  let group: SceneNode | null = null

  const add = (n: SceneNode & MinimalFillsMixin, ignoreOpacity: boolean): 'skip' | 'ok' | SkipReason => {
    const p = topPaint(n.fills)
    if (p === 'mixed') return 'unsupported'
    if (p === null) return 'skip'
    const op = ignoreOpacity ? 1 : 'opacity' in n ? n.opacity : 1
    if (p.type === 'SOLID') {
      const alpha = (p.opacity ?? 1) * op
      if (alpha <= 0) return 'skip'
      if (layers.length === 0 && alpha >= 1 && !hasBinding(n, p)) source = { node: n, paint: p }
      layers.push({ colors: [{ color: p.color, alpha }] })
      if (alpha >= 1) opaque = true
      return 'ok'
    }
    if (p.type === 'IMAGE' || p.type === 'VIDEO') return 'image'
    if (p.type.startsWith('GRADIENT_')) {
      if (++gradients > 1) return 'unsupported'
      const g = p as GradientPaint
      const colors = g.gradientStops.map((s) => ({
        color: { r: s.color.r, g: s.color.g, b: s.color.b },
        alpha: s.color.a * (g.opacity ?? 1) * op,
      }))
      layers.push({ colors })
      if (colors.every((c) => c.alpha >= 1)) opaque = true
      return 'ok'
    }
    return 'unsupported'
  }

  let cur: BaseNode = node
  while (cur.parent && !opaque && !group) {
    const parent = cur.parent as BaseNode & ChildrenMixin
    if (parent.type === 'PAGE') {
      const bg = parent.backgrounds[0]
      layers.push({ colors: [{ color: bg && bg.type === 'SOLID' ? bg.color : WHITE, alpha: 1 }] })
      opaque = true
      break
    }
    if (parent.type === 'DOCUMENT') break

    if (box) {
      const siblings = parent.children
      for (let i = siblings.indexOf(cur as SceneNode) - 1; i >= 0 && !opaque; i--) {
        const sib = siblings[i]
        if (!sib.visible || sib.type === 'TEXT' || !('fills' in sib)) continue
        if ('isMask' in sib && sib.isMask) continue
        const sb = sib.absoluteBoundingBox
        if (!sb || !contains(sb, box)) continue
        const r = add(sib, false)
        if (r === 'image' || r === 'unsupported') return r
      }
    }
    if (!opaque && 'fills' in parent) {
      const faded = 'opacity' in parent && parent.opacity < 1
      const r = add(parent as unknown as SceneNode & MinimalFillsMixin, faded)
      if (r === 'image' || r === 'unsupported') return r
    }
    if ('opacity' in parent && parent.opacity < 1) group = parent as SceneNode
    cur = parent
  }
  if (!group) group = fadedAncestor(node)

  let outer: Backdrop | null = null
  if (group) {
    const r = resolveBackdrop(group)
    if (typeof r === 'string') return r
    outer = r
  }

  const count = layers.reduce((n, l) => Math.max(n, l.colors.length), 1)
  const composite = (k: number, start: Rgb): Rgb => {
    let result = start
    for (let i = layers.length - 1; i >= 0; i--) {
      const cs = layers[i].colors
      const c = cs[Math.min(k, cs.length - 1)]
      result = blend(c.color, i === layers.length - 1 && opaque ? 1 : c.alpha, result)
    }
    return result
  }

  const gop = group && 'opacity' in group ? group.opacity : 1
  return {
    approx: count > 1 || !!outer?.approx,
    source: outer ? null : source,
    evaluate(fg, alpha) {
      const obs = outer ? outer.evaluate(WHITE, 0).map((p) => p.bg) : [null]
      const out: Pair[] = []
      for (const ob of obs) {
        for (let k = 0; k < count; k++) {
          const inner = composite(k, ob ?? WHITE)
          const fgIn = blend(fg, alpha, inner)
          out.push(ob ? { fg: blend(fgIn, gop, ob), bg: blend(inner, gop, ob) } : { fg: fgIn, bg: inner })
        }
      }
      return out
    },
  }
}

function worstPair(pairs: Pair[]): { pair: Pair; ratio: number } {
  let best = { pair: pairs[0], ratio: contrastRatio(pairs[0].fg, pairs[0].bg) }
  for (const p of pairs) {
    const ratio = contrastRatio(p.fg, p.bg)
    if (ratio < best.ratio) best = { pair: p, ratio }
  }
  return best
}

// -------------------------------------------------------------- fixes

function suggestFix(
  color: Rgb,
  paintOpacity: number,
  alpha: number,
  bd: Backdrop,
  required: number,
): Fix | null {
  const goal = required + 0.01
  const ratioOf = (c: Rgb) => worstPair(bd.evaluate(c, alpha)).ratio
  const found = searchShift(color, ratioOf, goal)
  if (!found) return null
  return { color: found, opacity: paintOpacity, hex: toHex(found), ratio: floor2(ratioOf(found)) }
}

function suggestBgFix(fg: Rgb, alpha: number, bd: Backdrop, required: number): BgFix | null {
  if (!bd.source || bd.approx) return null
  const src = bd.source
  const ratioOf = (c: Rgb) => contrastRatio(blend(fg, alpha, c), c)
  const found = searchShift(src.paint.color, ratioOf, required + 0.01)
  if (!found) return null
  return {
    color: found,
    hex: toHex(found),
    ratio: floor2(ratioOf(found)),
    nodeId: src.node.id,
    nodeName: src.node.name,
  }
}

// ------------------------------------------------------------ collecting

function isShown(node: SceneNode): boolean {
  let cur: BaseNode | null = node
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    if ('visible' in cur && !cur.visible) return false
    cur = cur.parent
  }
  return true
}

function frameOf(node: SceneNode): string {
  let cur: BaseNode = node
  while (cur.parent && cur.parent.type !== 'PAGE') cur = cur.parent
  return cur.name
}

function collect<T extends SceneNode>(roots: readonly SceneNode[], types: readonly NodeType[]): T[] {
  const out: T[] = []
  for (const n of roots) {
    if (types.includes(n.type)) out.push(n as T)
    if ('findAllWithCriteria' in n) {
      out.push(...(n.findAllWithCriteria({ types: types as NodeType[] }) as unknown as T[]))
    }
  }
  return out.filter(isShown)
}

function isIcon(n: SceneNode): boolean {
  if (n.parent && (n.parent.type === 'BOOLEAN_OPERATION' || n.parent.type === 'VECTOR')) return false
  return Math.max(n.width, n.height) <= MAX_ICON_SIZE
}

function hasVisibleSolidStroke(n: SceneNode): boolean {
  if (!('strokes' in n) || !('strokeWeight' in n)) return false
  const p = topPaint(n.strokes)
  return p !== null && p !== 'mixed' && p.type === 'SOLID' && n.strokeWeight !== 0
}

// ------------------------------------------------------------- names

const nameCache = new Map<string, string>()

async function boundFor(
  styleId: unknown,
  paint: SolidPaint,
): Promise<Bound | null> {
  if (typeof styleId === 'string' && styleId !== '') {
    let name = nameCache.get(styleId)
    if (name === undefined) {
      const s = await figma.getStyleByIdAsync(styleId)
      name = s ? s.name : styleId
      nameCache.set(styleId, name)
    }
    return { kind: 'style', id: styleId, name }
  }
  const alias = paint.boundVariables?.color
  if (alias) {
    let name = nameCache.get(alias.id)
    if (name === undefined) {
      const v = await figma.variables.getVariableByIdAsync(alias.id)
      name = v ? v.name : alias.id
      nameCache.set(alias.id, name)
    }
    return { kind: 'variable', id: alias.id, name }
  }
  return null
}

// -------------------------------------------------------------- scan

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
let scanToken = 0
let settings: Settings = { level: 'AA', nonText: false }

async function scan(): Promise<void> {
  const token = ++scanToken
  const sel = figma.currentPage.selection
  const scope = sel.length > 0 ? 'selection' : 'page'
  const roots = sel.length > 0 ? sel : figma.currentPage.children

  const texts = collect<TextNode>(roots, ['TEXT'])
  const icons = settings.nonText ? collect<SceneNode>(roots, ICON_TYPES).filter(isIcon) : []
  const controls = settings.nonText
    ? collect<SceneNode>(roots, CONTROL_TYPES).filter((n) => CONTROL_NAME.test(n.name) && hasVisibleSolidStroke(n))
    : []
  const total = texts.length + icons.length + controls.length

  const issues: Issue[] = []
  const skipped: Skipped[] = []
  const ignored: Ignored[] = []
  let checked = 0
  let done = 0

  const skip = (n: SceneNode, label: string, reason: SkipReason) =>
    skipped.push({ id: n.id, name: n.name, label, reason })

  const progress = async () => {
    if (done++ % CHUNK !== 0) return true
    figma.ui.postMessage({ type: 'progress', done: done - 1, total } as PluginMessage)
    await tick()
    return token === scanToken
  }

  const isIgnored = (n: SceneNode, label: string) => {
    if (n.getPluginData(IGNORE_KEY) !== '1') return false
    ignored.push({ id: n.id, name: n.name, label })
    return true
  }

  for (const t of texts) {
    if (!(await progress())) return // superseded by a newer scan
    if (t.removed || t.characters.trim() === '') continue
    if (isIgnored(t, t.characters.slice(0, 60))) continue

    const bd = resolveBackdrop(t)
    const nodeAlpha = t.opacity
    const frame = frameOf(t)
    const segments = t.getStyledTextSegments(['fills', 'fontSize', 'fontWeight', 'fillStyleId'])

    for (const seg of segments) {
      if (seg.characters.trim() === '') continue
      const label = seg.characters.slice(0, 60)
      if (typeof bd === 'string') {
        skip(t, label, bd)
        continue
      }
      const paint = topPaint(seg.fills)
      if (paint === null) continue
      if (paint === 'mixed' || paint.type !== 'SOLID') {
        skip(t, label, 'fg-unsupported')
        continue
      }
      const alpha = (paint.opacity ?? 1) * nodeAlpha
      const large = isLargeText(seg.fontSize, seg.fontWeight)
      const required = requiredRatio(settings.level, large)
      const { pair, ratio } = worstPair(bd.evaluate(paint.color, alpha))
      checked++
      if (ratio >= required) continue
      issues.push({
        key: `${t.id}:${seg.start}`,
        id: t.id,
        kind: 'text',
        target: 'range',
        start: seg.start,
        end: seg.end,
        name: t.name,
        label,
        frame,
        ratio: floor2(ratio),
        required,
        apca: Math.round(apcaLc(pair.fg, pair.bg) * 10) / 10,
        fg: toHex(pair.fg),
        bg: toHex(pair.bg),
        fontSize: seg.fontSize,
        large,
        approx: bd.approx,
        fix: suggestFix(paint.color, paint.opacity ?? 1, alpha, bd, required),
        bgFix: suggestBgFix(paint.color, alpha, bd, required),
        bound: await boundFor(seg.fillStyleId, paint),
      })
    }
  }

  const nonText = [
    ...icons.map((n) => ({ n, border: false })),
    ...controls.map((n) => ({ n, border: true })),
  ]
  for (const { n, border } of nonText) {
    if (!(await progress())) return
    if (n.removed || isIgnored(n, n.name)) continue

    const target: Target = border ? 'strokes' : 'fills'
    let paint = border ? topPaint((n as GeometryMixin).strokes) : topPaint((n as GeometryMixin).fills)
    let useTarget = target
    if (!border && paint === null) {
      paint = topPaint((n as GeometryMixin).strokes)
      useTarget = 'strokes'
    }
    if (paint === null) continue
    const bd = resolveBackdrop(n)
    if (typeof bd === 'string') {
      skip(n, n.name, bd)
      continue
    }
    if (paint === 'mixed' || paint.type !== 'SOLID') {
      skip(n, n.name, 'fg-unsupported')
      continue
    }
    const alpha = (paint.opacity ?? 1) * ('opacity' in n ? n.opacity : 1)
    const { pair, ratio } = worstPair(bd.evaluate(paint.color, alpha))
    checked++
    if (ratio >= NON_TEXT_REQUIRED) continue
    const styleId = useTarget === 'strokes' ? (n as GeometryMixin).strokeStyleId : (n as GeometryMixin).fillStyleId
    issues.push({
      key: `${n.id}:${useTarget}`,
      id: n.id,
      kind: 'nontext',
      target: useTarget,
      start: 0,
      end: 0,
      name: n.name,
      label: n.name,
      frame: frameOf(n),
      ratio: floor2(ratio),
      required: NON_TEXT_REQUIRED,
      apca: Math.round(apcaLc(pair.fg, pair.bg) * 10) / 10,
      fg: toHex(pair.fg),
      bg: toHex(pair.bg),
      fontSize: 0,
      large: false,
      approx: bd.approx,
      fix: suggestFix(paint.color, paint.opacity ?? 1, alpha, bd, NON_TEXT_REQUIRED),
      bgFix: suggestBgFix(paint.color, alpha, bd, NON_TEXT_REQUIRED),
      bound: await boundFor(styleId, paint),
    })
  }

  issues.sort((a, b) => a.ratio - b.ratio)
  figma.ui.postMessage({ type: 'result', scope, checked, issues, skipped, ignored } as PluginMessage)
}

// ------------------------------------------------------------- applying

async function applyOne(it: FixRequest): Promise<void> {
  const color = it.color

  if (it.mode === 'bg') {
    const bgNode = await figma.getNodeByIdAsync(it.bgNodeId ?? '')
    if (!bgNode || !('fills' in bgNode) || bgNode.fills === figma.mixed) throw new Error('bg gone')
    bgNode.fills = replaceTopSolid(bgNode.fills, color, 1)
    return
  }

  if (it.mode === 'edit' && it.bound) {
    if (it.bound.kind === 'style') {
      const style = await figma.getStyleByIdAsync(it.bound.id)
      if (!style || style.type !== 'PAINT') throw new Error('style gone')
      style.paints = replaceTopSolid(style.paints, color, it.opacity)
    } else {
      const v = await figma.variables.getVariableByIdAsync(it.bound.id)
      if (!v || v.resolvedType !== 'COLOR') throw new Error('variable gone')
      const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId)
      if (!col) throw new Error('collection gone')
      v.setValueForMode(col.defaultModeId, { r: color.r, g: color.g, b: color.b })
    }
    return
  }

  const node = await figma.getNodeByIdAsync(it.id)
  if (!node) throw new Error('gone')
  if (it.target === 'range') {
    if (node.type !== 'TEXT') throw new Error('not text')
    for (const font of node.getRangeAllFontNames(it.start, it.end)) await figma.loadFontAsync(font)
    if (it.bound?.kind === 'style') await node.setRangeFillStyleIdAsync(it.start, it.end, '')
    const paints = node.getRangeFills(it.start, it.end)
    if (paints === figma.mixed) throw new Error('mixed')
    node.setRangeFills(it.start, it.end, replaceTopSolid(paints, color, it.opacity))
  } else if (it.target === 'fills') {
    if (!('fills' in node) || node.fills === figma.mixed) throw new Error('no fills')
    if (it.bound?.kind === 'style') await node.setFillStyleIdAsync('')
    node.fills = replaceTopSolid(node.fills, color, it.opacity)
  } else {
    if (!('strokes' in node)) throw new Error('no strokes')
    if (it.bound?.kind === 'style') await node.setStrokeStyleIdAsync('')
    node.strokes = replaceTopSolid(node.strokes, color, it.opacity)
  }
}

async function applyFixes(items: FixRequest[]): Promise<void> {
  const keys: string[] = []
  let failed = 0
  for (const it of items) {
    try {
      await applyOne(it)
      keys.push(it.key)
    } catch (_e) {
      failed++
    }
  }
  figma.commitUndo()
  figma.ui.postMessage({ type: 'fixed', keys, failed } as PluginMessage)
  if (keys.length) figma.notify(`Fixed ${keys.length}`)
  if (failed) figma.notify(`Could not fix ${failed}`, { error: true })
}

// ----------------------------------------------------------- plugin UI

figma.showUI(__html__, { width: 400, height: 560, themeColors: true })

figma.on('selectionchange', () => {
  figma.ui.postMessage({ type: 'selection', count: figma.currentPage.selection.length } as PluginMessage)
})

figma.ui.onmessage = async (msg: UiMessage) => {
  switch (msg.type) {
    case 'ready': {
      const saved = (await figma.clientStorage.getAsync('settings')) as Partial<Settings> | undefined
      settings = { ...settings, ...saved }
      figma.ui.postMessage({
        type: 'settings',
        settings,
        selection: figma.currentPage.selection.length,
      } as PluginMessage)
      break
    }
    case 'scan':
      settings = msg.settings
      await figma.clientStorage.setAsync('settings', settings)
      await scan()
      break
    case 'fix':
      await applyFixes(msg.items)
      break
    case 'ignore':
    case 'unignore': {
      const ids = msg.type === 'ignore' ? msg.ids : [msg.id]
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id)
        if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
          node.setPluginData(IGNORE_KEY, msg.type === 'ignore' ? '1' : '')
        }
      }
      break
    }
    case 'focus': {
      const node = await figma.getNodeByIdAsync(msg.id)
      if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
        const scene = node as SceneNode
        figma.currentPage.selection = [scene]
        figma.viewport.scrollAndZoomIntoView([scene])
      }
      break
    }
  }
}
