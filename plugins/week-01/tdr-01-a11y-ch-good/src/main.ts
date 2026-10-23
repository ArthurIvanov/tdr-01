// Main thread: resolves foreground/background colors for the selection and
// writes edited colors back to the document.

import { blend, toHex as rgbToHex } from './contrast.ts'
import type { Note, Settings, Source, ToMain, ToUi } from './messages.ts'

const DEFAULT_SETTINGS: Settings = { level: 'AA', size: 'auto' }
const ICON_TYPES: NodeType[] = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'ELLIPSE']
// Events caused by our own writes arrive within this window and are ignored.
const SELF_WRITE_MS = 400

figma.showUI(__html__, { width: 320, height: 420, themeColors: true })

let lastWrite = 0

function toHex({ r, g, b }: RGB): string {
  return rgbToHex([r * 255, g * 255, b * 255])
}

function fromHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

function paintsOf(node: BaseNode, key: 'fills' | 'strokes'): readonly Paint[] | null {
  if (!(key in node)) return null
  const paints = (node as GeometryMixin)[key]
  return paints === figma.mixed ? null : paints
}

/** Index of the topmost visible paint (the last one in Figma's array). */
function topIndex(paints: readonly Paint[]): number {
  for (let i = paints.length - 1; i >= 0; i--) {
    if (paints[i].visible !== false) return i
  }
  return -1
}

function bound(node: SceneNode, key: 'fills' | 'strokes', paint: SolidPaint): Source['bound'] {
  const styleId = (node as GeometryMixin)[key === 'fills' ? 'fillStyleId' : 'strokeStyleId']
  if (typeof styleId === 'string' && styleId !== '') return 'style'
  return paint.boundVariables?.color ? 'variable' : null
}

function describe(node: SceneNode, key: 'fills' | 'strokes', paint: SolidPaint, writable = true): Source {
  const nodeOpacity = 'opacity' in node ? node.opacity : 1
  return {
    id: node.id,
    name: node.name,
    hex: toHex(paint.color),
    opacity: (paint.opacity ?? 1) * nodeOpacity,
    bound: bound(node, key, paint),
    writable,
  }
}

function foregroundOf(node: SceneNode): { source: Source | null; note: Note } {
  for (const key of ['fills', 'strokes'] as const) {
    const paints = paintsOf(node, key)
    const i = paints ? topIndex(paints) : -1
    if (!paints || i < 0) continue
    const paint = paints[i]
    return paint.type === 'SOLID'
      ? { source: describe(node, key, paint), note: null }
      : { source: null, note: 'gradient-fg' }
  }
  return { source: null, note: 'no-fg' }
}

/**
 * Walks up the ancestors and composites translucent fills over the first
 * opaque one. Gradients and images cannot be reduced to a single color.
 */
function backgroundOf(node: SceneNode): { source: Source | null; note: Note } {
  const layers: { hex: string; alpha: number }[] = []
  let editable: Source | null = null
  let opaque = false

  for (let p: BaseNode | null = node.parent; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT' && !opaque; p = p.parent) {
    const fills = paintsOf(p, 'fills')
    if (!fills) continue
    for (let i = fills.length - 1; i >= 0 && !opaque; i--) {
      const paint = fills[i]
      if (paint.visible === false || (paint.opacity ?? 1) <= 0) continue
      if (paint.type !== 'SOLID') return { source: null, note: 'gradient-bg' }
      layers.push({ hex: toHex(paint.color), alpha: paint.opacity ?? 1 })
      editable = editable ?? describe(p as SceneNode, 'fills', paint)
      opaque = (paint.opacity ?? 1) >= 1
    }
  }

  if (!opaque) {
    const page = figma.currentPage
    const bg = page.backgrounds.find((b): b is SolidPaint => b.type === 'SOLID' && b.visible !== false)
    if (bg) {
      layers.push({ hex: toHex(bg.color), alpha: 1 })
      editable = editable ?? { id: page.id, name: 'Page background', hex: toHex(bg.color), opacity: 1, bound: null, writable: true }
    }
  }
  if (!editable) return { source: null, note: null }

  let hex = layers[layers.length - 1].hex
  for (let i = layers.length - 2; i >= 0; i--) hex = blend(layers[i].hex, hex, layers[i].alpha)
  // A blend of several layers has no single node to write back to.
  return { source: { ...editable, hex, writable: layers.length === 1 }, note: null }
}

