/** WOFF2 编码器：裸 sfnt 字节（ttf 或 otf）→ WOFF2 字节。
 *  对 glyf/loca 做 transform，其余表（含 CFF）按普通表 brotli 压缩。 */
export function encodeTTFToWOFF2(sfntBuffer: Uint8Array): Uint8Array;
