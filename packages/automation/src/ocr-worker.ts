import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Worker } from 'tesseract.js';
import { PNG } from 'pngjs';
import type { OcrLine } from './registration-types.js';

export async function runOcrWorker() {
  process.umask(0o077);
  let worker: Worker | undefined;
  let phase = 'INPUT';
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > 14500000) throw Error();
    }
    const input = JSON.parse(raw) as { toolsRoot: string; image: string };
    if (typeof input.toolsRoot !== 'string' || typeof input.image !== 'string') throw Error();
    const image = Buffer.from(input.image, 'base64');
    if (
      image.length > 10485760 ||
      image.length < 45 ||
      image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      image.readUInt32BE(16) > 4096 ||
      image.readUInt32BE(20) > 4096
    )
      throw Error();
    PNG.sync.read(image, { checkCRC: true });
    const require = createRequire(join(resolve(input.toolsRoot), 'package.json'));
    const engine = require('tesseract.js') as typeof import('tesseract.js');
    const langPath = join(process.cwd(), 'ocr-languages');
    await mkdir(langPath, { recursive: true, mode: 0o700 });
    phase = 'MODELS';
    for (const code of ['eng', 'chi_sim']) {
      const data = require('@tesseract.js-data/' + code) as { langPath: string };
      const bytes = await readFile(
        join(data.langPath, '..', '4.0.0_best_int', code + '.traineddata.gz'),
      );
      await writeFile(join(langPath, code + '.traineddata.gz'), bytes, { mode: 0o600 });
    }
    // An explicit local language directory disables the library's default CDN path.
    phase = 'INITIALIZATION';
    worker = await engine.createWorker(['eng', 'chi_sim'], 1, {
      langPath,
      gzip: true,
      cacheMethod: 'none',
      logger: () => {},
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: engine.PSM.SPARSE_TEXT });
    phase = 'RECOGNITION';
    const result = await worker.recognize(image, {}, { blocks: true, text: false });
    const lines: OcrLine[] = [];
    for (const block of result.data.blocks ?? [])
      for (const paragraph of block.paragraphs)
        for (const line of paragraph.lines) {
          if (lines.length >= 2000) throw Error();
          if (line.text.length <= 200)
            lines.push({
              text: line.text.trim(),
              confidence: line.confidence,
              rect: {
                x: line.bbox.x0,
                y: line.bbox.y0,
                width: line.bbox.x1 - line.bbox.x0,
                height: line.bbox.y1 - line.bbox.y0,
              },
            });
        }
    await new Promise<void>((r) => process.stdout.write(JSON.stringify({ lines }), () => r()));
  } catch {
    process.exitCode = 1;
    await new Promise<void>((r) =>
      process.stdout.write(JSON.stringify({ error: 'OCR_' + phase + '_FAILED' }), () => r()),
    );
  } finally {
    await worker?.terminate().catch(() => {});
    process.exit(process.exitCode ?? 0);
  }
}
if (process.argv[2] === '--ocr-job') void runOcrWorker();
