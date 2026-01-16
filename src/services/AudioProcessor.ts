import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { nanoid } from 'nanoid';

export interface ProcessedAudio {
  id: string;
  title: string;
  duration: number;
  files: {
    stereo: string;
    left: string;
    right: string;
  };
}

// Minimum buffer size before allowing playback (500KB = ~30s of audio at 128kbps)
const MIN_BUFFER_SIZE = 500 * 1024;

export class AudioProcessor {
  private audioDir: string;

  constructor(audioDir: string) {
    this.audioDir = audioDir;
  }

  async processYouTubeUrl(url: string): Promise<ProcessedAudio> {
    const id = nanoid(10);
    const outputDir = path.join(this.audioDir, id);
    await fs.mkdir(outputDir, { recursive: true });

    const leftPath = path.join(outputDir, 'left.mp3');
    const rightPath = path.join(outputDir, 'right.mp3');

    // Get title, duration, and stream URL in parallel
    console.log(`[AudioProcessor] Getting stream info: ${url}`);
    const [title, duration, streamUrl] = await Promise.all([
      this.getYouTubeTitle(url),
      this.getYouTubeDuration(url),
      this.getStreamUrl(url),
    ]);

    // Start streaming through ffmpeg (returns early once buffer is ready)
    console.log(`[AudioProcessor] Streaming and splitting channels...`);
    await this.processStreamToChannelsProgressive(streamUrl, leftPath, rightPath);

    console.log(`[AudioProcessor] Buffer ready! Duration: ${duration}s (processing continues in background)`);

    const result = {
      id,
      title,
      duration,
      files: {
        stereo: `/audio/${id}/left.mp3`, // No separate stereo file in streaming mode
        left: `/audio/${id}/left.mp3`,
        right: `/audio/${id}/right.mp3`,
      },
    };

    return result;
  }

  private async downloadWithYtDlp(
    url: string,
    outputPath: string
  ): Promise<{ title: string }> {
    // First, get the title
    const title = await this.getYouTubeTitle(url);

    // Then download
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-x', // Extract audio
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '-o', outputPath,
        '--no-playlist',
        '--force-overwrites',
        url,
      ];

      console.log('[yt-dlp] Downloading:', url);

      const proc = spawn('yt-dlp', args);
      let stderr = '';

      proc.stdout.on('data', (data) => {
        console.log('[yt-dlp]', data.toString().trim());
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        const msg = data.toString().trim();
        if (msg && !msg.startsWith('WARNING')) {
          console.log('[yt-dlp stderr]', msg);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`yt-dlp download failed: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });

    return { title };
  }

  private getYouTubeTitle(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', ['--print', 'title', '--no-playlist', url]);
      let stdout = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim() || 'Unknown');
        } else {
          resolve('Unknown');
        }
      });

      proc.on('error', () => resolve('Unknown'));
    });
  }

  private getStreamUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', ['-g', '-f', 'bestaudio', '--no-playlist', url]);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim().split('\n')[0]); // Take first URL if multiple
        } else {
          reject(new Error(`Failed to get stream URL: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private getYouTubeDuration(url: string): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn('yt-dlp', ['--print', 'duration', '--no-playlist', url]);
      let stdout = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(stdout.trim());
          resolve(isNaN(duration) ? 0 : duration);
        } else {
          resolve(0);
        }
      });

      proc.on('error', () => resolve(0));
    });
  }

  private processStreamToChannels(
    streamUrl: string,
    leftPath: string,
    rightPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use filter_complex to split into both channels in one pass
      const args = [
        '-i', streamUrl,
        '-filter_complex', '[0:a]pan=mono|c0=c0[left];[0:a]pan=mono|c0=c1[right]',
        '-map', '[left]', '-b:a', '192k', leftPath,
        '-map', '[right]', '-b:a', '192k', rightPath,
        '-y', // Overwrite
      ];

      console.log('[ffmpeg] Processing stream to channels...');
      const proc = spawn('ffmpeg', args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log progress
        const progress = data.toString().match(/time=(\d+:\d+:\d+)/);
        if (progress) {
          process.stdout.write(`\r[ffmpeg] Progress: ${progress[1]}`);
        }
      });

      proc.on('close', (code) => {
        console.log(''); // New line after progress
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg failed: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private processStreamToChannelsProgressive(
    streamUrl: string,
    leftPath: string,
    rightPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use filter_complex to split into both channels in one pass
      const args = [
        '-i', streamUrl,
        '-filter_complex', '[0:a]pan=mono|c0=c0[left];[0:a]pan=mono|c0=c1[right]',
        '-map', '[left]', '-b:a', '192k', leftPath,
        '-map', '[right]', '-b:a', '192k', rightPath,
        '-y', // Overwrite
      ];

      console.log('[ffmpeg] Processing stream to channels (progressive)...');
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      let resolved = false;

      // Check file size periodically to determine when buffer is ready
      const checkBuffer = setInterval(() => {
        if (resolved) {
          clearInterval(checkBuffer);
          return;
        }

        try {
          if (existsSync(leftPath) && existsSync(rightPath)) {
            const leftSize = statSync(leftPath).size;
            const rightSize = statSync(rightPath).size;
            const minSize = Math.min(leftSize, rightSize);

            if (minSize >= MIN_BUFFER_SIZE) {
              console.log(`\n[ffmpeg] Buffer ready! (${Math.round(minSize / 1024)}KB) - playback can start`);
              resolved = true;
              clearInterval(checkBuffer);
              resolve();
            }
          }
        } catch {
          // File might not exist yet, ignore
        }
      }, 200); // Check every 200ms

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log progress
        const progress = data.toString().match(/time=(\d+:\d+:\d+)/);
        if (progress && !resolved) {
          process.stdout.write(`\r[ffmpeg] Buffering: ${progress[1]}`);
        } else if (progress) {
          process.stdout.write(`\r[ffmpeg] Processing: ${progress[1]}`);
        }
      });

      proc.on('close', (code) => {
        clearInterval(checkBuffer);
        console.log(''); // New line after progress

        if (!resolved) {
          // Process finished before buffer threshold - that's fine, resolve now
          if (code === 0) {
            console.log('[ffmpeg] Processing complete');
            resolve();
          } else {
            reject(new Error(`ffmpeg failed: ${stderr.slice(-500)}`));
          }
        } else {
          // Already resolved, just log completion
          if (code === 0) {
            console.log('[ffmpeg] Background processing complete');
          } else {
            console.error('[ffmpeg] Background processing failed:', stderr.slice(-200));
          }
        }
      });

      proc.on('error', (err) => {
        clearInterval(checkBuffer);
        if (!resolved) {
          reject(err);
        }
      });
    });
  }

  private extractChannel(
    inputPath: string,
    outputPath: string,
    channel: 'left' | 'right'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // pan=mono|c0=c0 for left, pan=mono|c0=c1 for right
      const channelIndex = channel === 'left' ? 0 : 1;
      const filter = `pan=mono|c0=c${channelIndex}`;

      const args = [
        '-i', inputPath,
        '-af', filter,
        '-ac', '1', // mono output
        '-y', // overwrite
        outputPath,
      ];

      const proc = spawn('ffmpeg', args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg failed: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ];

      const proc = spawn('ffprobe', args);
      let stdout = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(stdout.trim());
          resolve(isNaN(duration) ? 0 : duration);
        } else {
          resolve(0);
        }
      });

      proc.on('error', () => resolve(0));
    });
  }

  async cleanup(audioId: string): Promise<void> {
    const dir = path.join(this.audioDir, audioId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
