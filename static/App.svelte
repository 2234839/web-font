<script>
  import { writable } from 'svelte/store';
  import { get_font, get_font_list,server } from './req';
  /** 可用的字体列表  {id:number,name:string:selected:undefined | boolen,css:undefined|string}*/
  $: font_list = [];
  get_font_list().then(r => {
    font_list = r.map(ttf => ({ name: ttf.replace(/\.ttf$/, '') }));
  });
  /** 选择的文字 */
  let text = '';
  /** 用于测试动态生成接口 */
  let generate_fonts_dynamically=`<style>
      @font-face {
              font-family: "test";
              src:
                  url("${location.pathname}generate_fonts_dynamically.ttf?temp=true&font=优设标题黑&text=优设标题黑(直接改这里和前面的字体名看效果)") format("truetype");
              font-style: normal;
              font-weight: normal;
          }
      }
</style>`
  $: selected_font = font_list.filter(font => font.selected);
  function generate_font() {
    selected_font.forEach(font => {
      get_font(font.name, text)
        .then(r => {
          r=r.replace(/\/\/.*?\//g,server)

          const family = r.match(/font-family: "(.*)"/)[1];
          font.css = r;
          font.family = family;
          font.zip=server+r.match(/(asset\/font\/\d+\/)/)[0]+'asset.zip'
          /** 因为要触发其他更新则必须对这个变量重新赋值 */
          font_list = font_list;
        })
        .catch(e => {
          console.log(e);
        });
    });
  }
  function copy(str) {
    var input = document.getElementById("copy_box");
    input.value=str
    input.focus();
    input.setSelectionRange(0, -1); // 全选
    document.execCommand("copy")
    alert(`复制成功\n${str}`)
  }
</script>

{#each font_list as font, i}
  {@html "<style>"+font.css+'.'+font.name+"{font-family:"+font.family+"}</style>"}
{/each}
<h1 class="text-lg text-center mb-3 font-bold">web font 字体裁剪工具</h1>
<textarea id="copy_box" class="w-0 h-0 fixed -m-24" />
<div class="flex justify-evenly">
  <textarea
    bind:value={text}
    class="border flex-1 m-1"
    placeholder="在此输入需要提取的文字"
    cols="40"
    rows="3" />
  <div class="flex-1 m-1 flex flex-wrap">
    {#each font_list as font, i}
      <div
        on:click={e => (font.selected = !font.selected)}
        class="c-label {font.selected ? 'c-label-selected' : ''}
        {font.name}">
        {font.name}
      </div>
    {/each}
  </div>
</div>

<div class="flex">
  <div on:click={generate_font}  class="bg-red-200 text-red-600 rounded-md px-1 hover:bg-red-400 hover:text-white duration-75">
    生成字体
  </div>
</div>

{#each selected_font as font, i}
  <div class={font.name}>
    <div style="font-size:2rem">{text}</div>
    <div class="flex justify-end items-center text-xs">
      {#if font.css}
        <a class="text-blue-400 underline" href="/{font.zip}">下载压缩资源</a>
        <div  class="c-label mx-1 text-xs" on:click={copy(font.css)}>复制css</div>
      {/if}

      <div>{font.name}</div>
    </div>
  </div>
{/each}


<h2 class="text-lg text-center my-3  font-bold"> 动态生成字体（generate_fonts_dynamically 接口）</h2>
<p>使用如下的方式引入，则可以直接使用</p>
<textarea
  bind:value={generate_fonts_dynamically}
  class="border flex-1 m-1 w-full text-lg"
  placeholder="在此输入需要提取的文字"
  rows="13"
  style="font-family:test;" />
{@html generate_fonts_dynamically}


