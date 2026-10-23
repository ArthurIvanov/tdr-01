// Unit tests for contrast.ts. The file is a plain global script, so it is
// transpiled with the TypeScript API and evaluated in a vm context.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const src = fs.readFileSync(path.join(__dirname, '..', 'contrast.ts'), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { target: 'es2020' } }).outputText
const ctx = vm.createContext({})
vm.runInContext(js + '\nthis.api = { contrastRatio, blend, toHex, isLargeText, requiredRatio, apcaLc, searchShift, WHITE, BLACK }', ctx)
const api = ctx.api

const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 })
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`)

// Reference values from the WCAG 2.x definition / common calculators.
const PAIRS = [
  ['#000000', '#FFFFFF', 21],
  ['#FFFFFF', '#FFFFFF', 1],
  ['#767676', '#FFFFFF', 4.54],
  ['#777777', '#FFFFFF', 4.48],
  ['#0000FF', '#FFFFFF', 8.59],
  ['#FF0000', '#FFFFFF', 4.0],
  ['#808080', '#FFFFFF', 3.95],
  ['#595959', '#FFFFFF', 7.0],
  ['#000000', '#FFFF00', 19.56],
  ['#1A73E8', '#FFFFFF', 4.5],
]
for (const [a, b, expected] of PAIRS) {
  test(`ratio ${a} on ${b}`, () => {
    near(api.contrastRatio(hex(a), hex(b)), expected, 0.01)
    near(api.contrastRatio(hex(b), hex(a)), expected, 0.01)
  })
}

test('thresholds per level', () => {
  assert.equal(api.requiredRatio('AA', false), 4.5)
  assert.equal(api.requiredRatio('AA', true), 3)
  assert.equal(api.requiredRatio('AAA', false), 7)
  assert.equal(api.requiredRatio('AAA', true), 4.5)
})

test('large text rule', () => {
  assert.equal(api.isLargeText(24, 400), true)
  assert.equal(api.isLargeText(18.66, 700), true)
  assert.equal(api.isLargeText(18.66, 400), false)
  assert.equal(api.isLargeText(16, 700), false)
})

test('blend', () => {
  const c = api.blend(api.BLACK, 0.5, api.WHITE)
  near(c.r, 0.5, 1e-9)
  assert.equal(api.toHex(c), '#808080')
})

test('APCA reference values', () => {
  near(api.apcaLc(api.BLACK, api.WHITE), 106.04, 0.5)
  near(api.apcaLc(api.WHITE, api.BLACK), -107.88, 0.5)
  assert.equal(api.apcaLc(hex('#888888'), hex('#888888')), 0)
})

test('searchShift reaches goal and keeps it minimal', () => {
  const bg = api.WHITE
  const ratioOf = (c) => api.contrastRatio(c, bg)
  const light = hex('#99AABB')
  const fixed = api.searchShift(light, ratioOf, 4.51)
  assert.ok(fixed)
  assert.ok(ratioOf(fixed) >= 4.51)
  assert.ok(ratioOf(fixed) < 4.6)
})

test('searchShift returns null when unreachable', () => {
  assert.equal(api.searchShift(hex('#888888'), () => 2, 4.5), null)
})
