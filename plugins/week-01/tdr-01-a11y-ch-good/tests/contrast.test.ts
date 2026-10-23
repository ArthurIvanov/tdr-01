import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blend, contrast, findLightness, isLargeText, lightnessOf, thresholds, toHex, parseHex, withLightness,
} from '../src/contrast.ts'

test('black on white is 21:1', () => {
  assert.ok(Math.abs(contrast('#000000', '#FFFFFF') - 21) < 1e-9)
})

test('#767676 on white is the AA boundary for text', () => {
  const ratio = contrast('#767676', '#FFFFFF')
  assert.ok(ratio >= 4.5 && ratio < 4.6)
  assert.ok(contrast('#777777', '#FFFFFF') < 4.5)
})

test('contrast is symmetric', () => {
  assert.equal(contrast('#336699', '#FFEEDD'), contrast('#FFEEDD', '#336699'))
})

test('blend composites alpha over the background', () => {
  assert.equal(blend('#000000', '#FFFFFF', 0.5), '#808080')
  assert.equal(blend('#123456', '#FFFFFF', 1), '#123456')
})

test('thresholds per kind', () => {
  assert.deepEqual(thresholds('text'), [4.5, 7])
  assert.deepEqual(thresholds('large'), [3, 4.5])
  assert.deepEqual(thresholds('ui'), [3, 3])
})

test('large text is 24px, or 18.66px bold', () => {
  assert.ok(isLargeText(24, false))
  assert.ok(!isLargeText(18.66, false))
  assert.ok(isLargeText(18.66, true))
  assert.ok(!isLargeText(16, true))
})

test('lightness is 0 for black, 100 for white', () => {
  assert.equal(lightnessOf('#000000'), 0)
  assert.equal(lightnessOf('#FFFFFF'), 100)
})

test('withLightness keeps the requested lightness within rounding', () => {
  for (const hex of ['#3366CC', '#CC3333', '#33CC66', '#888888']) {
    for (const l of [20, 50, 80]) {
      assert.ok(Math.abs(lightnessOf(withLightness(hex, l)) - l) <= 2, `${hex} @ ${l}`)
    }
  }
})

test('withLightness always yields a valid hex', () => {
  for (let l = 0; l <= 100; l += 5) assert.match(withLightness('#FF00AA', l), /^#[0-9A-F]{6}$/)
})

test('toHex and parseHex round-trip', () => {
  assert.equal(toHex(parseHex('#0A1B2C')), '#0A1B2C')
})

test('findLightness reaches the target, or reports impossible', () => {
  const l = findLightness('#999999', '#FFFFFF', 1, 4.5)
  assert.notEqual(l, null)
  assert.ok(contrast(withLightness('#999999', l!), '#FFFFFF') >= 4.5)
  assert.equal(findLightness('#999999', '#808080', 1, 21), null)
})
