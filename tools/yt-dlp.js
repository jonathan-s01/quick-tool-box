// yt-dlp: downloads a video, its audio, or its captions from a web page.
import path from 'node:path';
import { which, missing, userError } from '../lib/system.js';
import { listFiles, zipFiles } from '../lib/files.js';

const HEIGHTS = { best: null, '1080': 1080, '720': 720, '480': 480 };

function videoFormat(height) {
  const h = height ? `[height<=${height}]` : '';
  // Prefer MP4 video with M4A audio so the result plays everywhere, then fall back to anything.
  return `bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/bv*${h}+ba/b${h}/b`;
}

export default {
  id: 'yt-dlp',
  name: 'Video and audio download (yt-dlp)',
  summary: 'Download a video, just its audio, or just its captions from YouTube and many other sites. Only download things you have the right to.',
  submitLabel: 'Download',
  input: null,

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await which('yt-dlp'))) result.missing.push(missing('yt-dlp'));
    if (!(await which('ffmpeg'))) result.missing.push(missing('ffmpeg', 'ffmpeg is not installed. yt-dlp needs it to join video and audio and to convert files.'));
    result.notes.push({ what: 'Sites change often. If downloads start failing, update yt-dlp with this command.', install: 'brew upgrade yt-dlp' });
    result.options.push(
      { id: 'url', type: 'url', label: 'Web address of the video', maxLength: 2000 },
      {
        id: 'mode', type: 'select', label: 'What to download', default: 'video',
        choices: [
          { value: 'video', label: 'Video' },
          { value: 'audio', label: 'Audio only' },
          { value: 'subs', label: 'Captions only' },
        ],
      },
      {
        id: 'height', type: 'select', group: 'Video', label: 'Maximum quality', default: '1080',
        choices: [
          { value: 'best', label: 'Best available (can be very large)' },
          { value: '1080', label: '1080p' },
          { value: '720', label: '720p' },
          { value: '480', label: '480p (smallest)' },
        ],
      },
      {
        id: 'audio', type: 'select', group: 'Audio only', label: 'Audio format', default: 'm4a',
        choices: [
          { value: 'm4a', label: 'M4A' },
          { value: 'mp3', label: 'MP3' },
        ],
      },
      {
        id: 'subLang', type: 'select', group: 'Captions', label: 'Caption language', default: 'en',
        help: 'Used for Captions only, and for the next checkbox.',
        choices: [
          { value: 'en', label: 'English' },
          { value: 'fr', label: 'French' },
          { value: 'en,fr', label: 'English and French' },
          { value: 'all', label: 'All languages' },
        ],
      },
      { id: 'withSubs', type: 'checkbox', group: 'Captions', label: 'Also save captions with a video or audio download', default: false },
      { id: 'auto', type: 'checkbox', group: 'Captions', label: 'Include automatic captions', help: 'Used only if there are no captions made by a person. Automatic captions often have mistakes.', default: true },
    );
    return result;
  },

  async run(ctx) {
    const { options: o, outDir, workDir } = ctx;
    const args = [
      '--no-playlist', '--no-mtime', '--newline', '--no-overwrites',
      '--paths', outDir, '--paths', `temp:${workDir}`,
      '--output', '%(title).150B.%(ext)s',
      '--progress-template', 'download:[progress] %(progress._percent_str)s %(info.title).80B',
    ];
    const langs = o.subLang === 'all' ? 'all,-live_chat' : o.subLang.split(',').map((l) => `${l}.*,${l}`).join(',');
    const subArgs = ['--write-subs', '--sub-langs', langs, '--convert-subs', 'srt'];
    if (o.auto) subArgs.push('--write-auto-subs');

    if (o.mode === 'video') {
      args.push('--format', videoFormat(HEIGHTS[o.height]), '--merge-output-format', 'mp4');
      if (o.withSubs) args.push(...subArgs);
    } else if (o.mode === 'audio') {
      args.push('--format', 'ba/b', '--extract-audio', '--audio-format', o.audio, '--audio-quality', '0');
      if (o.withSubs) args.push(...subArgs);
    } else {
      args.push('--skip-download', ...subArgs);
    }
    args.push('--', o.url);

    ctx.progress(null, null, 'Looking up the video');
    let part = 0;
    let lastPct = -1;
    const onOutput = (chunk) => {
      for (const line of chunk.split('\n')) {
        const m = line.match(/\[progress\]\s+([\d.]+)%/);
        if (m) {
          const pct = Math.floor(Number(m[1]));
          if (pct < lastPct) part += 1; // a new file started, such as the audio after the video
          lastPct = pct;
          ctx.progress(pct, 100, `Downloading${part ? ` part ${part + 1}` : ''}, ${pct}% done`);
        } else if (/^\[(Merger|ExtractAudio|FFmpegSubtitlesConvertor|VideoConvertor)\]/.test(line)) {
          ctx.progress(null, null, 'Converting');
        }
      }
    };
    try {
      await ctx.run('yt-dlp', args, { onStdout: onOutput, onStderr: onOutput });
    } catch (err) {
      const first = (err.stderr || '').split('\n').find((l) => l.startsWith('ERROR:'));
      throw userError(first ? `yt-dlp could not download this. ${first.replace(/^ERROR:\s*/, '')}` : err.message, err.details);
    }

    const files = (await listFiles(outDir)).filter((f) => !/\.(part|ytdl|temp)$/.test(f));
    if (!files.length) {
      throw userError(o.mode === 'subs' ? 'No captions were found in that language.' : 'Nothing was downloaded.');
    }
    const labelFor = (f) => {
      const ext = path.extname(f).toLowerCase();
      if (ext === '.srt' || ext === '.vtt') return 'Captions';
      if (['.m4a', '.mp3', '.opus', '.ogg', '.webm'].includes(ext) && o.mode === 'audio') return 'Audio';
      return o.mode === 'audio' ? 'Audio' : 'Video';
    };
    for (const f of files) ctx.output(f, labelFor(f));
    if (o.mode === 'subs' && files.length > 3) {
      const zip = await zipFiles(files, path.join(outDir, 'captions.zip'), ctx.signal);
      ctx.output(zip, `All ${files.length} caption files as a zip file`);
    }
  },
};
