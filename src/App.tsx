import { createMemo, createSignal } from "solid-js";

function App() {
  const [text, set_text] = createSignal("天地无极，乾坤借法");

  const serverPath = import.meta.env.DEV ? "/" : "https://webfont.shenzilong.cn/";
  const style = createMemo(
    () => `
  @font-face {
    font-family: "CustomFont";
    src: url("${serverPath}api?font=令东齐伋复刻体.ttf&text=${text()}") format("truetype");
    font-weight: normal;
    font-style: normal;
  }
  input {
    color: red;
    font-family: "CustomFont";
  }
`,
  );
  return (
    <div>
      <h1>
        <a href="https://github.com/2234839/web-font">web font</a>{" "}
      </h1>
      <div>
        <div>在下面输入文本查看效果</div>
        <input
          style={{ "font-size": "46px", "margin-top": "3px" }}
          value={text()}
          onInput={(e) => set_text(e.target.value)}
        />
      </div>

      <pre>{"<style>" + style() + "</style>"}</pre>
      <style>{style()}</style>
    </div>
  );
}

export default App;
