/**
 * Media editing via ffmpeg: the engine behind the `aigc_media_edit` tool.
 *
 * Supports a fixed set of operations (concat, clip, extract_audio,
 * extract_frame, speed, resize, reverse, add_audio, images_to_video)
 * selected by the `operation` parameter. All input files must live inside
 * the session canvas directory; the output is written there too.
 *
 * Security: ffmpeg is run with an explicit argv (no shell), a bounded
 * timeout, and abort-signal support. Input paths are validated to be
 * within the canvas directory so the model can't touch arbitrary files.
 */
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { join, sep } from 'node:path'
import { writeFile, mkdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AigcError } from './wire.js'
import { canvasDirFor } from './canvas-registry.js'

/** The operations the tool supports. */
export type MediaEditOperation =
  | 'concat'
  | 'clip'
  | 'extract_audio'
  | 'extract_frame'
  | 'speed'
  | 'resize'
  | 'reverse'
  | 'add_audio'
  | 'images_to_video'

/** All operations as a readonly array (for schema enum + validation). */
export const MEDIA_EDIT_OPERATIONS: readonly MediaEditOperation[] = [
  'concat', 'clip', 'extract_audio', 'extract_frame', 'speed',
  'resize', 'reverse', 'add_audio', 'images_to_video',
] as const

/** One operation request (already validated by the tool layer). */
export interface MediaEditRequest {
  operation: MediaEditOperation
  inputs: string[]
  outputExt: string
  start?: number
  end?: number
  duration?: number
  speed?: number
  width?: number
  height?: number
  fps?: number
  timestamp?: number
}

/** Result of a successful media edit. */
export interface MediaEditResult {
  outputPath: string
  operation: MediaEditOperation
  durationMs: number
}

/** Check that a path is within the canvas directory (security boundary). */
function assertWithinCanvas(dir: string, filePath: string): void {
  const resolved = isAbsolute(filePath) ? filePath : join(dir, filePath)
  const normalizedDir = dir.endsWith(sep) ? dir : `${dir}${sep}`
  const a = resolved.toLowerCase()
  const b = normalizedDir.toLowerCase()
  if (a !== dir.toLowerCase() && !a.startsWith(b)) {
    throw new AigcError('bad-request', `input file outside the session canvas directory: ${filePath}`)
  }
}

/** Common ffmpeg install locations per platform (used when PATH lookup fails). */
const FFMPEG_PLATFORM_CANDIDATES: readonly string[] = process.platform === 'win32'
  ? [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
      ...(process.env.CONDA_PREFIX ? [`${process.env.CONDA_PREFIX}\\Scripts\\ffmpeg.exe`] : []),
    ]
  : [
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg',
    ]

/** Human-readable list of the candidate locations (for error messages). */
function describeFfmpegCandidates(): string {
  const env = process.env.AIGC_FFMPEG_PATH !== undefined ? `AIGC_FFMPEG_PATH env var, ` : ''
  return `${env}PATH, or one of: ${FFMPEG_PLATFORM_CANDIDATES.join(', ')}`
}

/**
 * Locate the ffmpeg binary. Resolution order:
 *  1. `AIGC_FFMPEG_PATH` env var (explicit override; useful for non-standard installs).
 *  2. `ffmpeg` on PATH (the normal case on macOS/Linux and most Windows setups).
 *  3. Platform-specific common install locations (see FFMPEG_PLATFORM_CANDIDATES).
 *
 * Throws `AigcError('backend-error')` with an actionable message when no ffmpeg
 * can be probed successfully.
 */
async function findFfmpeg(): Promise<string> {
  // 1. Explicit env var override.
  const envPath = process.env.AIGC_FFMPEG_PATH
  if (envPath !== undefined && envPath !== '') {
    try {
      await runProcess(envPath, ['-version'], 5000)
      return envPath
    } catch {
      throw new AigcError('backend-error', `AIGC_FFMPEG_PATH is set to "${envPath}" but ffmpeg could not be probed there. Unset the var or fix the path.`)
    }
  }
  // 2. PATH lookup.
  try {
    await runProcess('ffmpeg', ['-version'], 5000)
    return 'ffmpeg'
  } catch {
    // 3. Common install locations per platform.
    for (const candidate of FFMPEG_PLATFORM_CANDIDATES) {
      try {
        await runProcess(candidate, ['-version'], 5000)
        return candidate
      } catch {
        // continue to next candidate
      }
    }
    throw new AigcError(
      'backend-error',
      'ffmpeg not found. Install ffmpeg (https://ffmpeg.org/download.html) and either: ' +
      `set the ${describeFfmpegCandidates()}.`,
    )
  }
}

