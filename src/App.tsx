import { createMemo, createSignal, type Accessor } from "solid-js";

function App() {
  const [text, set_text] = createSignal("天地无极，乾坤借法");

  // const serverPath = import.meta.env.DEV ? "/" : "https://webfont.shenzilong.cn/";
  const serverPath = "/";
  const style = createMemo(
    () => `
  @font-face {
    font-family: "CustomFont";
    src: url("${serverPath}api?font=令东齐伋复刻体.ttf&text=${text()}") format("truetype");
  }
  input {
    color: red;
    font-family: "CustomFont";
  }
`,
  );
  const throttledSetMemo = useThrottledMemo(() => style(), 1000);
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
        <div>{text()}</div>
      </div>

      <pre>{"<style>" + style() + "</style>"}</pre>
      <style>{throttledSetMemo()}</style>
    </div>
  );
}

export default App;

function useThrottledMemo<T>(fn: () => T, delay: number): Accessor<T> {
  const [throttledValue, setThrottledValue] = createSignal<T>(fn());
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  createMemo(() => {
    const value = fn();
    if (timeoutId === null) {
      // @ts-expect-error
      setThrottledValue(value);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        // @ts-expect-error
        setThrottledValue(fn());
      }, delay);
    }
  });

  return throttledValue;
}
