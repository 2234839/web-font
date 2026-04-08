import { createSignal, Show } from "solid-js";
import { uploadFont, type UploadResult, type ServerConfig } from "./api";

const ACCEPT = ".ttf,.otf,.woff,.woff2";

const btn = {
  padding: "6px 20px",
  "font-size": "14px",
  border: "1px solid #d9d9d9",
  "border-radius": "6px",
  cursor: "pointer",
  background: "#fff",
  color: "#333",
} as const;

const card = {
  padding: "16px",
  border: "1px solid #e8e8e8",
  "border-radius": "8px",
  "margin-bottom": "16px",
} as const;

const label = {
  display: "block",
  "font-size": "13px",
  color: "#555",
  "margin-bottom": "6px",
} as const;

const input = {
  padding: "6px 12px",
  "font-size": "14px",
  border: "1px solid #d9d9d9",
  "border-radius": "6px",
  outline: "none",
  "box-sizing": "border-box",
} as const;

const section = {
  "margin-bottom": "28px",
} as const;

/** 通用文件上传行：选择文件 + 文件名 + 上传按钮 */
function FileUploader(props: {
  accept?: string;
  disabled?: boolean;
  uploading?: boolean;
  onFileSelect: (file: File) => void;
  fileName: string | undefined;
  onUpload: () => void;
}) {
  return (
    <div style={{ display: "flex", "gap": "8px", "align-items": "center" }}>
      <label style={{ ...btn, display: "inline-flex", "align-items": "center", cursor: "pointer" }}>
        选择文件
        <input
          type="file"
          accept={props.accept ?? ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && props.onFileSelect(e.target.files[0])}
        />
      </label>
      <span style={{ "font-size": "13px", color: "#666" }}>
        {props.fileName ?? "未选择文件"}
      </span>
      <button
        style={{ ...btn, opacity: !props.disabled && !props.uploading ? 1 : 0.5, cursor: !props.disabled && !props.uploading ? "pointer" : "not-allowed" }}
        disabled={props.disabled || props.uploading}
        onClick={props.onUpload}
      >
        {props.uploading ? "..." : "上传"}
      </button>
    </div>
  );
}

function useUpload(onSuccess: () => void) {
  const [file, set_file] = createSignal<File | null>(null);
  const [apiKey, set_apiKey] = createSignal("");
  const [uploading, set_uploading] = createSignal(false);
  const [msg, set_msg] = createSignal<{ ok: boolean; text: string } | null>(null);

  function showMsg(ok: boolean, text: string) {
    set_msg({ ok, text });
    setTimeout(() => set_msg(null), 3000);
  }

  async function upload(mode: "temp" | "admin", key?: string) {
    const f = file();
    if (!f) return;
    set_uploading(true);
    const result: UploadResult = await uploadFont(f, mode, key);
    set_uploading(false);
    if (result.success) {
      showMsg(true, "上传成功");
      set_file(null);
      onSuccess();
    } else {
      showMsg(false, result.error ?? "上传失败");
    }
  }

  return { file, set_file, apiKey, set_apiKey, uploading, msg, showMsg, upload };
}

/** 游客上传区域 */
function TempUploadCard(props: {
  uploading: boolean;
  msg: { ok: boolean; text: string } | null;
  onFileSelect: (file: File) => void;
  fileName: string | undefined;
  onUpload: () => void;
}) {
  return (
    <div style={card}>
      <div style={{ "font-size": "14px", "font-weight": 500, "margin-bottom": "4px" }}>游客上传</div>
      <div style={{ "font-size": "12px", color: "#999", "margin-bottom": "12px" }}>
        临时文件，最多保留 10 个，超出后自动删除最早上传的
      </div>
      <FileUploader
        disabled={!props.fileName}
        uploading={props.uploading}
        onFileSelect={props.onFileSelect}
        fileName={props.fileName}
        onUpload={props.onUpload}
      />
    </div>
  );
}

/** 管理员上传区域 */
function AdminUploadCard(props: {
  uploading: boolean;
  msg: { ok: boolean; text: string } | null;
  apiKey: string;
  onApiKeyInput: (value: string) => void;
  onFileSelect: (file: File) => void;
  fileName: string | undefined;
  onUpload: () => void;
}) {
  return (
    <div style={card}>
      <div style={{ "font-size": "14px", "font-weight": 500, "margin-bottom": "4px" }}>管理员上传</div>
      <div style={{ "font-size": "12px", color: "#999", "margin-bottom": "12px" }}>
        永久保存，需要 API Key 认证
      </div>
      <input
        type="text"
        autocomplete="off"
        style={{ ...input, width: "100%", "margin-bottom": "10px" }}
        value={props.apiKey}
        onInput={(e) => props.onApiKeyInput(e.target.value)}
        placeholder="API Key"
      />
      <FileUploader
        disabled={!props.fileName || !props.apiKey}
        uploading={props.uploading}
        onFileSelect={props.onFileSelect}
        fileName={props.fileName}
        onUpload={props.onUpload}
      />
    </div>
  );
}

export default function UploadSection(props: { config: ServerConfig; onUploaded: () => void }) {
  const temp = useUpload(props.onUploaded);
  const admin = useUpload(props.onUploaded);

  const canUpload = () => props.config.enableTempUpload || props.config.adminUploadEnabled;

  return (
    <Show when={canUpload()}>
      <section style={section}>
        <label style={{ ...label, "font-size": "14px", "font-weight": 500, "margin-bottom": "12px" }}>上传字体</label>

        <Show when={temp.msg()}>
          {(m) => (
            <div
              style={{
                padding: "8px 12px",
                "margin-bottom": "12px",
                "border-radius": "6px",
                "font-size": "13px",
                background: m().ok ? "#f0faf0" : "#fef2f2",
                color: m().ok ? "#166534" : "#b91c1c",
                border: `1px solid ${m().ok ? "#bbf7d0" : "#fecaca"}`,
              }}
            >
              {m().text}
            </div>
          )}
        </Show>

        <Show when={props.config.enableTempUpload}>
          <TempUploadCard
            uploading={temp.uploading()}
            msg={temp.msg()}
            onFileSelect={(f) => temp.set_file(f)}
            fileName={temp.file()?.name}
            onUpload={() => temp.upload("temp")}
          />
        </Show>

        <Show when={props.config.adminUploadEnabled}>
          <AdminUploadCard
            uploading={admin.uploading()}
            msg={admin.msg()}
            apiKey={admin.apiKey()}
            onApiKeyInput={(v) => admin.set_apiKey(v)}
            onFileSelect={(f) => admin.set_file(f)}
            fileName={admin.file()?.name}
            onUpload={() => admin.upload("admin", admin.apiKey())}
          />
        </Show>
      </section>
    </Show>
  );
}
