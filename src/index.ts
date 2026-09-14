interface Env {
  IMAGES: R2Bucket;
  PRIMG_TOKEN: string;
}

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_BODY_SIZE = MAX_FILE_SIZE + 64 * 1024;
const KEY_PATTERN = /^[a-f0-9]{32}\.(png|jpg|webp)$/;

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// Identify bytes ourselves; neither the filename nor the supplied MIME is trusted.
function imageType(bytes: Uint8Array): { mime: string; extension: string } | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16))) {
    return { mime: 'image/webp', extension: 'webp' };
  }
}

async function upload(request: Request, env: Env): Promise<Response> {
  if (!env.PRIMG_TOKEN) return error(503, 'Upload token is not configured');
  if (request.headers.get('Authorization') !== `Bearer ${env.PRIMG_TOKEN}`) {
    return error(401, 'Invalid or missing bearer token');
  }
  if (!/^multipart\/form-data\s*;/i.test(request.headers.get('Content-Type') ?? '')) {
    return error(415, 'Expected multipart/form-data with one file field');
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_SIZE) {
    return error(413, 'File exceeds the 20 MiB limit');
  }
  if (!request.body) return error(400, 'Missing request body');

  // Bound actual bytes before multipart parsing, including chunked requests.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let form: FormData;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_SIZE) {
        await reader.cancel();
        return error(413, 'File exceeds the 20 MiB limit');
      }
      chunks.push(value);
    }
    form = await new Response(new Blob(chunks), {
      headers: { 'Content-Type': request.headers.get('Content-Type')! },
    }).formData();
  } catch {
    return error(400, 'Malformed multipart request');
  } finally {
    reader.releaseLock();
  }
  const entries = [...form.entries()];
  const file = form.get('file');
  if (entries.length !== 1 || !(file instanceof File)) {
    return error(400, 'Provide exactly one file in the file field');
  }
  if (file.size > MAX_FILE_SIZE) return error(413, 'File exceeds the 20 MiB limit');
  const type = imageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!type || file.type !== type.mime) {
    return error(415, 'Expected PNG, JPEG, or WebP with a matching Content-Type');
  }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `${id}.${type.extension}`;
  await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: type.mime } });
  return Response.json({ url: `${new URL(request.url).origin}/f/${key}` }, { status: 201 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/upload') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        }
        return await upload(request, env);
      }
      const key = path.startsWith('/f/') ? path.slice(3) : '';
      if (!KEY_PATTERN.test(key)) return error(404, 'Not found');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      const object = await env.IMAGES.get(key);
      if (!object) return error(404, 'Not found');
      const headers = new Headers({
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(object.size),
        ETag: object.httpEtag,
      });
      object.writeHttpMetadata(headers);
      return new Response(request.method === 'HEAD' ? null : object.body, { headers });
    } catch {
      return error(500, 'Storage request failed; try again');
    }
  },
} satisfies ExportedHandler<Env>;
