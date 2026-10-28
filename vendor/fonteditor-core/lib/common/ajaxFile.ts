/**
 * @file ajax获取文本数据
 * @author mengke01(kekee000@gmail.com)
 */

/** ajax 请求参数选项 */
interface AjaxFileOptions {
  /** 响应数据类型：binary（ArrayBuffer）/ xml（Document）/ json / 纯文本（默认） */
  type?: string;
  /** 请求方法，默认 GET */
  method?: string;
  /** 成功回调，入参为按 type 解析后的数据 */
  onSuccess?: (data: any) => void;
  /** 失败回调 */
  onError?: (xhr: XMLHttpRequest, status: number) => void;
  /** 参数集合，GET 时拼接为 query 串 */
  params?: Record<string, unknown>;
  /** 请求地址（GET 带 params 时会被就地追加 query 串） */
  url: string;
}

/** 携带旧浏览器二进制响应字段 responseBlob 的 XHR 形状 */
interface XhrWithResponseBlob extends XMLHttpRequest {
  /** 旧实现（IE 系）的二进制响应字段 */
  responseBlob?: any;
}

/**
 * ajax获取数据
 */
function ajaxFile(options: AjaxFileOptions): void {
  const xhr: XhrWithResponseBlob = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) {
      const status = xhr.status;
      if ((status >= 200 && status < 300) || status === 304) {
        if (options.onSuccess) {
          if (options.type === 'binary') {
            const buffer = xhr.responseBlob || xhr.response;
            options.onSuccess(buffer);
          } else if (options.type === 'xml') {
            options.onSuccess(xhr.responseXML);
          } else if (options.type === 'json') {
            options.onSuccess(JSON.parse(xhr.responseText));
          } else {
            options.onSuccess(xhr.responseText);
          }
        }
      } else if (options.onError) {
        options.onError(xhr, xhr.status);
      }
    }
  };
  const method = (options.method || 'GET').toUpperCase();
  let params: string | null = null;
  if (options.params) {
    const str: string[] = [];
    Object.keys(options.params).forEach(function (key) {
      str.push(key + '=' + encodeURIComponent(String(options.params![key])));
    });
    const query = str.join('&');
    if (method === 'GET') {
      options.url += (options.url.indexOf('?') === -1 ? '?' : '&') + query;
    } else {
      params = query;
    }
  }
  xhr.open(method, options.url, true);
  if (options.type === 'binary') {
    xhr.responseType = 'arraybuffer';
  }
  xhr.send(params);
}

/**
 * 加载文件，默认以二进制方式返回
 */
function loadFile(url: string, type: string = 'binary'): Promise<any> {
  return new Promise(function (resolve, reject) {
    ajaxFile({
      type: type,
      url: url,
      onSuccess: function (buffer) {
        resolve(buffer);
      },
      onError: function (e) {
        reject(e);
      }
    });
  });
}

export default ajaxFile;
export { loadFile };
