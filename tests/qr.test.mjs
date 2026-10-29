import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

test('二维码能被独立解码器还原为HTTPS配对地址，令牌只在fragment', () => {
  const link = 'https://jobs-device-info.example.workers.dev/#pair=' + 'ab'.repeat(32);
  const qr = QRCode.create(link, { errorCorrectionLevel: 'M' });
  const scale = 5;
  const quiet = 4;
  const pixels = (qr.modules.size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(pixels * pixels * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y++) {
    for (let x = 0; x < qr.modules.size; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const offset = (((y + quiet) * scale + sy) * pixels + (x + quiet) * scale + sx) * 4;
          rgba[offset] = 23;
          rgba[offset + 1] = 57;
          rgba[offset + 2] = 45;
        }
      }
    }
  }
  const decoded = jsQR(rgba, pixels, pixels);
  assert.equal(decoded?.data, link);
  const url = new URL(decoded.data);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.search, '');
  assert.match(url.hash, /^#pair=[a-f0-9]{64}$/);
  assert.equal(/UDID|IMEI/i.test(url.href), false);
});
