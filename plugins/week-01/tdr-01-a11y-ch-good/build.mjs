// Bundles src/main.ts into code.js and src/ui.ts into ui.html (ui.template.html
// with the Figma UI kit CSS and the UI script inlined: the plugin has no network access).
import { build } from 'esbuild'
import { readFileSync, writeFileSync, watch } from 'node:fs'

async function run() {
  await build({ entryPoints: ['src/main.ts'], outfile: 'code.js', bundle: true, format: 'iife', target: 'es2018' })
  const ui = await build({ entryPoints: ['src/ui.ts'], write: false, bundle: true, format: 'iife', target: 'es2018', minify: true })
  const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  const css = readFileSync('node_modules/figma-plugin-ds/dist/figma-plugin-ds.css', 'utf8')
  const html = readFileSync('ui.template.html', 'utf8')
    .replace('/*FIGMA_PLUGIN_DS*/', () => css)
    .replace('/*UI_SCRIPT*/', () => script)
  writeFileSync('ui.html', html)
}

await run()
if (process.argv.includes('--watch')) {
  let timer
  const rebuild = () => {
    clearTimeout(timer)
    timer = setTimeout(() => run().catch((e) => console.error(e.message)), 50)
  }
  watch('src', rebuild)
  watch('ui.template.html', rebuild)
  console.log('watching…')
}
