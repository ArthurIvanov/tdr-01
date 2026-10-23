import {
  blend, contrast, findLightness, isHex, isLargeText, lightnessOf, thresholds, withLightness,
  type Kind,
} from './contrast.ts'
import type { Settings, Source, ToMain, ToUi } from './messages.ts'

type Key = 'fg' | 'bg'
interface Color {
  value: string
  /** Color in the document when the layer was selected, for Reset. */
  orig: string | null
  /** Layer the color is written to; null when there is nothing to write. */
  id: string | null
}

const KEYS: Key[] = ['fg', 'bg']
const state = {
  fg: { value: '#000000', orig: null, id: null } as Color,
  bg: { value: '#FFFFFF', orig: null, id: null } as Color,
  sourceIds: { fg: null, bg: null } as Record<Key, string | null>,
  opacity: 1,
  fontSize: null as number | null,
  bold: false,
  nodeName: null as string | null,
  settings: { level: 'AA', size: 'auto' } as Settings,
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const post = (message: ToMain) => parent.postMessage({ pluginMessage: message }, '*')

// --- writing back ------------------------------------------------------------

// Slider ticks are coalesced to one write per frame; the undo step is
// committed once when the gesture ends.
const dirty = new Set<Key>()
let frame = 0

function flush() {
  cancelAnimationFrame(frame)
  frame = 0
  for (const k of dirty) {
    const id = state[k].id
    if (id) post({ type: 'apply', nodeId: id, hex: state[k].value })
  }
  dirty.clear()
}

function push(k: Key) {
  if (!state[k].id) return
  dirty.add(k)
  if (!frame) frame = requestAnimationFrame(flush)
}

function commit() {
  flush()
  post({ type: 'commit' })
}

// --- derived values ----------------------------------------------------------

function kind(): Kind {
  const { size } = state.settings
  if (size === 'normal') return 'text'
  if (size === 'large') return 'large'
  if (state.fontSize !== null) return isLargeText(state.fontSize, state.bold) ? 'large' : 'text'
  return state.nodeName !== null ? 'ui' : 'text'
}

const effectiveText = () => blend(state.fg.value, state.bg.value, state.opacity)

// --- render ------------------------------------------------------------------

function render(from?: string) {
  for (const k of KEYS) {
    const c = state[k]
    $(`${k}Swatch`).style.background = c.value
    if (from !== `${k}Hex`) $<HTMLInputElement>(`${k}Hex`).value = c.value
    const light = lightnessOf(c.value)
    const range = $<HTMLInputElement>(`${k}Light`)
    if (from !== `${k}Light`) range.value = String(light)
    range.setAttribute('aria-valuetext', `Lightness ${light}`)
    $(`${k}Reset`).hidden = !(c.orig !== null && c.orig.toLowerCase() !== c.value.toLowerCase())
  }

  const ratio = contrast(effectiveText(), state.bg.value)
  const current = kind()
  const [aa, aaa] = thresholds(current)
  $('hero').style.background = state.bg.value
  $('hero').style.color = effectiveText()
  $('ratio').textContent = `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`
  $('grade').textContent =
    current === 'ui'
      ? ratio >= aa ? 'Passes 3:1' : 'Fails 3:1'
      : ratio >= aaa ? 'AAA' : ratio >= aa ? 'AA' : 'Fails AA'

  const rows: [string, Kind, number, number | null][] = [
    ['Text', 'text', 4.5, 7],
    ['Large text', 'large', 3, 4.5],
    ['UI & icons', 'ui', 3, null],
  ]
  const chip = (ok: boolean, label: string) =>
    `<span class="chip ${ok ? 'pass' : 'fail'}">${label} ${ok ? '✓' : '✕'}</span>`
  $('results').innerHTML = rows
    .map(
      ([name, k, lo, hi]) =>
        `<div class="check ${k === current ? 'is-current' : ''}"><span>${name}<span class="need muted">${lo}${hi ? ` · ${hi}` : ''}</span></span>` +
        `<span>${chip(ratio >= lo, 'AA')}${hi ? chip(ratio >= hi, 'AAA') : ''}</span></div>`,
    )
    .join('')

  const target = state.settings.level === 'AAA' ? aaa : aa
  const fix = ratio < target ? findLightness(state.fg.value, state.bg.value, state.opacity, target) : null
  const button = $<HTMLButtonElement>('fix')
  button.hidden = fix === null
  if (fix !== null) {
    button.textContent = `Set text lightness to ${fix} → ${state.settings.level}`
    button.dataset.lightness = String(fix)
  }

  document.querySelectorAll<HTMLElement>('[data-level]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.level === state.settings.level)))
  document.querySelectorAll<HTMLElement>('[data-size]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === state.settings.size)))
}

function statusText(m: Extract<ToUi, { type: 'selection' }>, fg: Source | null, bg: Source | null): string {
  if (m.nodeName === null) return 'Select a text layer or icon, or try colors manually.'
  const lines = [state.fontSize ? `${m.nodeName} · ${state.fontSize}px${kind() === 'large' ? ' (large)' : ''}` : m.nodeName]
  if (m.note === 'gradient-bg') lines.push('Background is a gradient or image. Set its color manually.')
  if (m.note === 'gradient-fg') lines.push('Text uses a gradient or image fill. Set its color manually.')
  if (m.note === 'no-fg') lines.push('No solid fill or stroke found.')
  if (bg && !bg.writable) lines.push('Background is layered: shown blended, edits are not written.')
  if ([fg, bg].some((s) => s?.bound)) lines.push('Bound to a style or variable: editing detaches it.')
  return lines.join('\n')
}

// --- events ------------------------------------------------------------------

for (const k of KEYS) {
  const hexInput = $<HTMLInputElement>(`${k}Hex`)
  hexInput.addEventListener('input', () => {
    let v = hexInput.value.trim()
    if (v && v[0] !== '#') v = `#${v}`
    if (!isHex(v)) return
    state[k].value = v.toUpperCase()
    render(`${k}Hex`)
    push(k)
  })
  hexInput.addEventListener('change', commit)
  hexInput.addEventListener('blur', () => render())

  const range = $<HTMLInputElement>(`${k}Light`)
  range.addEventListener('input', () => {
    state[k].value = withLightness(state[k].value, Number(range.value))
    render(`${k}Light`)
    push(k)
  })
  range.addEventListener('change', commit)

  $(`${k}Reset`).addEventListener('click', () => {
    if (state[k].orig === null) return
    state[k].value = state[k].orig
    render()
    push(k)
    commit()
  })

  $(`${k}Swatch`).addEventListener('click', async () => {
    const Picker = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!Picker) return hexInput.focus()
    try {
      state[k].value = (await new Picker().open()).sRGBHex.toUpperCase()
      render()
      push(k)
      commit()
    } catch {
      // Picking was cancelled.
    }
  })
}

$('fix').addEventListener('click', () => {
  state.fg.value = withLightness(state.fg.value, Number($('fix').dataset.lightness))
  render()
  push('fg')
  commit()
})

function setSettings(patch: Partial<Settings>) {
  state.settings = { ...state.settings, ...patch }
  post({ type: 'settings', settings: state.settings })
  render()
}
document.querySelectorAll<HTMLElement>('[data-level]').forEach((b) =>
  b.addEventListener('click', () => setSettings({ level: b.dataset.level as Settings['level'] })))
document.querySelectorAll<HTMLElement>('[data-size]').forEach((b) =>
  b.addEventListener('click', () => setSettings({ size: b.dataset.size as Settings['size'] })))

window.onmessage = (e: MessageEvent<{ pluginMessage?: ToUi }>) => {
  const m = e.data.pluginMessage
  if (!m) return
  if (m.type === 'settings') {
    state.settings = m.settings
    render()
    return
  }
  for (const k of KEYS) {
    const s = m[k]
    if (!s) {
      state[k] = { value: state[k].value, orig: null, id: null }
      state.sourceIds[k] = null
      continue
    }
    // The same layer keeps its original color so Reset still works after canvas edits.
    const same = state.sourceIds[k] === s.id && state[k].orig !== null
    state[k] = { value: s.hex, orig: same ? state[k].orig : s.hex, id: s.writable ? s.id : null }
    state.sourceIds[k] = s.id
  }
  state.opacity = m.fg ? m.fg.opacity : 1
  state.fontSize = m.fontSize
  state.bold = m.bold
  state.nodeName = m.nodeName
  $('status').textContent = statusText(m, m.fg, m.bg)
  render()
}
render()
