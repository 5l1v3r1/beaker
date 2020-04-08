/**
 * Shell Menus
 *
 * NOTES
 * - There can only ever be one Shell Menu view for a given browser window
 * - Shell Menu views are created with each browser window and then shown/hidden as needed
 * - The Shell Menu view contains the UIs for multiple menus and swaps between them as needed
 * - When unfocused, the Shell Menu view is hidden (it's meant to act as a popup menu)
 */

import path from 'path'
import Events from 'events'
import { BrowserWindow, BrowserView } from 'electron'
import * as rpc from 'pauls-electron-rpc'
import { createShellWindow } from '../windows'
import * as tabManager from '../tab-manager'
import * as modals from './modals'
import shellMenusRPCManifest from '../../rpc-manifests/shell-menus'

// globals
// =

const MARGIN_SIZE = 10
const IS_RIGHT_ALIGNED = ['browser', 'bookmark', 'peers', 'share', 'site', 'donate']
var events = new Events()
var views = {} // map of {[parentWindow.id] => BrowserView}

// exported api
// =

export function setup (parentWindow) {
  var view = views[parentWindow.id] = new BrowserView({
    webPreferences: {
      defaultEncoding: 'utf-8',
      preload: path.join(__dirname, 'fg', 'shell-menus', 'index.build.js')
    }
  })
  view.webContents.on('console-message', (e, level, message) => {
    console.log('Shell-Menus window says:', message)
  })
  view.webContents.loadURL('beaker://shell-menus/')
}

export function destroy (parentWindow) {
  if (get(parentWindow)) {
    get(parentWindow).destroy()
    delete views[parentWindow.id]
  }
}

export function get (parentWindow) {
  return views[parentWindow.id]
}

export function reposition (parentWindow) {
  var view = get(parentWindow)
  if (view) {
    let parentBounds = parentWindow.getContentBounds()
    const setBounds = (b) => {
      // HACK workaround the lack of view.getBounds() -prf
      if (view.currentBounds) {
        b = view.currentBounds // use existing bounds
      }
      view.currentBounds = b // store new bounds
      view.setBounds(adjustBounds(view, parentWindow, b))
    }
    if (view.menuId === 'browser') {
      setBounds({
        x: 5,
        y: 72,
        width: 230,
        height: 350
      })
    } else if (view.menuId === 'bookmark') {
      setBounds({
        x: parentBounds.width - view.boundsOpt.left,
        y: view.boundsOpt.top,
        width: 250,
        height: 200
      })
    } else if (view.menuId === 'donate') {
      setBounds({
        x: parentBounds.width - view.boundsOpt.left,
        y: view.boundsOpt.top,
        width: 350,
        height: 90
      })
    } else if (view.menuId === 'share') {
      setBounds({
        x: parentBounds.width - view.boundsOpt.left,
        y: view.boundsOpt.top,
        width: 310,
        height: 120
      })
    } else if (view.menuId === 'peers') {
      setBounds({
        x: parentBounds.width - view.boundsOpt.left,
        y: view.boundsOpt.top,
        width: 250,
        height: 350
      })
    } else if (view.menuId === 'site') {
      setBounds({
        x: parentBounds.width - view.boundsOpt.left,
        y: view.boundsOpt.top,
        width: 250,
        height: 350
      })
    }
  }
}

export async function toggle (parentWindow, menuId, opts) {
  var view = get(parentWindow)
  if (view) {
    if (view.isVisible) {
      return hide(parentWindow)
    } else {
      return show(parentWindow, menuId, opts)
    }
  }
}

export async function show (parentWindow, menuId, opts) {
  var view = get(parentWindow)
  if (view) {
    view.menuId = menuId
    view.boundsOpt = opts && opts.bounds
    parentWindow.addBrowserView(view)
    reposition(parentWindow)
    view.isVisible = true

    var params = opts && opts.params ? opts.params : {}
    await view.webContents.executeJavaScript(`openMenu('${menuId}', ${JSON.stringify(params)})`)
    view.webContents.focus()

    // await till hidden
    await new Promise(resolve => {
      events.once('hide', resolve)
    })
  }
}

export function hide (parentWindow) {
  var view = get(parentWindow)
  if (view) {
    view.webContents.executeJavaScript(`reset('${view.menuId}')`)
    parentWindow.removeBrowserView(view)
    view.currentBounds = null
    view.isVisible = false
    events.emit('hide')
  }
}

// rpc api
// =

rpc.exportAPI('background-process-shell-menus', shellMenusRPCManifest, {
  async close () {
    hide(getParentWindow(this.sender))
  },

  async createWindow (opts) {
    createShellWindow(opts)
  },

  async createTab (url) {
    var win = getParentWindow(this.sender)
    hide(win) // always close the menu
    tabManager.create(win, url, {setActive: true})
  },

  async createModal (name, opts) {
    return modals.create(this.sender, name, opts)
  },

  async loadURL (url) {
    var win = getParentWindow(this.sender)
    hide(win) // always close the menu
    tabManager.getActive(win).loadURL(url)
  },

  async resizeSelf (dimensions) {
    var view = BrowserView.fromWebContents(this.sender)
    if (!view.isVisible) return
    // HACK view.currentBounds is set in reposition() -prf
    dimensions = Object.assign({}, view.currentBounds || {}, dimensions)
    view.setBounds(adjustBounds(view, getParentWindow(this.sender), dimensions))
    view.currentBounds = dimensions
  },

  async showInpageFind () {
    var win = getParentWindow(this.sender)
    var tab = tabManager.getActive(win)
    if (tab) tab.showInpageFind()
  }
})

// internal methods
// =

/**
 * @description
 * Ajust the bounds for margin and for right-alignment (as needed)
 */
function adjustBounds (view, parentWindow, bounds) {
  let parentBounds = parentWindow.getContentBounds()
  var isRightAligned = IS_RIGHT_ALIGNED.includes(view.menuId)
  return {
    x: isRightAligned
      ? (parentBounds.width - bounds.width - bounds.x - MARGIN_SIZE)
      : (bounds.x - MARGIN_SIZE),
    y: bounds.y,
    width: bounds.width + (MARGIN_SIZE * 2),
    height: bounds.height + MARGIN_SIZE
  }
}

function getParentWindow (sender) {
  var view = BrowserView.fromWebContents(sender)
  for (let id in views) {
    if (views[id] === view) {
      return BrowserWindow.fromId(+id)
    }
  }
  throw new Error('Parent window not found')
}