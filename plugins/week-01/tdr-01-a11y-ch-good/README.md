# A11y Contrast Checker (Figma plugin)

Проверка контраста в Figma. Работает офлайн.

## Сборка
`code.js` и `ui.html` — сборочные артефакты, в git их нет. Перед запуском в Figma:

- `npm install`
- `npm run build` — собирает `src/main.ts` в `code.js` и `src/ui.ts` + `ui.template.html` в `ui.html`
- `npm run watch`
- `npm run typecheck`
- `npm test`
- `npm run lint`

## Запуск в Figma
Plugins → Development → Import plugin from manifest… → `manifest.json` из этой папки.

## Структура
- `src/contrast.ts` — цветовая математика
- `src/main.ts` — работа с документом Figma
- `src/ui.ts`, `ui.template.html` — интерфейс
- `src/messages.ts` — типы сообщений между UI и main
- `tests/` — юнит-тесты
