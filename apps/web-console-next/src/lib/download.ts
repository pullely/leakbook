// LB3: fetch a binary the API serves (the inspection PDF, the CSV) with the
// session's bearer token and hand it to the browser as a file. The SDK's
// transport decodes JSON envelopes only, so downloads go through here.

export async function downloadWithAuth(
  baseUrl: string,
  token: string | null,
  path: string,
  filename: string,
): Promise<{ ok: true; sha256: string | null } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    return { ok: false, message: "Network error" };
  }
  if (!res.ok) return { ok: false, message: `The download failed (${res.status})` };
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { ok: true, sha256: res.headers.get("x-content-sha256") };
}
