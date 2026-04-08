/**
 * 轻量 multipart/form-data 解析器，不依赖外部库
 */
export interface MultipartFile {
  /** 表单字段名 */
  name: string;
  /** 原始文件名 */
  filename: string;
  /** 文件二进制数据 */
  data: Uint8Array;
}

export interface MultipartParseResult {
  files: MultipartFile[];
}

export function parseMultipart(contentType: string, body: ArrayBuffer): MultipartParseResult {
  if (!body || body.byteLength === 0) {
    return { files: [] };
  }

  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) throw new Error("No boundary found");
  const boundary = boundaryMatch[1].replace(/^"(.*)"$/, "$1");

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const bodyBytes = new Uint8Array(body);
  const delimiter = encoder.encode("\r\n--" + boundary);

  /** 在字节数组中查找子串位置 */
  function findBytes(haystack: Uint8Array, needle: Uint8Array, offset: number): number {
    for (let i = offset; i <= haystack.length - needle.length; i++) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }

  const files: MultipartFile[] = [];

  // 跳过起始边界 "--boundary\r\n"
  const startBoundary = encoder.encode("--" + boundary + "\r\n");
  let pos = 0;
  const sbPos = findBytes(bodyBytes, startBoundary, pos);
  if (sbPos === -1) throw new Error("Invalid multipart: no start boundary");
  pos = sbPos + startBoundary.length;

  while (pos < bodyBytes.length) {
    // 查找 headers 和 body 的分界 "\r\n\r\n"
    const headerEnd = findBytes(bodyBytes, encoder.encode("\r\n\r\n"), pos);
    if (headerEnd === -1) break;

    const headerText = decoder.decode(bodyBytes.slice(pos, headerEnd));
    const bodyStart = headerEnd + 4;

    // 查找下一个 boundary
    const nextBoundary = findBytes(bodyBytes, delimiter, bodyStart);
    if (nextBoundary === -1) break;

    // part body 去掉末尾的 "\r\n"
    const partBody = bodyBytes.slice(bodyStart, nextBoundary);
    const actualBody = partBody.length >= 2 && partBody[partBody.length - 1] === 10 && partBody[partBody.length - 2] === 13
      ? partBody.slice(0, partBody.length - 2)
      : partBody;

    // 从 Content-Disposition 中解析字段名和文件名
    const nameMatch = headerText.match(/name="([^"]*)"/);
    const filenameMatch = headerText.match(/filename="([^"]*)"/);

    if (nameMatch) {
      files.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1] ?? "",
        data: actualBody,
      });
    }

    pos = nextBoundary + delimiter.length;

    // 检查 boundary 后面是否紧跟 "--"（结束标记）
    if (pos + 2 <= bodyBytes.length && bodyBytes[pos] === 45 && bodyBytes[pos + 1] === 45) {
      break;
    }
    // 跳过 boundary 后的 "\r\n"
    if (pos < bodyBytes.length && bodyBytes[pos] === 13 && bodyBytes[pos + 1] === 10) {
      pos += 2;
    }
  }

  return { files };
}
