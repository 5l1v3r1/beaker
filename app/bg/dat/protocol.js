import parseDatUrl from 'parse-dat-url'
import parseRange from 'range-parser'
import once from 'once'
import * as logLib from '../logger'
const logger = logLib.child({category: 'dat', subcategory: 'dat-serve'})
// import intoStream from 'into-stream'
import { toZipStream } from '../lib/zip'
import slugify from 'slugify'
import markdown from '../../lib/markdown'
import datDns from './dns'
import * as datArchives from './archives'
import datServeResolvePath from '@beaker/dat-serve-resolve-path'
import errorPage from '../lib/error-page'
import * as mime from '../lib/mime'
import * as typeRegistry from '../filesystem/type-registry'
import * as driveHandlerHack from '../ui/tabs/drive-handler-hack'
import { joinPath } from '../../lib/strings'

const md = markdown({
  allowHTML: true,
  useHeadingIds: true,
  useHeadingAnchors: false,
  hrefMassager: undefined,
  highlight: undefined
})

// HACK detect whether the native builds of some key deps are working -prf
// -prf
var utpLoadError = false
try { require('utp-native') }
catch (err) {
  utpLoadError = err
}
var sodiumLoadError = false
try { require('sodium-native') }
catch (err) {
  sodiumLoadError = err
}

/**
 * HACK
 * Electron has an issue that's causing file read streams to fail to serve
 * Reading into memory seems to resolve the issue
 * https://github.com/electron/electron/issues/21018
 * -prf
 */
import { PassThrough } from 'stream'
function intoStream (text) {
  const rv = new PassThrough()
  rv.push(text)
  rv.push(null)
  return rv
}

// constants
// =

// how long till we give up?
const REQUEST_TIMEOUT_MS = 30e3 // 30 seconds

// exported api
// =

export function register (protocol) {
  protocol.registerStreamProtocol('dat', electronHandler, err => {
    if (err) {
      console.error(err)
      throw new Error('Failed to create protocol: dat')
    }
  })
}

