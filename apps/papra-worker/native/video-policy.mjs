// Probe facts, rather than extensions or total byte size, determine browser playback suitability.
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function frameRate(value) {
  const [numerator, denominator = '1'] = String(value ?? '').split('/');
  return positive(Number(numerator) / Number(denominator));
}
export function normalizeMediaMetadata(info) {
  const video = info.streams?.find(
    (stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  const audio = info.streams?.find((stream) => stream.codec_type === 'audio');
  const rotation = Number(
    video?.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ??
      video?.tags?.rotate ??
      0,
  );
  const rotated = Math.abs(rotation % 180) === 90;
  return {
    durationSeconds:
      positive(info.format?.duration) ?? positive(video?.duration) ?? positive(audio?.duration),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    width: positive(rotated ? video?.height : video?.width),
    height: positive(rotated ? video?.width : video?.height),
    pixelFormat: video?.pix_fmt,
    bitrate: positive(info.format?.bit_rate) ?? positive(video?.bit_rate),
    formatName:
      String(info.format?.tags?.major_brand ?? '').trim() === 'qt'
        ? 'mov'
        : info.format?.format_name,
    fps: frameRate(video?.avg_frame_rate) ?? frameRate(video?.r_frame_rate),
  };
}
export function needsVideoPreview(metadata) {
  const formats = String(metadata.formatName ?? '').split(',');
  const mp4 =
    formats.includes('mp4') &&
    metadata.videoCodec === 'h264' &&
    metadata.pixelFormat === 'yuv420p' &&
    (!metadata.hasAudio || metadata.audioCodec === 'aac');
  const webm =
    formats.includes('webm') &&
    ['vp8', 'vp9'].includes(metadata.videoCodec) &&
    metadata.pixelFormat === 'yuv420p' &&
    (!metadata.hasAudio || ['opus', 'vorbis'].includes(metadata.audioCodec));
  const { width, height, bitrate } = metadata;
  return (
    !(mp4 || webm) ||
    !width ||
    !height ||
    !bitrate ||
    Math.min(width, height) > 1080 ||
    Math.max(width, height) > 1920 ||
    bitrate > 8_000_000
  );
}
export function playbackEncodingArgs(metadata, height) {
  const portrait = metadata.height > metadata.width;
  const longEdge = height === 1080 ? 1920 : 1280;
  const maxWidth = portrait ? height : longEdge;
  const maxHeight = portrait ? longEdge : height;
  const bitrate = height === 1080 ? '3000k' : '1500k';
  // min(iw/ih, bound) prevents upscaling. div-by-two keeps H.264 output dimensions valid.
  const scale = `scale=w='trunc(min(iw,${maxWidth})/2)*2':h='trunc(min(ih,${maxHeight})/2)*2':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
  return [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    scale,
    '-r',
    String(Math.min(metadata.fps ?? 30, 30)),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    bitrate,
    '-maxrate',
    bitrate,
    '-bufsize',
    height === 1080 ? '6000k' : '3000k',
    '-threads',
    '1',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-metadata:s:v:0',
    'rotate=0',
  ];
}

export function canRemuxPlayback(metadata, height) {
  const longEdge = height === 1080 ? 1920 : 1280;
  return (
    metadata.videoCodec === 'h264' &&
    metadata.pixelFormat === 'yuv420p' &&
    (!metadata.hasAudio || metadata.audioCodec === 'aac') &&
    metadata.fps > 0 &&
    metadata.fps <= 30 &&
    metadata.bitrate > 0 &&
    metadata.bitrate <= (height === 1080 ? 3_000_000 : 1_500_000) &&
    metadata.width > 0 &&
    metadata.height > 0 &&
    Math.min(metadata.width, metadata.height) <= height &&
    Math.max(metadata.width, metadata.height) <= longEdge
  );
}
