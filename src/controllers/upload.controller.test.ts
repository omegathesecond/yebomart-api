/**
 * Tests for the image-upload fail-loud contract.
 *
 * The workspace "no silent fallbacks" rule: when R2 (the object store) is not
 * configured, the upload endpoint must return a 5xx — it must NEVER dress the
 * misconfiguration up as success by returning a multi-MB `data:...;base64,...`
 * URL (which then gets persisted as the product's imageUrl and hides the
 * broken deploy).
 *
 * R2 config is captured at module-load time, so we re-import the controller
 * under a controlled env via vi.resetModules() to make the assertion
 * deterministic regardless of the ambient shell's R2_* vars.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of R2_KEYS) savedEnv[k] = process.env[k];

async function loadControllerWithoutR2() {
  vi.resetModules();
  for (const k of R2_KEYS) delete process.env[k];
  return import('./upload.controller');
}

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  res.send = () => res;
  return res;
}

afterEach(() => {
  for (const k of R2_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('uploadImage — fails loud when R2 is unconfigured', () => {
  it('returns a 500 (not a base64 data-URL success) when R2 creds are absent', async () => {
    const { uploadImage } = await loadControllerWithoutR2();

    const req: any = {
      file: {
        originalname: 'logo.png',
        mimetype: 'image/png',
        buffer: Buffer.from('fake-image-bytes'),
      },
    };
    const res = mockRes();

    await uploadImage(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/R2.*not configured/i);
    // The old silent fallback returned { success: true, data: { url: 'data:...base64,...' } }.
    // None of that may be present.
    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('base64');
  });

  it('still 400s when no file is attached', async () => {
    const { uploadImage } = await loadControllerWithoutR2();
    const req: any = {};
    const res = mockRes();

    await uploadImage(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
