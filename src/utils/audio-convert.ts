import * as fs from "node:fs";
import * as path from "node:path";
import { decode, isSilk } from "silk-wasm";
import { SILK_SAMPLE_RATE } from "../constants.js";

/** 最大允许的输入文件大小（10 MB），防止 OOM */
const MAX_AUDIO_FILE_SIZE = 10 * 1024 * 1024;

/** WASM 解码超时（毫秒） */
const DECODE_TIMEOUT_MS = 30_000;

/**
 * 将 PCM (s16le) 数据封装为 WAV 文件格式
 */
function pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

/**
 * 去除 QQ 语音文件的 AMR 头（如果存在）
 */
function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/**
 * 将 SILK/AMR 语音文件转换为 WAV 格式
 */
export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  // 异步检查文件存在性和大小
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(inputPath);
  } catch {
    return null;
  }

  if (stat.size > MAX_AUDIO_FILE_SIZE) {
    console.warn(`[audio-convert] file too large: ${inputPath} (${stat.size} bytes, max ${MAX_AUDIO_FILE_SIZE})`);
    return null;
  }

  if (stat.size === 0) {
    console.warn(`[audio-convert] empty file: ${inputPath}`);
    return null;
  }

  const fileBuf = await fs.promises.readFile(inputPath);
  const strippedBuf = stripAmrHeader(fileBuf);
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  if (!isSilk(rawData)) {
    return null;
  }

  const sampleRate = SILK_SAMPLE_RATE;
  let result: { data: Uint8Array; duration: number };
  try {
    result = await Promise.race([
      decode(rawData, sampleRate),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("WASM decode timeout")), DECODE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    console.warn(`[audio-convert] decode failed for ${inputPath}:`, err);
    return null;
  }

  const wavBuffer = pcmToWav(result.data, sampleRate);

  const dir = outputDir || path.dirname(inputPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  await fs.promises.writeFile(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}
