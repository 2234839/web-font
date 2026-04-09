import { For } from "solid-js";

interface FontSelectorProps {
  fonts: Array<{ name: string; dir: string }>;
  selectedFont: string;
  onFontChange: (font: string) => void;
}

interface OutTypeSelectorProps {
  supportedOutTypes: ("woff2" | "ttf")[];
  outType: "woff2" | "ttf";
  onOutTypeChange: (type: "woff2" | "ttf") => void;
}

const outTypeLabels: Record<string, string> = {
  woff2: "WOFF2 体积更小",
  ttf: "TTF 速度更快",
};

const outTypeDescs: Record<string, string> = {
  woff2: "约压缩 50%，适合生产",
  ttf: "无编码开销，适合开发",
};

const s = {
  wrap: {
    display: "flex",
    gap: "12px",
  } as const,
  col: {
    flex: 1,
  } as const,
  label: {
    display: "block",
    "font-size": "13px",
    color: "#555",
    "margin-bottom": "6px",
  } as const,
  select: {
    width: "100%",
    padding: "8px 12px",
    "font-size": "14px",
    border: "1px solid #d9d9d9",
    "border-radius": "6px",
    outline: "none",
    "box-sizing": "border-box",
    cursor: "pointer",
    appearance: "none",
    "background-image": "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")",
    "background-repeat": "no-repeat",
    "background-position": "right 10px center",
    "padding-right": "28px",
  } as const,
  desc: {
    "font-size": "11px",
    color: "#bbb",
    "margin-top": "4px",
  } as const,
};

export function FontSelector(props: FontSelectorProps) {
  return (
    <div style={s.col}>
      <label style={s.label}>选择字体</label>
      <select
        style={s.select}
        value={props.selectedFont}
        onChange={(e) => props.onFontChange(e.target.value)}
      >
        <option value="">-- 请选择 --</option>
        <For each={props.fonts}>
          {(f) => (
            <option value={f.name}>
              {f.name}
            </option>
          )}
        </For>
      </select>
    </div>
  );
}

export function OutTypeSelector(props: OutTypeSelectorProps) {
  return (
    <div style={{ width: "160px" }}>
      <label style={s.label}>输出格式</label>
      <select
        style={s.select}
        value={props.outType}
        onChange={(e) => props.onOutTypeChange(e.target.value as "woff2" | "ttf")}
      >
        <For each={props.supportedOutTypes}>
          {(t) => (
            <option value={t}>{outTypeLabels[t]}</option>
          )}
        </For>
      </select>
      <p style={s.desc}>{outTypeDescs[props.outType]}</p>
    </div>
  );
}

export function SelectorRow(props: FontSelectorProps & OutTypeSelectorProps) {
  return (
    <div style={s.wrap}>
      <FontSelector
        fonts={props.fonts}
        selectedFont={props.selectedFont}
        onFontChange={props.onFontChange}
      />
      <OutTypeSelector
        supportedOutTypes={props.supportedOutTypes}
        outType={props.outType}
        onOutTypeChange={props.onOutTypeChange}
      />
    </div>
  );
}
