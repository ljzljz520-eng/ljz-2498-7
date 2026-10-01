async function req(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'X-User-Id': localStorage.userId || '1' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}
export const api = {
  get: (p) => req(p),
  post: (p, body) => req(p, { method: 'POST', body }),
};
