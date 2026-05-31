import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

export interface WritePixQrArtifactsInput {
  outputDir: string;
  pixCode: string;
  fileBaseName?: string;
}

export interface PixQrArtifactFiles {
  pixCodePath: string;
  qrPngPath: string;
}

export async function writePixQrArtifacts(input: WritePixQrArtifactsInput): Promise<PixQrArtifactFiles> {
  const fileBaseName = input.fileBaseName ?? 'pix';
  await mkdir(input.outputDir, { recursive: true });

  const pixCodePath = path.join(input.outputDir, `${fileBaseName}-code.txt`);
  const qrPngPath = path.join(input.outputDir, `${fileBaseName}-qrcode.png`);
  const png = await QRCode.toBuffer(input.pixCode, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8,
  });

  await writeFile(pixCodePath, `${input.pixCode}\n`, 'utf8');
  await writeFile(qrPngPath, png);

  return {
    pixCodePath,
    qrPngPath,
  };
}
