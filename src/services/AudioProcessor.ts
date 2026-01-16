import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
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

export class AudioProcessor {
  private audioDir: string;

  constructor(audioDir: string) {
    this.audioDir = audioDir;
  }

  async processYouTubeUrl(url: string): Promise<ProcessedAudio> {
    const id = nanoid(10);
    const outputDir = path.join(this.audioDir, id);
    await fs.mkdir(outputDir, { recursive: true });

    // Use %(ext)s template so yt-dlp handles extension properly
    const outputTemplate = path.join(outputDir, 'source.%(ext)s');
    const stereoPath = path.join(outputDir, 'source.mp3');
    const leftPath = path.join(outputDir, 'left.mp3');
    const rightPath = path.join(outputDir, 'right.mp3');

    // Download audio using yt-dlp
    console.log(`[AudioProcessor] Downloading: ${url}`);
    const { title } = await this.downloadWithYtDlp(url, outputTemplate);

    // Split into channels
    console.log(`[AudioProcessor] Splitting channels...`);
    await Promise.all([
      this.extractChannel(stereoPath, leftPath, 'left'),
      this.extractChannel(stereoPath, rightPath, 'right'),
    ]);

    // Get duration
    const duration = await this.getAudioDuration(stereoPath);

    console.log(`[AudioProcessor] Done! Duration: ${duration}s`);

    return {
      id,
      title,
      duration,
      files: {
        stereo: `/audio/${id}/source.mp3`,
        left: `/audio/${id}/left.mp3`,
        right: `/audio/${id}/right.mp3`,
      },
    };
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