/** Run a child process with a timeout, returning on completion. */
function runProcess(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, signal })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new AigcError('backend-error', `process timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}

/** Validate that a file exists and is a regular file. */
async function assertFileExists(filePath: string): Promise<void> {
  const info = await stat(filePath).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw new AigcError('bad-request', `input file not found or not a regular file: ${filePath}`)
  }
}

/**
 * Execute one media edit operation. Builds the ffmpeg argv, runs it, and
 * writes the output to the canvas directory.
 *
 * @param request - the validated operation request.
 * @param cwd - the session cwd (canvas dir = cwd/.dsh-aigc-canvas/sessionId/).
 * @param sessionId - the session id (for the canvas dir path).
 * @param opts - timeout + abort signal.
 * @returns the output file path and timing info.
 */
export async function executeMediaEdit(
  request: MediaEditRequest,
  cwd: string,
  sessionId: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<MediaEditResult> {
  const dir = canvasDirFor(cwd, sessionId)
  await mkdir(dir, { recursive: true })

  // Validate all inputs are within the canvas directory and exist.
  for (const input of request.inputs) {
    assertWithinCanvas(dir, input)
    await assertFileExists(input)
  }

  const ffmpeg = await findFfmpeg()
  const outputName = `${randomUUID()}.${request.outputExt}`
  const outputPath = join(dir, outputName)

  const { args, inputCount } = buildFfmpegArgs(request, outputPath)

  // ffmpeg uses -i for each input; the build function returns args without
  // the -i prefixes for concat (which uses -f concat -i list.txt).
  const startMs = Date.now()

  let finalArgs: string[]
  if (request.operation === 'concat') {
    // concat uses a temporary file list
    const listPath = join(dir, `${randomUUID()}.txt`)
    const listContent = request.inputs.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
    await writeFile(listPath, listContent, 'utf8')
    finalArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, ...args]
    try {
      const result = await runProcess(ffmpeg, finalArgs, opts.timeoutMs, opts.signal)
      if (result.code !== 0) {
        throw new AigcError('backend-error', `ffmpeg concat failed (code ${result.code}): ${result.stderr.slice(0, 1000)}`)
      }
    } finally {
      // Clean up the temp list file.
      await import('node:fs/promises').then(({ unlink }) => unlink(listPath).catch(() => {}))
    }
  } else if (request.operation === 'images_to_video') {
    // images_to_video: multiple -i inputs, one per image, then concat filter.
    finalArgs = ['-y']
    for (const input of request.inputs) {
      finalArgs.push('-i', input)
    }
    // Use the filter to concatenate images with the given fps.
    const n = request.inputs.length
    const fps = request.fps ?? 2
    const filterParts: string[] = []
    for (let i = 0; i < n; i++) {
      filterParts.push(`[${i}:v]setpts=PTS-STARTPTS,format=yuv420p[v${i}]`)
    }
    const concatInputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join('')
    filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=0[out]`)
    finalArgs.push('-filter_complex', filterParts.join(';'), '-map', '[out]', '-r', String(fps), ...args)
    const result = await runProcess(ffmpeg, finalArgs, opts.timeoutMs, opts.signal)
    if (result.code !== 0) {
      throw new AigcError('backend-error', `ffmpeg images_to_video failed (code ${result.code}): ${result.stderr.slice(0, 1000)}`)
    }
  } else {
    // Standard single-input operations (or add_audio with 2 inputs).
    finalArgs = ['-y']
    for (const input of request.inputs) {
      finalArgs.push('-i', input)
    }
    finalArgs.push(...args)
    const result = await runProcess(ffmpeg, finalArgs, opts.timeoutMs, opts.signal)
    if (result.code !== 0) {
      throw new AigcError('backend-error', `ffmpeg ${request.operation} failed (code ${result.code}): ${result.stderr.slice(0, 1000)}`)
    }
  }

  // Verify the output was created.
  const outInfo = await stat(outputPath).catch(() => undefined)
  if (outInfo === undefined || !outInfo.isFile() || outInfo.size === 0) {
    throw new AigcError('backend-error', `ffmpeg produced no output file`)
  }

  return {
    outputPath,
    operation: request.operation,
    durationMs: Date.now() - startMs,
  }
}

