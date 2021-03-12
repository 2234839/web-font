<template>
  <h1 class="text-4xl mt-4 mb-3">
    <img class="h-14" src="/2021.png" alt="logo" />
    web font 字体裁剪工具 (<a href="https://github.com/cellbang/malagu"
      >serverless</a
    >s版)
  </h1>
  <label class="flex w-full">
    <span class="w-1/3 flex-shrink-0">使用该字体的文字：</span>
    <input type="text" v-model="text" class="flex-1" />
  </label>
  <label class="flex w-full">
    <span class="w-1/3 flex-shrink-0">选择使用的字体：</span>
    <select v-model="font" class="flex-1">
      <option :value="item" v-for="item in fontList">{{ item }}</option>
    </select>
  </label>
  <label class="flex w-full">
    <span class="w-1/3 flex-shrink-0">选择字体类型：</span>
    <select v-model="type" class="flex-1">
      <option value="" class="text-sm">
        *ttf 与 woff 兼容性要好一些，eoc与svg仅靠下面的css可能还不够
      </option>
      <option :value="item" v-for="item in Object.keys(ttfFormatMap)">
        {{ item }}
      </option>
    </select>
  </label>

  <div class="flex flex-col w-full px-4">
    <span class="text-sm mt-4 self-start">
      *你可以直接 copy 下面的 css 去使用,打开浏览器的 devTools
      查看字体文件的体积
    </span>
    <textarea v-model="cssCode" disabled :cols="20" :rows="16" class="w-full" />
  </div>

  <footer>
    <a
      class="mr-2"
      v-for="item in [
        {
          href: 'https://github.com/2234839/web-font/tree/serverless',
          text: 'github repo',
        },
        {
          href: 'https://shenzilong.cn',
          text: '作者：崮生',
        },
      ]"
      :href="item.href"
      >{{ item.text }}</a
    >
  </footer>
  <div v-html="style" />
</template>

<script lang="ts">
  import { computed, defineComponent, ref } from "vue";
  import { Api } from "./api";
  import { serverUrl } from "./config";

  const ttfFormatMap = {
    ttf: "truetype",
    eot: "",
    svg: "",
    woff: "woff",
  };
  export default defineComponent({
    name: "App",
    setup() {
      console.log("[process]", serverUrl);
      console.log("[Api]", Api);

      const text = ref("千图小兔体webfont字体裁剪工具(serverless版)");

      const font = ref("千图小兔体.ttf");
      const fontList = ref<string[]>([]);
      Api.api.font_list().then((r) => {
        fontList.value = r;
      });

      const temp = ref("true");
      const type = ref<keyof typeof ttfFormatMap>("ttf");
      const cssCode = computed(
        () => `* { font-family: test}\n
  @font-face {
    font-family: "test";
    src: url("${serverUrl}/api/generate_fonts_dynamically?text=${text.value.trim()}&font=${
          font.value
        }&temp=${temp.value}&type=${type.value}")
     ;
    font-style: normal;
    font-weight: normal;
  }`,
      );
      const style = computed(() => `<style>${cssCode.value}</style>`);
      return { cssCode, ttfFormatMap, style, text, font, fontList, temp, type };
    },
  });
</script>

<style>
  #app {
    text-align: center;
    color: #2c3e50;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  #app,
  textarea,
  input {
    @apply md:text-xl;
  }
</style>
