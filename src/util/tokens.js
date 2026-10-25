// ~4 characters per token is the usual rule of thumb for English and code.
// It's an estimate, not a tokenizer: good enough to rank waste, not to bill by.
export const estimateTokens = (text) => (text ? Math.ceil(text.length / 4) : 0);

// Images are billed by pixel area (w×h/750), after being scaled down to at
// most 1568px on the long edge and ~1.15MP. Read the size from the PNG/JPEG
// header; fall back to a mid-size screenshot when we can't.
const FALLBACK_IMAGE_TOKENS = 600;

function imageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xc2) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function imageTokens(base64) {
  const size = typeof base64 === 'string' && imageSize(Buffer.from(base64.slice(0, 80_000), 'base64'));
  if (!size || !size[0] || !size[1]) return FALLBACK_IMAGE_TOKENS;
  const [w, h] = size;
  const scale = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1.15e6 / (w * h)));
  return Math.ceil((w * scale * h * scale) / 750);
}
