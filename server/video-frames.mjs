import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const run = promisify(execFile);
export async function videoFrames(file) {
  const dir = await mkdtemp(join(tmpdir(), 'material-frames-'));
  try {
    const path = join(dir, 'source');
    await writeFile(path, file.bytes);
    const args = [
      '-nostdin',
      '-hide_banner',
      '-protocol_whitelist',
      'file,pipe',
      '-f',
      file.contentType === 'video/webm' ? 'matroska' : 'mov',
      '-threads',
      '1',
    ];
    const options = {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
    };
    let duration = 0;
    try {
      await run(ffmpeg.path, [...args, '-i', path], options);
    } catch (e) {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(String(e.stderr));
      if (m) duration = 3600 * Number(m[1]) + 60 * Number(m[2]) + Number(m[3]);
    }
    const count = Math.max(1, Math.min(12, Math.ceil(duration / 5))),
      frames = [];
    for (let i = 0; i < count; i++) {
      const seconds = +((i * duration) / count).toFixed(2);
      const { stdout } = await run(
        ffmpeg.path,
        [
          ...args,
          '-ss',
          String(seconds),
          '-i',
          path,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1280,iw)':-2",
          '-f',
          'image2pipe',
          '-vcodec',
          'mjpeg',
          'pipe:1',
        ],
        options,
      );
      if (stdout.length) frames.push({ seconds, bytes: stdout });
    }
    if (!frames.length) throw Error('视频没有可读取的画面');
    return frames;
  } catch {
    throw Error('无法解码视频画面，请检查原文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
