import { defineConfig } from 'tsdown'

export default [
  /** ESM + d.ts —— npm 包主产物（leafer 插件 / bundler 用户） */
  defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    dts: true,
    clean: true,
    outDir: 'dist',
    platform: 'browser',
  }),
  /** IIFE —— 构建为 public/webfont-sdk.js（script 标签直引，全局 WebFont） */
  defineConfig({
    entry: ['src/iife.ts'],
    format: 'iife',
    globalName: 'WebFontBundle',
    clean: false,
    outDir: 'dist-iife',
    platform: 'browser',
    minify: false,
  }),
]
