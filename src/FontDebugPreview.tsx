import { createSignal, onMount, onCleanup, For } from "solid-js";
import type { FontInfo } from "./api";

const PREVIEW_TEXT = `天地无极乾坤借法：“”:"" 0123456789 ABCDEF`;

const s = {
  section: {
    "margin-bottom": "28px",
    padding: "16px",
    border: "2px dashed #e6a700",
    "border-radius": "8px",
    background: "#fffdf5",
  } as const,
  card: {
    "margin-bottom": "12px",
    padding: "8px 12px",
    background: "#fff",
    border: "1px solid #e8e8e8",
    "border-radius": "6px",
  } as const,
  row: {
    "margin-bottom": "4px",
    display: "flex",
    "align-items": "baseline",
    gap: "8px",
  } as const,
  label: {
    "font-size": "11px",
    color: "#bbb",
    "min-width": "40px",
    flex: "none",
  } as const,
  text: {
    "font-size": "22px",
    "line-height": "1.5",
    color: "#1a1a1a",
    "min-height": "36px",
  } as const,
};

export default function FontDebugPreview() {
  const [fonts, set_fonts] = createSignal<FontInfo[]>([]);
  const loaders = new Map<string, { update: (text: string) => void; dispose: () => void }>();

  onMount(async () => {
    const res = await fetch("/api/fonts");
    const fontList: FontInfo[] = await res.json();
    const usableFonts = fontList.filter((f) => /\.(ttf|otf)$/i.test(f.name));
    set_fonts(usableFonts);

    for (const font of usableFonts) {
      const base = font.name.replace(/\.[^.]+$/, "");
      for (const ot of ["woff2", "ttf"] as const) {
        const family = `DevPreview_${base}_${ot}`;
        const loader = (globalThis as any).WebFont?.loadText({
          fontName: font.name,
          text: PREVIEW_TEXT,
          family,
          outType: ot,
        });
        if (loader) loaders.set(`${font.name}|${ot}`, loader);
      }
    }
  });

  onCleanup(() => {
    for (const loader of loaders.values()) loader.dispose();
    loaders.clear();
  });

  return (
    <section style={s.section}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "12px" }}>
        <span style={{ "font-size": "13px", "font-weight": 600, color: "#e6a700" }}>DEV 字体调试预览</span>
        <span style={{ "font-size": "11px", color: "#aaa" }}>所有字体的 woff2 / ttf 渲染效果</span>
      </div>
      <For each={fonts()}>
        {(font) => {
          const base = font.name.replace(/\.[^.]+$/, "");
          return (
            <div style={s.card}>
              <div style={{ "font-size": "11px", color: "#999", "margin-bottom": "6px", display: "flex", "justify-content": "space-between" }}>
                <span style={{ "font-weight": 500, color: "#555" }}>{font.name}</span>
                <span style={{ color: "#bbb" }}>{font.dir}</span>
              </div>
              <For each={["woff2", "ttf"] as const}>
                {(ot) => (
                  <div style={s.row}>
                    <span style={s.label}>{ot}</span>
                    <div
                      style={{
                        ...s.text,
                        "font-family": `"DevPreview_${base}_${ot}", "楷体", KaiTi, STKaiti, serif`,
                      }}
                    >
                      {PREVIEW_TEXT}
                    </div>
                  </div>
                )}
              </For>
            </div>
          );
        }}
      </For>
    </section>
  );
}
