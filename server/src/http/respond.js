// Small HTTP helpers: JSON responses, CORS, and a size-capped JSON body reader.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The API is public and cookie-less, so any origin may call it (e.g. the client opened from
// VS Code Live Server on another port talking to this server).
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

export function sendJson(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json), // bytes, not characters ("привіт".length !== bytes)
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
    ...headers,
  });
  res.end(json);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/**
 * Reads a JSON request body, refusing anything over maxBytes.
 * The request is a Readable stream; we stop reading (and drop the connection) as soon as the
 * limit is crossed instead of buffering an attacker's 1 GB body.
 */
export async function readJsonBody(req, maxBytes) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json'))
    throw new HttpError(415, 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new HttpError(413, `body larger than ${maxBytes} bytes`);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      throw new HttpError(413, `body larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}
