/**
 * End-to-end check of the main-process export pipeline.
 *
 * Drives the real startExport/writeFrame/finishExport against synthetic PNG
 * frames, so the ffmpeg argument list, the image2pipe stream and the stdin
 * backpressure path are all exercised without touching the UI.
 *
 * Run: npx esbuild scripts/exportcheck.ts --bundle --platform=node --outfile=x.cjs && node x.cjs <workdir>
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { startExport, writeFrame, finishExport } from '../electron/export'
import { ffmpegPath } from '../electron/ffmpeg'

const execFileAsync = promisify(execFile)
const work = process.argv[2]
if (!work) {
  console.error('usage: node exportcheck.cjs <workdir>')
  process.exit(2)
}

const FPS = 30
const SECONDS = 2
const W = 640
const H = 360

async function ff(args: string[]) {
  const { stderr } = await execFileAsync(ffmpegPath(), ['-hide_banner', '-y', ...args], {
    maxBuffer: 32 * 1024 * 1024,
  })
  return stderr
}

/**
 * `ffmpeg -i file` with no output always exits non-zero, so probing has to read
 * stderr off the rejection rather than treat the exit code as failure.
 */
async function probeFile(file: string): Promise<string> {
  try {
    return await ff(['-i', file])
  } catch (e) {
    const err = e as { stderr?: string }
    if (err.stderr) return err.stderr
    throw e
  }
}

async function main() {
  const frameDir = path.join(work, 'frames')
  await rm(frameDir, { recursive: true, force: true })
  await mkdir(frameDir, { recursive: true })

  console.log('1. generation des images de test...')
  await ff([
    '-f', 'lavfi',
    '-i', `testsrc=size=${W}x${H}:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'image2',
    path.join(frameDir, '%04d.png'),
  ])
  const names = (await readdir(frameDir)).filter((n) => n.endsWith('.png')).sort()
  console.log(`   ${names.length} images generees`)

  console.log('2. generation de la piste audio de test...')
  const wavPath = path.join(work, 'test.wav')
  await ff([
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${SECONDS}`,
    '-ac', '2', '-ar', '48000',
    wavPath,
  ])
  const wav = await readFile(wavPath)

  const outputPath = path.join(work, 'out.mp4')
  await rm(outputPath, { force: true })

  console.log('3. export via le pipeline reel...')
  const id = await startExport({
    outputPath,
    width: W,
    height: H,
    fps: FPS,
    crf: 18,
    preset: 'ultrafast',
    wav: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
  })

  const t0 = Date.now()
  for (const name of names) {
    const png = await readFile(path.join(frameDir, name))
    await writeFrame(id, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer)
  }
  const written = await finishExport(id)
  console.log(`   termine en ${Date.now() - t0} ms -> ${written}`)

  console.log('\n4. verification du fichier produit...')
  const info = await stat(outputPath)
  const probe = await probeFile(outputPath)
  const lines = probe
    .split('\n')
    .filter((l) => /Duration|Stream #/.test(l))
    .map((l) => '   ' + l.trim())

  console.log(`   taille : ${info.size} octets`)
  console.log(lines.join('\n'))

  const expectedFrames = FPS * SECONDS
  const hasVideo = /Video: h264/.test(probe)
  const hasAudio = /Audio: aac/.test(probe)
  const durationOk = /Duration: 00:00:0[12]\./.test(probe)

  console.log('\n=== CONTROLES ===')
  console.log(`   images envoyees   : ${names.length} (attendu ${expectedFrames})`)
  console.log(`   piste video h264  : ${hasVideo ? 'OUI' : 'NON'}`)
  console.log(`   piste audio aac   : ${hasAudio ? 'OUI' : 'NON'}`)
  console.log(`   duree plausible   : ${durationOk ? 'OUI' : 'NON'}`)
  console.log(`   resolution        : ${new RegExp(`${W}x${H}`).test(probe) ? 'OUI' : 'NON'}`)
  console.log(`   pixel format      : ${/yuv420p/.test(probe) ? 'yuv420p OUI' : 'NON'}`)

  const ok = hasVideo && hasAudio && durationOk && info.size > 1000
  console.log(`\n   RESULTAT : ${ok ? 'SUCCES' : 'ECHEC'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('\nECHEC:', e instanceof Error ? e.message : e)
  process.exit(1)
})
