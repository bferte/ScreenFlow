/**
 * Headless check of the screenflow:// streaming protocol.
 *
 * Verifies, from a real renderer (the only place Chromium's URL parsing for
 * custom schemes actually applies):
 *   - which URL shape is even routable
 *   - that 206 range responses come back correctly
 *   - that the path guard rejects files outside the recordings dir
 *
 * Run: npx electron scripts/protocol-check.cjs "<path-to-a-recording.webm>"
 */
const { app, BrowserWindow, protocol } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { Readable } = require('node:stream')

const target = process.argv[2]
if (!target) {
  console.error('usage: electron scripts/protocol-check.cjs <file>')
  process.exit(2)
}
const root = path.dirname(path.dirname(target))

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'screenflow',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

app.commandLine.appendSwitch('disable-gpu')

/** Mirrors `pathFromUrl` in electron/main.ts — see the rationale there. */
function pathFromUrl(pathname) {
  const collapsed = decodeURIComponent(pathname).replace(/^\/+/, '/')
  return path.normalize(/^\/[A-Za-z]:/.test(collapsed) ? collapsed.slice(1) : collapsed)
}

app.whenReady().then(async () => {
  protocol.handle('screenflow', async (request) => {
    const url = new URL(request.url)
    const filePath = pathFromUrl(url.pathname)
    console.log(`  [handler] hit  url=${request.url}`)
    console.log(`  [handler]      pathname=${url.pathname}  host=${url.host}`)
    console.log(`  [handler]      resolved=${filePath}`)

    if (!filePath.startsWith(root)) {
      return new Response('Forbidden', { status: 403 })
    }
    let size
    try {
      size = (await fs.stat(filePath)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('Range') ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      return new Response(Readable.toWeb(createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }
    return new Response(Readable.toWeb(createReadStream(filePath)), {
      status: 200,
      headers: {
        'Content-Type': 'video/webm',
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    })
  })

  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } })
  await win.loadURL('data:text/html,<html><body></body></html>')

  const posix = target.replace(/\\/g, '/')
  const urlEmptyHost = `screenflow:///${encodeURI(posix)}`
  const urlWithHost = `screenflow://local/${encodeURI(posix)}`

  const script = `
    (async () => {
      const out = {};
      const probe = async (label, url, init) => {
        try {
          const r = await fetch(url, init);
          out[label] = { ok: r.ok, status: r.status,
            len: r.headers.get('Content-Length'),
            range: r.headers.get('Content-Range') };
        } catch (e) { out[label] = { error: String(e) }; }
      };
      await probe('emptyHost', ${JSON.stringify(urlEmptyHost)});
      await probe('withHost',  ${JSON.stringify(urlWithHost)});
      await probe('withHostRange', ${JSON.stringify(urlWithHost)}, { headers: { Range: 'bytes=100-199' } });
      await probe('outsideRoot', ${JSON.stringify('screenflow://local/C:/Windows/win.ini')});

      // Does a <video> element actually decode it?
      const v = document.createElement('video');
      v.src = ${JSON.stringify(urlWithHost)};
      out.video = await new Promise((res) => {
        const t = setTimeout(() => res({ timeout: true }), 8000);
        v.onloadedmetadata = () => { clearTimeout(t);
          res({ w: v.videoWidth, h: v.videoHeight, duration: v.duration }); };
        v.onerror = () => { clearTimeout(t);
          res({ error: v.error ? v.error.code + ' ' + v.error.message : 'unknown' }); };
      });
      return out;
    })()
  `

  try {
    const result = await win.webContents.executeJavaScript(script)
    console.log('\n===== RESULTATS =====')
    console.log(JSON.stringify(result, null, 2))
  } catch (e) {
    console.error('executeJavaScript a echoue:', e)
  }
  app.exit(0)
})