export const electronHandler = async function (request, respond) {
  // log warnings now, after the logger has setup its transports
  if (utpLoadError) {
    logger.warn('Failed to load utp-native. Peer-to-peer connectivity may be degraded.', {err: utpLoadError.toString()})
  }
  if (sodiumLoadError) {
    logger.warn('Failed to load sodium-native. Performance may be degraded.', {err: sodiumLoadError.toString()})
  }

  respond = once(respond)
  var respondError = (code, status, errorPageInfo) => {
    if (errorPageInfo) {
      errorPageInfo.validatedURL = request.url
      errorPageInfo.errorCode = code
    }
    var accept = request.headers.Accept || ''
    if (accept.includes('text/html')) {
      respond({
        statusCode: code,
        headers: {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'unsafe-inline' beaker:;",
          'Access-Control-Allow-Origin': '*'
        },
        data: intoStream(errorPage(errorPageInfo || (code + ' ' + status)))
      })
    } else {
      respond({statusCode: code})
    }
  }
  var fileReadStream
  var headersSent = false
  var archive
  var cspHeader = `default-src * 'unsafe-inline'`

  // validate request
  var urlp = parseDatUrl(request.url, true)
  if (!urlp.host) {
    return respondError(404, 'Archive Not Found', {
      title: 'Archive Not Found',
      errorDescription: 'Invalid URL',
      errorInfo: `${request.url} is an invalid dat:// URL`
    })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respondError(405, 'Method Not Supported')
  }

  // resolve the name
  // (if it's a hostname, do a DNS lookup)
  try {
    var archiveKey = await datDns.resolveName(urlp.host, {ignoreCachedMiss: true})
  } catch (err) {
    return respondError(404, 'No DNS record found for ' + urlp.host, {
      errorDescription: 'No DNS record found',
      errorInfo: `No DNS record found for dat://${urlp.host}`
    })
  }

  // setup a timeout
  var timeout
  const cleanup = () => clearTimeout(timeout)
  timeout = setTimeout(() => {
    // cleanup
    logger.debug('Timed out searching for', {url: archiveKey})
    if (fileReadStream) {
      fileReadStream.destroy()
      fileReadStream = null
    }

    // error page
    var resource = archive ? 'page' : 'site'
    respondError(504, `Timed out searching for ${resource}`, {
      resource,
      validatedURL: urlp.href
    })
  }, REQUEST_TIMEOUT_MS)

  try {
    // start searching the network
    archive = await datArchives.getOrLoadArchive(archiveKey)
  } catch (err) {
    logger.warn('Failed to open archive', {url: archiveKey, err})
    cleanup()
    return respondError(500, 'Failed')
  }

  // parse path
  var filepath = decodeURIComponent(urlp.path)
  if (!filepath) filepath = '/'
  if (filepath.indexOf('?') !== -1) filepath = filepath.slice(0, filepath.indexOf('?')) // strip off any query params
  var hasTrailingSlash = filepath.endsWith('/')

  // checkout version if needed
  try {
    var {checkoutFS} = await datArchives.getArchiveCheckout(archive, urlp.version)
  } catch (err) {
    logger.warn('Failed to open archive checkout', {url: archiveKey, err})
    cleanup()
    return respondError(500, 'Failed')
  }

  // read the manifest (it's needed in a couple places)
  var manifest
  try { manifest = await checkoutFS.pda.readManifest() } catch (e) { manifest = null }

  // read type and configure
  const type = manifest ? manifest.type : undefined
  var handler = driveHandlerHack.getDriveHandler(request.url) || await typeRegistry.getDefaultDriveHandler(type)
  const canExecuteHTML = handler === 'website'

  // serve the handler application
  if (!canExecuteHTML && mime.acceptHeaderWantsHTML(request.headers.Accept)) {
    // TODO pin version
    return respond({
      statusCode: 200,
      headers: {
        // TODO CSP
        'Content-Type': 'text/html'
      },
      data: intoStream(`<meta charset="utf-8">
<link rel="stylesheet" href="${joinPath(handler, 'drive-handler.css')}">
<script type="module" src="${joinPath(handler, 'drive-handler.js')}"></script>
`)
    })
  }

  // read manifest CSP
  if (manifest && manifest.content_security_policy && typeof manifest.content_security_policy === 'string') {
    cspHeader = manifest.content_security_policy
  }

  // handle zip download
  if (urlp.query.download_as === 'zip') {
    cleanup()

    // (try to) get the title from the manifest
    let zipname = false
    if (manifest) {
      zipname = slugify(manifest.title || '').toLowerCase()
    }
    zipname = zipname || 'archive'

    let headers = {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipname}.zip"`,
      'Content-Security-Policy': cspHeader,
      'Access-Control-Allow-Origin': '*'
    }

    if (request.method === 'HEAD') {
      // serve the headers
      return respond({
        statusCode: 204,
        headers,
        data: intoStream('')
      })
    } else {
      // serve the zip
      var zs = toZipStream(checkoutFS, filepath)
      zs.on('error', err => logger.error('Error while producing .zip file', err))
      return respond({
        statusCode: 200,
        headers,
        data: zs
      })
    }
  }

  // lookup entry
  var statusCode = 200
  var headers = {}
  var entry = await datServeResolvePath(checkoutFS.pda, manifest, urlp, request.headers.Accept)

  // handle folder
  if (entry && entry.isDirectory()) {
    cleanup()

    // make sure there's a trailing slash
    if (!hasTrailingSlash) {
      return respond({
        statusCode: 303,
        headers: {
          Location: `dat://${urlp.host}${urlp.version ? ('+' + urlp.version) : ''}${urlp.pathname || ''}/${urlp.search || ''}`
        },
        data: intoStream('')
      })
    }

    // 404
    entry = null
  }

  // handle not found
  if (!entry) {
    cleanup()
    return respondError(404, 'File Not Found', {
      errorDescription: 'File Not Found',
      errorInfo: `Beaker could not find the file ${urlp.path}`,
      title: 'File Not Found'
    })
  }

  // TODO
  // Electron is being really aggressive about caching and not following the headers correctly
  // caching is disabled till we can figure out why
  // -prf
  // caching if-match
  // const ETag = 'block-' + entry.offset
  // if (request.headers['if-none-match'] === ETag) {
  //   return respondError(304, 'Not Modified')
  // }

  // fetch the permissions
  // TODO this has been disabled until we can create a better UX -prf
  // var origins
  // try {
  //   origins = await sitedataDb.getNetworkPermissions('dat://' + archiveKey)
  // } catch (e) {
  //   origins = []
  // }

  // handle range
  headers['Accept-Ranges'] = 'bytes'
  var range = request.headers.Range || request.headers.range
  if (range) range = parseRange(entry.size, range)
  if (range && range.type === 'bytes') {
    range = range[0] // only handle first range given
    statusCode = 206
    headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + entry.size
    headers['Content-Length'] = '' + (range.end - range.start + 1)
  } else {
    if (entry.size) {
      headers['Content-Length'] = '' + (entry.size)
    }
  }

  Object.assign(headers, {
    'Content-Security-Policy': cspHeader,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  })

  // markdown rendering
  if (!range && entry.path.endsWith('.md') && mime.acceptHeaderWantsHTML(request.headers.Accept)) {
    let content = await checkoutFS.pda.readFile(entry.path, 'utf8')
    let contentType = canExecuteHTML ? 'text/html' : 'text/plain'
    content = canExecuteHTML ? renderMD(content) : content
    return respond({
      statusCode: 200,
      headers: Object.assign(headers, {
        'Content-Type': contentType
      }),
      data: intoStream(content)
    })
  }

  // fetch the entry and stream the response
  fileReadStream = checkoutFS.pda.createReadStream(entry.path, range)
  var dataStream = fileReadStream
    .pipe(mime.identifyStream(entry.path, mimeType => {
      // cleanup the timeout now, as bytes have begun to stream
      cleanup()

      // disable html as needed
      if (!canExecuteHTML && mimeType.includes('html')) {
        mimeType = 'text/plain'
      }

      // send headers, now that we can identify the data
      headersSent = true
      Object.assign(headers, {
        'Content-Type': mimeType
      })
      // TODO
      // Electron is being really aggressive about caching and not following the headers correctly
      // caching is disabled till we can figure out why
      // -prf
      // if (ETag) {
      //   Object.assign(headers, {ETag})
      // } else {
      //   Object.assign(headers, {'Cache-Control': 'no-cache'})
      // }

      if (request.method === 'HEAD') {
        dataStream.destroy() // stop reading data
        respond({statusCode: 204, headers, data: intoStream('')})
      } else {
        respond({statusCode, headers, data: dataStream})
      }
    }))

  // handle empty files
  fileReadStream.once('end', () => {
    if (!headersSent) {
      cleanup()
      respond({
        statusCode: 200,
        headers: {
          'Content-Security-Policy': cspHeader,
          'Access-Control-Allow-Origin': '*'
        },
        data: intoStream('')
      })
    }
  })

  // handle read-stream errors
  fileReadStream.once('error', err => {
    logger.warn('Error reading file', {url: archive.url, path: entry.path, err})
    if (!headersSent) respondError(500, 'Failed to read file')
  })
}

function renderMD (content) {
  return `<html>
  <body>
    ${md.render(content)}
  </body>
</html>`
}