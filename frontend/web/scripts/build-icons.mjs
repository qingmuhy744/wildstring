import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const root = new URL('../public/', import.meta.url);
const source = await readFile(new URL('favicon.svg', root), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pngs = await page.evaluate(
    async ({ source, sizes }) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
      await image.decode();
      return sizes.map((size) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        if (pixels[3] !== 0 || !pixels.some((value, index) => index % 4 === 3 && value > 0))
          throw new Error(`Icon alpha check failed at ${size}px`);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    },
    { source, sizes },
  );
  const frames = pngs.map((png) => Buffer.from(png, 'base64'));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const start = 6 + index * 16;
    header[start] = header[start + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, start + 4);
    header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(frame.length, start + 8);
    header.writeUInt32LE(offset, start + 12);
    offset += frame.length;
  });
  await writeFile(new URL('favicon.ico', root), Buffer.concat([header, ...frames]));
  process.stdout.write(`Transparent ICO generated: ${sizes.join(', ')} px\n`);
} finally {
  await browser.close();
}
