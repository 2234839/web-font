import { defineConfig } from 'tsdown'

export default [
  /** ESM + d.ts —— npm 包产物（bundler 用户 / CLI 工程） */
  defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    dts: true,
    clean: true,
    outDir: 'dist',
    platform: 'neutral',
  }),
  /**
   * 单文件 ESM bundle（webfont-sdk 引擎内联）—— uni_modules 产物源。
   * 插件市场不支持 npm 依赖，必须自包含
   */
  defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    clean: false,
    outDir: 'dist-bundle',
    platform: 'neutral',
    dts: false,
    /**
     * 全部内联：uni_modules 里没有 node_modules（本包仅依赖 webfont-sdk）。
     * 不用 true：tsdown 0.22 deps 插件在 boolean 时报 pattern 空串错误
     */
    noExternal: [/./],
  }),
  /** iife —— HBuilderX 非 CLI 工程经 script 引入，挂全局 UniWebFontBundle */
  defineConfig({
    entry: ['src/index.ts'],
    format: 'iife',
    globalName: 'UniWebFontBundle',
    clean: false,
    outDir: 'dist-bundle',
    platform: 'neutral',
    dts: false,
    /** 全部内联（同上，正则形式避开 tsdown boolean bug） */
    noExternal: [/./],
  }),
]
