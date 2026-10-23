const eslint = require('@eslint/js')
const tseslint = require('typescript-eslint')
const figmaPlugin = require('@figma/eslint-plugin-figma-plugins')

module.exports = tseslint.config(
  eslint.configs.recommended,
  // @typescript-eslint/recommended-type-checked is too aggressive for
  // widget code...it doesn't seem to like JSX element return values or
  // unbundling the `widget` object for use* hooks. So we'll use
  // tseslint.configs.recommended instead.
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    plugins: {
      '@figma/figma-plugins': figmaPlugin,
    },
    rules: {
      ...figmaPlugin.configs.recommended.rules,
      // allow underscore-prefixing of unused variables
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // contrast.ts is a global script shared with code.ts via outFile, so its
    // functions look unused to a per-file check.
    files: ['contrast.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    ignores: ['code.js', 'dist', 'eslint.config.js', 'test'],
  },
)