// A selected container (button, card) is checked through its first text layer
// or icon, so its own fill becomes the background.
function pickTarget(node: SceneNode): SceneNode {
  if (!('findAllWithCriteria' in node)) return node
  const usable = (n: SceneNode) => n.visible && foregroundOf(n).source !== null
  const text = node.findAllWithCriteria({ types: ['TEXT'] }).find(usable)
  if (text) return text
  return node.findAllWithCriteria({ types: ICON_TYPES }).find(usable) ?? node
}

function selectedTarget(): SceneNode | null {
  const node = figma.currentPage.selection[0]
  return node ? pickTarget(node) : null
}

function send(msg: ToUi) {
  figma.ui.postMessage(msg)
}

function publish() {
  const node = selectedTarget()
  if (!node) {
    send({ type: 'selection', fg: null, bg: null, fontSize: null, bold: false, nodeName: null, note: null })
    return
  }
  let fontSize: number | null = null
  let bold = false
  if (node.type === 'TEXT') {
    if (node.fontSize !== figma.mixed) fontSize = node.fontSize
    if (node.fontWeight !== figma.mixed) bold = node.fontWeight >= 700
  }
  const fg = foregroundOf(node)
  const bg = backgroundOf(node)
  send({
    type: 'selection',
    fg: fg.source,
    bg: bg.source,
    fontSize,
    bold,
    nodeName: node.name,
    note: fg.note ?? bg.note,
  })
}

async function apply(nodeId: string, hex: string) {
  const color = fromHex(hex)
  const node = await figma.getNodeByIdAsync(nodeId)
  if (!color || !node) return
  lastWrite = Date.now()

  const recolor = (paints: readonly Paint[]): Paint[] | null => {
    const i = topIndex(paints)
    const paint = paints[i]
    if (i < 0 || paint.type !== 'SOLID') return null
    // A fresh paint drops variable bindings, which would otherwise override the color.
    const next: SolidPaint = { type: 'SOLID', color, opacity: paint.opacity, visible: paint.visible, blendMode: paint.blendMode }
    return paints.map((p, j) => (j === i ? next : p))
  }

  if (node.type === 'PAGE') {
    const next = recolor(node.backgrounds)
    if (next) node.backgrounds = next
    return
  }
  if (node.type === 'DOCUMENT') return
  // Use the fill unless the node only has a stroke (stroke-only icons).
  for (const key of ['fills', 'strokes'] as const) {
    const paints = paintsOf(node, key)
    const next = paints ? recolor(paints) : null
    if (next) {
      ;(node as GeometryMixin)[key] = next
      return
    }
  }
}

// Re-publish when the selected layer or one of its ancestors changes on the canvas.
let pending: ReturnType<typeof setTimeout> | undefined
function onNodeChange(event: NodeChangeEvent) {
  if (Date.now() - lastWrite < SELF_WRITE_MS) return
  const target = selectedTarget()
  if (!target) return
  const ids = new Set<string>()
  for (let n: BaseNode | null = target; n; n = n.parent) ids.add(n.id)
  if (!event.nodeChanges.some((c) => ids.has(c.id))) return
  if (pending) clearTimeout(pending)
  pending = setTimeout(publish, 80)
}

let page = figma.currentPage
page.on('nodechange', onNodeChange)
figma.on('currentpagechange', () => {
  page.off('nodechange', onNodeChange)
  page = figma.currentPage
  page.on('nodechange', onNodeChange)
  publish()
})
figma.on('selectionchange', publish)

figma.ui.on('message', async (msg: ToMain) => {
  switch (msg.type) {
    case 'apply':
      await apply(msg.nodeId, msg.hex)
      break
    case 'commit':
      figma.commitUndo()
      break
    case 'settings':
      await figma.clientStorage.setAsync('settings', msg.settings)
      break
  }
})

figma.clientStorage.getAsync('settings').then((saved: Settings | undefined) => {
  send({ type: 'settings', settings: { ...DEFAULT_SETTINGS, ...saved } })
})
publish()
