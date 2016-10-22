'use strict'

const assert = require('assert')
const bl = require('bl')
const cssExtract = require('css-extract')
const Emitter = require('events')
const errorify = require('errorify')
const sheetify = require('sheetify/transform')
const xtend = require('xtend')
const watchify = require('watchify')
const stream = require('readable-stream')

const handleFileEvent = (file, state) => {
  if (state.tinyLr != null) {
    console.log(`Reloading file`, file)
    state.tinyLr.reload(file)
  }
}

const wreq = (state, bundler) => {
  let prevError = null
  let bundleEmitter = null
  let isPending = false
  let buffer = null

  const onCssStreamFinish = () => {
    state.cssStream = new stream.PassThrough()
    state.cssStream.on('finish', onCssStreamFinish)
    state.cssStream.pipe(state.cssBuf)
  }

  // run the bundler and cache output
  const bundle = () => {
    console.log(`handler-js: bundle`)
    let localBundleEmitter = bundleEmitter = new Emitter()
    isPending = true
    state.cssReady = false
    state.cssStream.unpipe(state.cssBuf)
    state.cssBuf = bl()
    state.cssStream.pipe(state.cssBuf)

    const r = bundler.bundle()

    r.once('end', () => {
      console.log(`handler-js: Bundling has ended`)
      state.cssReady = true
      state.emit('css:ready')
    })

    r.pipe(bl((err, _buffer) => {
      if (localBundleEmitter === bundleEmitter) {
        buffer = _buffer
        prevError = err
        isPending = false
        console.log(`handler-js: Bundling is ready`)
        bundleEmitter.emit('ready')
      }
    }))
  }

  bundle()

  bundler.on('update', () => {
    console.log(`Received update event from bundler`)
    handleFileEvent(state.htmlOpts.entry, state)
    bundle()
  })
  state.cssStream.on('finish', onCssStreamFinish)

  return (req, res) => {
    if (bundler.close != null && !bundler.closing) {
      bundler.closing = true
      if (req != null) {
        req.connection.server.on('close', () => {
          bundler.close()
        })
      }
    }

    const ts = new stream.PassThrough()

    const realHandler = (resolve, reject) => {
      if (isPending) {
        console.log(`handler-js: Waiting for pending bundling`)
        bundleEmitter.once('ready', (error) => {
          if (error == null) {
            console.log(`handler-js: Bundler is ready, calling real-handler again`)
            realHandler(resolve, reject)
          } else {
            console.log(`handler-js: Bundler failed`)
            reject(error)
          }
        })
      } else {
        console.log(`handler-js: bundling is ready`)
        if (prevError != null) {
          console.log(`handler-js: bundling has failed: ${prevError}`)
          reject(prevError)
        } else {
          console.log(`handler-js: bundling has ended successfully`)
          state.cssBuf.end()
          resolve(buffer)
        }
      }
    }

    new Promise(realHandler)
      .then((js) => {
        if (res != null) {
          res.setHeader('Content-Type', 'application/javascript')
        }
        ts.end(js)
      }, (error) => {
        ts.emit('error', error)
      })

    return ts
  }
}

// create js stream
// obj -> (fn, str, obj?) -> (req, res) -> rstream
module.exports = (state) => {
  return (browserify, entryFile, opts) => {
    opts = opts || {}

    assert.equal(typeof opts, 'object', 'bankai/js: opts should be an object')
    assert.equal(typeof browserify, 'function', 'bankai/js: browserify should be a fn')
    assert.equal(typeof entryFile, 'string', 'bankai/js: entryFile should be a location')

    // signal to CSS that browserify is registered
    state.jsRegistered = true
    state.jsOpts = {
      entryFile: entryFile,
      opts: opts
    }

    const baseBrowserifyOpts = {
      id: 'bankai-app',
      basedir: process.cwd(),
      cache: {},
      packageCache: {},
      entries: [entryFile],
      fullPaths: true
    }
    const browserifyOpts = xtend(baseBrowserifyOpts, opts)
    const bundler = browserify(browserifyOpts)

    bundler.require(entryFile, {
      expose: browserifyOpts.id
    })

    // enable css if registered
    if (state.cssOpts != null) {
      console.log(`Connecting CSS stream to sheetify`)
      if (state.cssBuf == null || !state.optimize) {
        state.cssBuf = bl()
        state.cssReady = false
      }

      state.cssStream.pipe(state.cssBuf)
      bundler.transform(sheetify, state.cssOpts)
      bundler.plugin(cssExtract, {out: () => { return state.cssStream }})
    }

    if (!state.optimize) {
      bundler.plugin(errorify)
      bundler.plugin(watchify)
    }

    return wreq(state, bundler)
  }
}
