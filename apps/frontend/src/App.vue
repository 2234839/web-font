<template>
  <h1>
    web font 字体裁剪工具 (<a href="https://github.com/cellbang/malagu"
      >serverless版</a
    >)
  </h1>
  <label style="display: flex; width: 100%">
    <span style="width: 30%; flex-shrink: 0">使用该字体的文字：</span>
    <input type="text" v-model="text" style="flex: 1" />
  </label>
  <label style="display: flex; width: 100%">
    <span style="width: 30%; flex-shrink: 0">选择使用的字体：</span>
    <input disabled type="text" v-model="font" style="flex: 1" />
  </label>
  <label style="display: flex; width: 100%">
    <span style="width: 30%; flex-shrink: 0">选择字体类型：</span>
    <input disabled type="text" v-model="type" style="flex: 1" />
  </label>

  <span>你可以直接 copy 下面的 css 去使用</span>
  <textarea
    v-model="cssCode"
    disabled
    :cols="20"
    :rows="16"
    style="width: 95%; font-family: test"
  />

  <footer>
    <a href="https://github.com/2234839/web-font/tree/serverless"
      >github repo</a
    >
  </footer>
  <div v-html="style" />
</template>

<script lang="ts">
  import { computed, defineComponent, ref } from "vue";

  export default defineComponent({
    name: "App",
    setup() {
      const text = ref("千图小兔体webfont字体裁剪工具(serverless版)");
      const font = ref("千图小兔体.ttf");
      const temp = ref("true");
      const type = ref("ttf");
      const cssCode = computed(
        () => `* { font-family: test}\n
@font-face {
  font-family: "test";
  src: url("http://webfontserverless.shenzilong.cn/api/generate_fonts_dynamically?text=${text.value.trim()}&font=${
          font.value
        }&temp=${temp.value}&type=${type.value}")
    format("truetype");
  font-style: normal;
  font-weight: normal;
}`,
      );
      const style = computed(() => `<style>${cssCode.value}</style>`);
      return { cssCode, style, text, font, temp, type };
    },
  });

  const defaultCssCode = ``;
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
    font-size: 1.3em;
  }
</style>
