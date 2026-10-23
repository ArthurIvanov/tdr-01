import type { Level } from './contrast.ts'

export type SizeMode = 'auto' | 'normal' | 'large'

export interface Settings {
  level: Level
  size: SizeMode
}

export interface Source {
  id: string
  name: string
  hex: string
  opacity: number
  /** Bound to a style or variable: writing a color detaches it. */
  bound: 'style' | 'variable' | null
  /** False when the shown color is a blend of several layers. */
  writable: boolean
}

export type Note = 'gradient-fg' | 'gradient-bg' | 'no-fg' | null

export type ToUi =
  | {
      type: 'selection'
      fg: Source | null
      bg: Source | null
      fontSize: number | null
      bold: boolean
      nodeName: string | null
      note: Note
    }
  | { type: 'settings'; settings: Settings }

export type ToMain =
  | { type: 'apply'; nodeId: string; hex: string }
  | { type: 'commit' }
  | { type: 'settings'; settings: Settings }
