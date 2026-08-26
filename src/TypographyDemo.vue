<script setup lang="ts">
/** Before/After Typography Demo — 同一内容，只有字体不同 */

import { onMounted } from "vue"
import { t } from "./i18n"

const props = defineProps<{ onBack: () => void }>()

declare global {
  interface Window {
    WebFont?: {
      observeFont: (options: {
        fontName: string
        selector: string
        family: string
        outType?: string
      }) => { dispose: () => void }
    }
  }
}

onMounted(() => {
  if (!window.WebFont) return

  window.WebFont.observeFont({
    fontName: "令东齐伋复刻体.ttf",
    selector: ".demo-after .zh-font",
    family: "ZenSerif",
    outType: "ttf",
  })
})
</script>

<template>
  <div style="min-height: 100vh">
    <!-- 顶部导航 -->
    <div style="position: sticky; top: 0; z-index: 100; background: rgba(255,255,255,0.95); backdrop-filter: blur(8px); border-bottom: 1px solid #eee; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center">
      <button @click="props.onBack" style="padding: 6px 16px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; font-size: 14px">
        {{ t('back') }}
      </button>
      <span style="font-size: 13px; color: #888">{{ t('demoSlogan') }} · <a href="https://github.com/2234839/web-font/blob/new/skills/chinese-web-font.md" target="_blank" style="color: #8b7355; text-decoration: none">{{ t('viewSkillLink') }}</a></span>
    </div>

    <div style="display: flex; min-height: calc(100vh - 49px)">

      <!-- ===== Before ===== -->
      <div style="flex: 1; overflow-y: auto; border-right: 2px solid #eee; background: #fff">
        <div style="display: inline-block; padding: 4px 12px; background: #f5f5f5; color: #999; font-size: 12px; border-radius: 4px; margin: 16px; font-family: -apple-system, sans-serif">
          {{ t('beforeLabel') }}
        </div>

        <!-- Hero -->
        <div style="position: relative; padding: 120px 32px 80px; text-align: center; overflow: hidden">
          <div style="font-family: sans-serif; font-size: 200px; font-weight: 700; color: rgba(0,0,0,0.04); position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); white-space: nowrap; pointer-events: none; line-height: 1">
            静心
          </div>
          <h1 style="font-family: sans-serif; font-size: 48px; font-weight: 600; color: #2c2c2c; margin: 0; line-height: 1.3">
            静心茶舍
          </h1>
          <p style="font-family: sans-serif; font-size: 18px; color: #888; margin: 24px 0 0; letter-spacing: 0.1em">
            以茶为媒 · 静心观自在
          </p>
        </div>

        <!-- 内容区 -->
        <div style="padding: 0 48px 80px">
          <h2 style="font-family: sans-serif; font-size: 24px; font-weight: 600; margin: 48px 0 20px; color: #3a3a3a">
            一叶知秋
          </h2>
          <p style="font-family: sans-serif; font-size: 16px; line-height: 1.8; color: #4a4a4a; text-indent: 2em">
            山间晨露未晞，茶人已入林深处。指尖轻捻，择其嫩芽一二，置于竹篮之中。此乃一年之始，亦是一叶与万物的初遇。
          </p>

          <h2 style="font-family: sans-serif; font-size: 24px; font-weight: 600; margin: 48px 0 20px; color: #3a3a3a">
            茶之六味
          </h2>
          <p style="font-family: sans-serif; font-size: 16px; line-height: 1.8; color: #4a4a4a; text-indent: 2em">
            甘、苦、涩、鲜、酸、咸——茶之六味，恰似人生六境。
          </p>

          <!-- 引用 -->
          <div style="margin: 48px 0; padding: 32px; background: #f7f7f5; border-radius: 8px; text-align: center">
            <p style="font-family: sans-serif; font-size: 20px; color: #666; line-height: 1.8; margin: 0">
              茶不过一仰一俯之间，<br>然天地之大，尽在一盏之中。
            </p>
          </div>

          <!-- CTA -->
          <div style="text-align: center; margin-top: 64px">
            <span style="display: inline-block; padding: 14px 48px; border: 1px solid #8b7355; color: #8b7355; font-size: 15px; letter-spacing: 0.1em; border-radius: 4px">
              预约品茗
            </span>
          </div>
        </div>
      </div>

      <!-- ===== After ===== -->
      <div class="demo-after" style="flex: 1; overflow-y: auto; background: #fff">
        <div style="display: inline-block; padding: 4px 12px; background: #8b7355; color: #fff; font-size: 12px; border-radius: 4px; margin: 16px; font-family: -apple-system, sans-serif">
          {{ t('afterLabel') }}
        </div>

        <!-- Hero -->
        <div style="position: relative; padding: 120px 32px 80px; text-align: center; overflow: hidden">
          <div class="zh-font" style="font-family: 'ZenSerif', 'Noto Serif CJK SC', 'STSong', serif; font-size: 200px; font-weight: 600; color: rgba(139,115,85,0.08); position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); white-space: nowrap; pointer-events: none; line-height: 1; letter-spacing: 0.05em">
            静心
          </div>
          <h1 class="zh-font" style="font-family: 'ZenSerif', 'Noto Serif CJK SC', 'STSong', serif; font-size: 48px; font-weight: 600; color: #2c2c2c; margin: 0; line-height: 1.3; letter-spacing: 0.08em">
            静心茶舍
          </h1>
          <p class="zh-font" style="font-family: 'ZenSerif', 'Noto Serif CJK SC', 'STSong', serif; font-size: 18px; color: #888; margin: 24px 0 0; letter-spacing: 0.12em">
            以茶为媒 · 静心观自在
          </p>
        </div>

        <!-- 内容区 -->
        <div style="padding: 0 48px 80px">
          <h2 class="zh-font" style="font-family: 'ZenSerif', 'Noto Serif CJK SC', 'STSong', serif; font-size: 24px; font-weight: 600; margin: 48px 0 20px; color: #3a3a3a; letter-spacing: 0.06em">
            一叶知秋
          </h2>
          <p style="font-family: sans-serif; font-size: 16px; line-height: 1.8; color: #4a4a4a; text-indent: 2em">
            山间晨露未晞，茶人已入林深处。指尖轻捻，择其嫩芽一二，置于竹篮之中。此乃一年之始，亦是一叶与万物的初遇。
          </p>

          <h2 class="zh-font" style="font-family: 'ZenSerif', 'Noto Serif CJK SC', 'STSong', serif; font-size: 24px; font-weight: 600; margin: 48px 0 20px; color: #3a3a3a; letter-spacing: 0.06em">
            茶之六味
          </h2>
          <p style="font-family: sans-serif; font-size: 16px; line-height: 1.8; color: #4a4a4a; text-indent: 2em">
            甘、苦、涩、鲜、酸、咸——茶之六味，恰似人生六境。
          </p>

          <!-- 引用 -->
          <div style="margin: 48px 0; padding: 32px; background: rgba(196,181,160,0.1); border-radius: 8px; text-align: center">
            <p class="zh-font" style="font-family: 'ZenSerif', 'Noto Serif CJK SC', 'STSong', serif; font-size: 20px; color: #666; line-height: 1.8; margin: 0; letter-spacing: 0.05em">
              茶不过一仰一俯之间，<br>然天地之大，尽在一盏之中。
            </p>
          </div>

          <!-- CTA -->
          <div style="text-align: center; margin-top: 64px">
            <span class="zh-font" style="display: inline-block; padding: 14px 48px; border: 1px solid #8b7355; color: #8b7355; font-size: 15px; letter-spacing: 0.15em; border-radius: 4px; font-family: 'ZenSerif', serif">
              预约品茗
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
