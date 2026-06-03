/**
 * FFmpeg 抽帧工具模块
 *
 * 提供视频帧提取、ffmpeg 可用性检查、视频时长获取等功能。
 * 用于 video-frame-extractor 服务端的视频处理流水线。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 在指定时间戳提取视频的单帧图像
 * @param {string} videoPath - 视频文件路径
 * @param {number} timestamp - 时间戳（秒，浮点数）
 * @param {string} outputPath - 输出图像文件路径
 * @returns {Promise<void>} 成功时 resolve，失败时 reject 并包含 stderr 信息
 */
export async function extractFrameAtTimestamp(videoPath, timestamp, outputPath) {
  const formattedTimestamp = timestamp.toFixed(1);

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', formattedTimestamp,
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      outputPath
    ], { timeout: 10000 });
  } catch (err) {
    const message = err.stderr || err.message || 'Unknown ffmpeg error';
    throw new Error(`Failed to extract frame at ${formattedTimestamp}s: ${message}`);
  }
}

/**
 * 检查 ffmpeg 是否在系统中可用
 * @returns {Promise<boolean>} 可用返回 true，不可用返回 false
 */
export async function checkFfmpegAvailable() {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取视频文件的时长（秒）
 * @param {string} videoPath - 视频文件路径
 * @returns {Promise<number>} 视频时长（秒，浮点数）
 */
export async function getVideoDuration(videoPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);

    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error(`Unable to parse duration from ffprobe output: "${stdout.trim()}"`);
    }
    return duration;
  } catch (err) {
    if (err.message && err.message.startsWith('Unable to parse')) {
      throw err;
    }
    const message = err.stderr || err.message || 'Unknown ffprobe error';
    throw new Error(`Failed to get video duration: ${message}`);
  }
}