/**
 * Build the ffmpeg argv (excluding -y and -i flags) for one operation.
 * Returns the args array and the number of inputs expected.
 */
function buildFfmpegArgs(request: MediaEditRequest, outputPath: string): { args: string[]; inputCount: number } {
  switch (request.operation) {
    case 'concat':
      // concat is handled specially in the caller (uses -f concat -i list.txt).
      // Here we just return the output encoding args.
      return {
        args: ['-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', outputPath],
        inputCount: request.inputs.length,
      }

    case 'clip': {
      // Trim by start/end or start/duration.
      const args: string[] = []
      if (request.start !== undefined) {
        args.push('-ss', String(request.start))
      }
      // -ss before -i is fast seek; we put it before -i in the caller.
      // But since we build args after -i, we use output-side -ss/-t.
      // Actually, let's use -ss/-t as output options here.
      const seekArgs: string[] = []
      if (request.start !== undefined) {
        seekArgs.push('-ss', String(request.start))
      }
      if (request.duration !== undefined) {
        seekArgs.push('-t', String(request.duration))
      } else if (request.end !== undefined && request.start !== undefined) {
        seekArgs.push('-t', String(request.end - request.start))
      } else if (request.end !== undefined) {
        seekArgs.push('-to', String(request.end))
      }
      return {
        args: [...seekArgs, '-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', outputPath],
        inputCount: 1,
      }
    }

    case 'extract_audio':
      return {
        args: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outputPath],
        inputCount: 1,
      }

    case 'extract_frame': {
      const ts = request.timestamp ?? 0
      return {
        args: ['-ss', String(ts), '-frames:v', '1', '-q:v', '2', outputPath],
        inputCount: 1,
      }
    }

    case 'speed': {
      const factor = request.speed ?? 1
      if (factor <= 0) throw new AigcError('bad-request', 'speed must be > 0')
      const pts = (1 / factor).toFixed(6)
      const atempo = Math.min(2, Math.max(0.5, factor))
      return {
        args: ['-filter:v', `setpts=${pts}*PTS`, '-filter:a', `atempo=${atempo}`, '-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-c:a', 'aac', outputPath],
        inputCount: 1,
      }
    }

    case 'resize': {
      const vf: string[] = []
      if (request.width !== undefined && request.height !== undefined) {
        vf.push(`scale=${request.width}:${request.height}`)
      } else if (request.width !== undefined) {
        vf.push(`scale=${request.width}:-2`)
      } else if (request.height !== undefined) {
        vf.push(`scale=-2:${request.height}`)
      } else {
        throw new AigcError('bad-request', 'resize requires width and/or height')
      }
      return {
        args: ['-vf', vf.join(','), '-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-c:a', 'copy', outputPath],
        inputCount: 1,
      }
    }

    case 'reverse':
      return {
        args: ['-vf', 'reverse', '-af', 'areverse', '-c:v', 'libx264', '-crf', '28', '-preset', 'fast', outputPath],
        inputCount: 1,
      }

    case 'add_audio':
      // Input 0 = video, input 1 = audio. Replace the video's audio.
      return {
        args: ['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outputPath],
        inputCount: 2,
      }

    case 'images_to_video':
      // Handled specially in the caller (uses filter_complex concat).
      return {
        args: ['-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-pix_fmt', 'yuv420p', outputPath],
        inputCount: request.inputs.length,
      }

    default:
      throw new AigcError('bad-request', `unsupported operation: ${request.operation satisfies never}`)
  }
}
