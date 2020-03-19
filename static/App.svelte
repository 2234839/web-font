<script>
  import { writable } from 'svelte/store';
  import { get_font,get_font_list } from './req';
  /** 可用的字体列表  {id:number,name:string:selected:undefined | boolen,css:undefined|string}*/
  $: font_list =[  ]
  get_font_list().then(r=>{
    font_list=r.map(ttf=>({name:ttf.replace(/\.ttf$/,'')}))
  })
  /** 选择的文字 */
  let text = '';
  $: selected_font = font_list.filter(font => font.selected);
  function generate_font() {
    selected_font.forEach(font => {
      get_font(font.name, text)
        .then(r => {
          const family = r.match(/font-family: "(.*)"/)[1]
          font.css = r;
          font.family=family
          /** 因为要触发其他更新则必须对这个变量重新赋值 */
          font_list=font_list
        })
        .catch(e => {
          console.log(e);
        });
    });
  }
</script>

<style>
  .c-label {
    @apply border m-1 rounded-md px-1 items-center h-6 text-sm;
  }
  .c-label-selected {
    @apply bg-red-600 text-white;
  }
</style>

<div class=" flex justify-evenly">
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
        class="c-label {font.selected ? 'c-label-selected' : ''}">
        {font.name}
      </div>
    {/each}
  </div>
</div>

<div on:click={generate_font}>生成字体</div>

{#each selected_font as font, i}
  <div class={font.name}>
    <div style="font-family:{font.family};font-size:2rem">{text}</div>
    <div style="font-size:.6rem;text-align: right;">{font.name}</div>
  </div>
{/each}

{#each font_list as font, i}
  {@html `<style>${font.css}</style>`}
{/each}