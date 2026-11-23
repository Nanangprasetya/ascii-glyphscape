import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chooseFile, dialogCommands, isMedia } from '../lib/picker.mjs'
import { parseEnviron, sessionEnv } from '../lib/session-env.mjs'

describe('file dialog', () => {
  it('offers kdialog, then zenity, with media filters and no shell', () => {
    const [kde, gtk] = dialogCommands({ home: '/home/u', start: '/home/u/Pictures' })
    assert.equal(kde.file, 'kdialog')
    assert.equal(kde.args[3], '/home/u/Pictures')
    assert.match(kde.args[4], /\*\.mp4/)
    assert.equal(gtk.file, 'zenity')
    assert.ok(gtk.args.includes('--filename=/home/u/Pictures/'))
  })

  it('falls back, reports a choice, a cancel and a failure', async () => {
    const missing = { code: -1, stdout: '', stderr: 'spawn kdialog ENOENT' }
    let calls = []
    const runWith = (answers) => async (file) => {
      calls.push(file)
      return answers[file]
    }
    assert.deepEqual(await chooseFile({ run: runWith({ kdialog: missing, zenity: { code: 0, stdout: '/x/a.png\n', stderr: '' } }) }), { path: '/x/a.png' })
    assert.deepEqual(calls, ['kdialog', 'zenity'])
    calls = []
    assert.deepEqual(await chooseFile({ run: runWith({ kdialog: { code: 1, stdout: '', stderr: '' } }) }), { cancelled: true })
    const failed = await chooseFile({ run: runWith({ kdialog: missing, zenity: { ...missing, stderr: 'spawn zenity ENOENT' } }) })
    assert.match(failed.error, /kdialog is not installed; zenity is not installed/)
  })

  it('knows media files by extension', () => {
    assert.ok(isMedia('/a/B.JPG'))
    assert.ok(isMedia('/a/clip.webm'))
    assert.ok(!isMedia('/a/notes.txt'))
  })
})

describe('session environment', () => {
  it('finds the display from a parent process', async () => {
    const files = {
      '/proc/50/environ': 'A=1\0WAYLAND_DISPLAY=wayland-0\0XDG_RUNTIME_DIR=/run/user/1000\0',
      '/proc/40/environ': 'PATH=/bin\0',
      '/proc/40/status': 'Name: x\nPPid:\t50\n'
    }
    const env = await sessionEnv({ env: { PATH: '/bin' }, platform: 'linux', ppid: 40, uid: 1000, home: '/h', read: async (p) => {
      if (!(p in files)) throw new Error('no')
      return files[p]
    }, list: async () => [] })
    assert.equal(env.WAYLAND_DISPLAY, 'wayland-0')
    assert.equal(env.XDG_RUNTIME_DIR, '/run/user/1000')
    assert.deepEqual(parseEnviron('A=1\0B=x=y\0'), { A: '1', B: 'x=y' })
  })

  it('falls back to the usual sockets', async () => {
    const env = await sessionEnv({ env: {}, platform: 'linux', ppid: 1, uid: 1000, home: '/h', read: async () => { throw new Error('no') }, list: async (dir) => (dir === '/run/user/1000' ? ['bus', 'wayland-1'] : ['X0']) })
    assert.equal(env.WAYLAND_DISPLAY, 'wayland-1')
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus')
    assert.equal(env.DISPLAY, ':0')
  })
})
