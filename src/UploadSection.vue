<script setup lang="ts">
import { ref, computed } from "vue";
import { uploadFont, type UploadResult, type ServerConfig } from "./api";

const ACCEPT = ".ttf,.otf,.woff,.woff2";
const UPLOAD_TIP = "支持 .ttf 和 .otf 格式，建议上传 .ttf 字体文件以获得最佳兼容性";

const props = defineProps<{
  config: ServerConfig;
  onUploaded: () => void;
}>();

function useUpload(onSuccess: () => void) {
  const file = ref<File | null>(null);
  const apiKey = ref("");
  const uploading = ref(false);
  const msg = ref<{ ok: boolean; text: string } | null>(null);

  function showMsg(ok: boolean, text: string) {
    msg.value = { ok, text };
    setTimeout(() => { msg.value = null; }, 3000);
  }

  async function upload(mode: "temp" | "admin", key?: string) {
    const f = file.value;
    if (!f) return;
    uploading.value = true;
    const result: UploadResult = await uploadFont(f, mode, key);
    uploading.value = false;
    if (result.success) {
      showMsg(true, "上传成功");
      file.value = null;
      onSuccess();
    } else {
      showMsg(false, result.error ?? "上传失败");
    }
  }

  return { file, apiKey, uploading, msg, upload };
}

const temp = useUpload(() => props.onUploaded());
const admin = useUpload(() => props.onUploaded());
const canUpload = computed(() => props.config.enableTempUpload || props.config.adminUploadEnabled);

function onFileSelect(e: Event, target: ReturnType<typeof useUpload>) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) target.file.value = f;
}
</script>

<template>
  <section v-if="canUpload" style="margin-bottom: 28px">
    <label style="display: block; font-size: 14px; font-weight: 500; margin-bottom: 12px">上传字体</label>
    <div style="font-size: 12px; color: #e6a700; margin-bottom: 12px">{{ UPLOAD_TIP }}</div>

    <div
      v-if="temp.msg.value"
      :style="{
        padding: '8px 12px',
        marginBottom: '12px',
        borderRadius: '6px',
        fontSize: '13px',
        background: temp.msg.value.ok ? '#f0faf0' : '#fef2f2',
        color: temp.msg.value.ok ? '#166534' : '#b91c1c',
        border: `1px solid ${temp.msg.value.ok ? '#bbf7d0' : '#fecaca'}`,
      }"
    >
      {{ temp.msg.value.text }}
    </div>

    <div v-if="config.enableTempUpload" style="padding: 16px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 16px">
      <div style="font-size: 14px; font-weight: 500; margin-bottom: 4px">游客上传</div>
      <div style="font-size: 12px; color: #999; margin-bottom: 12px">临时文件，最多保留 10 个，总大小限制 200MB，超出后自动删除最早上传的</div>
      <div style="display: flex; gap: 8px; align-items: center">
        <label style="padding: 6px 20px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333; display: inline-flex; align-items: center">
          选择文件
          <input type="file" :accept="ACCEPT" style="display: none" @change="onFileSelect($event, temp)" />
        </label>
        <span style="font-size: 13px; color: #666">{{ temp.file.value?.name ?? '未选择文件' }}</span>
        <button
          :disabled="!temp.file.value || temp.uploading.value"
          :style="{ padding: '6px 20px', fontSize: '14px', border: '1px solid #d9d9d9', borderRadius: '6px', cursor: temp.file.value && !temp.uploading.value ? 'pointer' : 'not-allowed', background: '#fff', color: '#333', opacity: temp.file.value && !temp.uploading.value ? 1 : 0.5 }"
          @click="temp.upload('temp')"
        >
          {{ temp.uploading.value ? '...' : '上传' }}
        </button>
      </div>
    </div>

    <div v-if="config.adminUploadEnabled" style="padding: 16px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 16px">
      <div style="font-size: 14px; font-weight: 500; margin-bottom: 4px">管理员上传</div>
      <div style="font-size: 12px; color: #999; margin-bottom: 12px">永久保存，需要 API Key 认证</div>
      <input
        type="text"
        autocomplete="off"
        v-model="admin.apiKey.value"
        placeholder="API Key"
        style="padding: 6px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; box-sizing: border-box; width: 100%; margin-bottom: 10px"
      />
      <div style="display: flex; gap: 8px; align-items: center">
        <label style="padding: 6px 20px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333; display: inline-flex; align-items: center">
          选择文件
          <input type="file" :accept="ACCEPT" style="display: none" @change="onFileSelect($event, admin)" />
        </label>
        <span style="font-size: 13px; color: #666">{{ admin.file.value?.name ?? '未选择文件' }}</span>
        <button
          :disabled="!admin.file.value || !admin.apiKey.value || admin.uploading.value"
          :style="{ padding: '6px 20px', fontSize: '14px', border: '1px solid #d9d9d9', borderRadius: '6px', cursor: admin.file.value && admin.apiKey.value && !admin.uploading.value ? 'pointer' : 'not-allowed', background: '#fff', color: '#333', opacity: admin.file.value && admin.apiKey.value && !admin.uploading.value ? 1 : 0.5 }"
          @click="admin.upload('admin', admin.apiKey.value)"
        >
          {{ admin.uploading.value ? '...' : '上传' }}
        </button>
      </div>
    </div>
  </section>
</template>
