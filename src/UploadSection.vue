<script setup lang="ts">
import { ref, computed } from "vue";
import { uploadFont, type UploadResult, type ServerConfig } from "./api";
import { t } from "./i18n";

const ACCEPT = ".ttf,.otf,.woff,.woff2";

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
      showMsg(true, t("uploadSuccess"));
      file.value = null;
      onSuccess();
    } else {
      showMsg(false, result.error ?? t("uploadFailed"));
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
    <label style="display: block; font-size: 14px; font-weight: 500; margin-bottom: 12px">{{ t('uploadFont') }}</label>
    <div style="font-size: 12px; color: #e6a700; margin-bottom: 8px">{{ t('uploadTip') }}</div>
    <div style="
      font-size: 12px;
      color: #b91c1c;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 12px;
    ">{{ t('uploadWarning') }}</div>

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
      <div style="font-size: 14px; font-weight: 500; margin-bottom: 4px">{{ t('guestUpload') }}</div>
      <div style="font-size: 12px; color: #999; margin-bottom: 12px">
        {{ t('guestUploadDesc') }}
        <span v-if="config.tempRetentionHours" style="color: #1677ff">
          （保留时限 {{ config.tempRetentionHours }} 小时）
        </span>
      </div>
      <div style="display: flex; gap: 8px; align-items: center">
        <label style="padding: 6px 20px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333; display: inline-flex; align-items: center">
          {{ t('selectFile') }}
          <input type="file" :accept="ACCEPT" style="display: none" @change="onFileSelect($event, temp)" />
        </label>
        <span style="font-size: 13px; color: #666">{{ temp.file.value?.name ?? t('noFile') }}</span>
        <button
          :disabled="!temp.file.value || temp.uploading.value"
          :style="{ padding: '6px 20px', fontSize: '14px', border: '1px solid #d9d9d9', borderRadius: '6px', cursor: temp.file.value && !temp.uploading.value ? 'pointer' : 'not-allowed', background: '#fff', color: '#333', opacity: temp.file.value && !temp.uploading.value ? 1 : 0.5 }"
          @click="temp.upload('temp')"
        >
          {{ temp.uploading.value ? '...' : t('upload') }}
        </button>
      </div>
    </div>

    <div v-if="config.adminUploadEnabled" style="padding: 16px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 16px">
      <div style="font-size: 14px; font-weight: 500; margin-bottom: 4px">{{ t('adminUpload') }}</div>
      <div style="font-size: 12px; color: #999; margin-bottom: 12px">{{ t('adminUploadDesc') }}</div>
      <input
        type="text"
        autocomplete="off"
        v-model="admin.apiKey.value"
        placeholder="API Key"
        style="padding: 6px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; box-sizing: border-box; width: 100%; margin-bottom: 10px"
      />
      <div style="display: flex; gap: 8px; align-items: center">
        <label style="padding: 6px 20px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333; display: inline-flex; align-items: center">
          {{ t('selectFile') }}
          <input type="file" :accept="ACCEPT" style="display: none" @change="onFileSelect($event, admin)" />
        </label>
        <span style="font-size: 13px; color: #666">{{ admin.file.value?.name ?? t('noFile') }}</span>
        <button
          :disabled="!admin.file.value || !admin.apiKey.value || admin.uploading.value"
          :style="{ padding: '6px 20px', fontSize: '14px', border: '1px solid #d9d9d9', borderRadius: '6px', cursor: admin.file.value && admin.apiKey.value && !admin.uploading.value ? 'pointer' : 'not-allowed', background: '#fff', color: '#333', opacity: admin.file.value && admin.apiKey.value && !admin.uploading.value ? 1 : 0.5 }"
          @click="admin.upload('admin', admin.apiKey.value)"
        >
          {{ admin.uploading.value ? '...' : t('upload') }}
        </button>
      </div>
    </div>
  </section>
</template>
