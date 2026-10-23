# A11y Contrast Checker (Figma plugin)

Проверяет контраст текста, иконок и границ полей по WCAG 2.x (AA / AAA), показывает APCA справочно и исправляет нарушения в один клик. Работает офлайн.

## Команды
- `npm install`
- `npm run build` — собирает `contrast.ts` и `code.ts` в `code.js`
- `npm run watch`
- `npm test` — юнит-тесты цветовой математики
- `npm run lint`

## Запуск в Figma
Plugins → Development → Import plugin from manifest… → `manifest.json` из этой папки.

## Файлы
- `contrast.ts` — чистая математика (WCAG, APCA, подбор цвета)
- `code.ts` — работа с документом Figma
- `ui.html` — интерфейс (RU / EN)
- `fr-a11y.md` — функциональные требования и статус
