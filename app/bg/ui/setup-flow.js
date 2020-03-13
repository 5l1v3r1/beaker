import * as path from 'path'
import { BrowserWindow } from 'electron'
import { ICON_PATH } from './windows'
import * as profileDb from '../dbs/profile-data-db'
import knex from '../lib/knex'

// globals
// =

var setupWindow

// exported api
// =
/**
 * TODOS
 * 
 * disable resize
 * figure out window close
 */

export async function runSetupFlow () {
  var setupState = await profileDb.get('SELECT * FROM setup_state')
  if (!setupState) {
    setupState = {migrated08to09: 0}
    await profileDb.run(knex('setup_state').insert(setupState))
  }

  if (!setupState.migrated08to09) {
    setupWindow = new BrowserWindow({
      // titleBarStyle: 'hiddenInset',
      autoHideMenuBar: true,
      fullscreenable: false,
      resizable: false,
      fullscreenWindowTitle: true,
      frame: false,
      width: 600,
      height: 500,
      backgroundColor: '#334',
      webPreferences: {
        preload: path.join(__dirname, 'fg', 'webview-preload', 'index.build.js'),
        defaultEncoding: 'utf-8',
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
        sandbox: true,
        webSecurity: true,
        enableRemoteModule: false,
        allowRunningInsecureContent: false
      },
      icon: ICON_PATH,
      show: true
    })
    setupWindow.loadURL('beaker://setup/')
    await new Promise(r => setupWindow.once('close', r))
    setupWindow = undefined
  }
}

export async function updateSetupState (obj) {
  await profileDb.run(knex('setup_state').update(obj))

  // HACK
  // window.close() isnt working within the UI thread for some reason
  // so use this as a cue to close the window
  // -prf
  if (setupWindow) setupWindow.close()
}