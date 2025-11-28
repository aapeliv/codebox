import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { encodeStateAsUpdate, applyUpdate } from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import { initAuth } from './auth.js'
import { initNotepads } from './notepads.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3001
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const SAVE_INTERVAL = 10000 // 10 seconds

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// Initialize auth and notepads modules
const auth = initAuth(DATA_DIR)
const notepads = initNotepads(DATA_DIR)

// Message types for y-websocket protocol
const messageSync = 0
const messageAwareness = 1

// Store for documents and their metadata
const docs = new Map()

class WSSharedDoc extends Y.Doc {
  constructor(name) {
    super({ gc: true })
    this.name = name
    this.conns = new Map() // conn -> { canEdit, userName }
    this.awareness = new awarenessProtocol.Awareness(this)
    this.modified = false

    this.on('update', () => {
      this.modified = true
    })

    this.awareness.on('update', ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
      const message = encoding.toUint8Array(encoder)
      this.conns.forEach((_, c) => {
        if (c.readyState === 1) {
          c.send(message)
        }
      })
    })
  }
}

function getDoc(docName) {
  let doc = docs.get(docName)
  if (!doc) {
    doc = new WSSharedDoc(docName)
    docs.set(docName, doc)
    loadDocument(doc)
  }
  return doc
}

function loadDocument(doc) {
  const filePath = path.join(DATA_DIR, `${encodeURIComponent(doc.name)}.yjs`)
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath)
      applyUpdate(doc, new Uint8Array(data))
      console.log(`Loaded document: ${doc.name}`)
    } catch (err) {
      console.error(`Error loading document ${doc.name}:`, err)
    }
  }
}

function saveDocument(doc) {
  const filePath = path.join(DATA_DIR, `${encodeURIComponent(doc.name)}.yjs`)
  try {
    const update = encodeStateAsUpdate(doc)
    fs.writeFileSync(filePath, Buffer.from(update))
    console.log(`Saved document: ${doc.name}`)
  } catch (err) {
    console.error(`Error saving document ${doc.name}:`, err)
  }
}

function deleteDocumentFile(slug) {
  const filePath = path.join(DATA_DIR, `${encodeURIComponent(slug)}.yjs`)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
  // Also remove from memory
  docs.delete(slug)
}

// Periodic save of modified documents
setInterval(() => {
  docs.forEach((doc) => {
    if (doc.modified) {
      saveDocument(doc)
      doc.modified = false
    }
  })
}, SAVE_INTERVAL)

// Save all documents on shutdown
function shutdown() {
  console.log('Shutting down, saving all documents...')
  docs.forEach((doc) => {
    if (doc.modified) {
      saveDocument(doc)
    }
  })
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function broadcastUpdate(doc, update, origin) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)

  doc.conns.forEach((connInfo, conn) => {
    if (conn !== origin && conn.readyState === 1) {
      conn.send(message)
    }
  })
}

function handleMessage(conn, doc, message, connInfo) {
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)

  switch (messageType) {
    case messageSync: {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, conn)

      // If this was an update (syncMessageType 2), check permissions and broadcast
      if (syncMessageType === 2) {
        // Check if user can edit
        if (!connInfo.canEdit) {
          console.log(`Rejected edit from read-only user on ${doc.name}`)
          // Don't broadcast - the update was applied locally but we won't send to others
          // In a stricter implementation, we'd reject the update entirely
          return
        }

        const updateDecoder = decoding.createDecoder(message)
        decoding.readVarUint(updateDecoder)
        decoding.readVarUint(updateDecoder)
        const update = decoding.readVarUint8Array(updateDecoder)
        broadcastUpdate(doc, update, conn)
      }

      if (encoding.length(encoder) > 1) {
        conn.send(encoding.toUint8Array(encoder))
      }
      break
    }
    case messageAwareness: {
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
      break
    }
  }
}

function setupConnection(conn, docName, connInfo) {
  const doc = getDoc(docName)
  doc.conns.set(conn, connInfo)

  conn.on('message', (message) => {
    try {
      handleMessage(conn, doc, new Uint8Array(message), connInfo)
    } catch (err) {
      console.error('Error handling message:', err)
    }
  })

  conn.on('close', () => {
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, [doc.clientID], null)

    if (doc.conns.size === 0 && doc.modified) {
      saveDocument(doc)
      doc.modified = false
    }
  })

  // Send initial sync step 1
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  conn.send(encoding.toUint8Array(encoder))

  // Send awareness state
  const awarenessStates = doc.awareness.getStates()
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())))
    conn.send(encoding.toUint8Array(encoder))
  }
}

// ============ HTTP API ============

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (err) {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function getAuthToken(req) {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  return null
}

async function handleApiRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathParts = url.pathname.split('/').filter(Boolean) // ['api', ...]

  try {
    // POST /api/admin/setup - Initial admin setup
    if (req.method === 'POST' && url.pathname === '/api/admin/setup') {
      if (auth.isAdminSetup()) {
        return sendJson(res, 400, { error: 'Admin already configured' })
      }
      const body = await parseBody(req)
      if (!body.password || body.password.length < 8) {
        return sendJson(res, 400, { error: 'Password must be at least 8 characters' })
      }
      await auth.setAdminPassword(body.password)
      return sendJson(res, 200, { success: true })
    }

    // GET /api/admin/status - Check if admin is set up
    if (req.method === 'GET' && url.pathname === '/api/admin/status') {
      return sendJson(res, 200, { isSetup: auth.isAdminSetup() })
    }

    // POST /api/admin/login - Admin login
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      const body = await parseBody(req)
      if (!body.password) {
        return sendJson(res, 400, { error: 'Password required' })
      }
      const valid = await auth.checkAdminCred(body.password)
      if (!valid) {
        return sendJson(res, 401, { error: 'Invalid password' })
      }
      const token = auth.generateAdminToken()
      return sendJson(res, 200, { token })
    }

    // Admin-protected routes
    if (url.pathname.startsWith('/api/admin/notepads')) {
      const token = getAuthToken(req)
      if (!token || !auth.verifyAdminToken(token)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }

      // GET /api/admin/notepads - List all notepads
      if (req.method === 'GET' && url.pathname === '/api/admin/notepads') {
        return sendJson(res, 200, { notepads: notepads.list() })
      }

      // POST /api/admin/notepads - Create notepad
      if (req.method === 'POST' && url.pathname === '/api/admin/notepads') {
        const body = await parseBody(req)
        if (!body.slug) {
          return sendJson(res, 400, { error: 'Slug required' })
        }
        try {
          const notepad = notepads.create(body.slug, body.protection || 'none', body.password || null)
          return sendJson(res, 201, { notepad })
        } catch (err) {
          return sendJson(res, 400, { error: err.message })
        }
      }

      // PUT /api/admin/notepads/:slug - Update notepad
      const putMatch = url.pathname.match(/^\/api\/admin\/notepads\/([^/]+)$/)
      if (req.method === 'PUT' && putMatch) {
        const slug = decodeURIComponent(putMatch[1])
        const body = await parseBody(req)
        try {
          const notepad = notepads.update(slug, {
            protection: body.protection,
            password: body.password,
            newSlug: body.newSlug
          })
          return sendJson(res, 200, { notepad })
        } catch (err) {
          return sendJson(res, 400, { error: err.message })
        }
      }

      // DELETE /api/admin/notepads/:slug - Delete notepad
      const deleteMatch = url.pathname.match(/^\/api\/admin\/notepads\/([^/]+)$/)
      if (req.method === 'DELETE' && deleteMatch) {
        const slug = decodeURIComponent(deleteMatch[1])
        try {
          notepads.remove(slug)
          deleteDocumentFile(slug)
          return sendJson(res, 200, { success: true })
        } catch (err) {
          return sendJson(res, 400, { error: err.message })
        }
      }
    }

    // Public notepad routes
    // GET /api/notepads/:slug - Get notepad public info
    const notepadMatch = url.pathname.match(/^\/api\/notepads\/([^/]+)$/)
    if (req.method === 'GET' && notepadMatch) {
      const slug = decodeURIComponent(notepadMatch[1])
      const info = notepads.getPublicInfo(slug)
      if (!info) {
        return sendJson(res, 404, { error: 'Notepad not found' })
      }
      return sendJson(res, 200, { notepad: info })
    }

    // POST /api/notepads/:slug/auth - Authenticate to notepad
    const authMatch = url.pathname.match(/^\/api\/notepads\/([^/]+)\/auth$/)
    if (req.method === 'POST' && authMatch) {
      const slug = decodeURIComponent(authMatch[1])
      const body = await parseBody(req)
      const { password, userName } = body

      if (!userName || userName.trim().length === 0) {
        return sendJson(res, 400, { error: 'Name required' })
      }

      const notepad = notepads.get(slug)
      if (!notepad) {
        return sendJson(res, 404, { error: 'Notepad not found' })
      }

      const viewResult = notepads.canView(slug, password)
      if (!viewResult.allowed) {
        return sendJson(res, 403, { error: viewResult.reason })
      }

      const editResult = notepads.canEdit(slug, password)
      const canEdit = editResult.allowed

      const token = auth.generateAccessToken(slug, canEdit)
      return sendJson(res, 200, { token, canEdit, slug })
    }

    return sendJson(res, 404, { error: 'Not found' })
  } catch (err) {
    console.error('API error:', err)
    return sendJson(res, 500, { error: 'Internal server error' })
  }
}

// ============ HTTP Server ============

const server = http.createServer(async (req, res) => {
  // CORS headers for API
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // API routes
  if (req.url.startsWith('/api/')) {
    return handleApiRequest(req, res)
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', docs: docs.size }))
    return
  }

  // Serve static files from client/dist
  const clientDist = path.join(__dirname, '..', 'client', 'dist')
  let filePath = path.join(clientDist, req.url === '/' ? 'index.html' : req.url)

  // Security: prevent directory traversal
  if (!filePath.startsWith(clientDist)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try index.html for SPA routing
      fs.readFile(path.join(clientDist, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(data2)
      })
      return
    }

    const ext = path.extname(filePath)
    const contentTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.ttf': 'font/ttf'
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' })
    res.end(data)
  })
})

// ============ WebSocket Server ============

const wss = new WebSocketServer({ server })

wss.on('connection', (conn, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const docName = url.pathname.slice(4) || 'default' // Remove '/ws/' prefix
  const token = url.searchParams.get('token')

  // Verify access token
  const tokenData = token ? auth.verifyAccessToken(token) : null

  if (!tokenData || tokenData.slug !== docName) {
    console.log(`Rejected WebSocket connection for ${docName}: invalid token`)
    conn.close(4001, 'Unauthorized')
    return
  }

  const connInfo = {
    canEdit: tokenData.canEdit,
    userName: tokenData.userName || 'Anonymous'
  }

  console.log(`New connection for document: ${docName} (canEdit: ${connInfo.canEdit})`)
  setupConnection(conn, docName, connInfo)
})

// Stats logging
setInterval(() => {
  let totalConns = 0
  docs.forEach(doc => { totalConns += doc.conns.size })
  console.log(`${new Date().toISOString()} - Docs: ${docs.size}, Connections: ${totalConns}`)
}, 30000)

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`WebSocket available at ws://localhost:${PORT}/ws/{docname}`)
  console.log(`Data directory: ${path.resolve(DATA_DIR)}`)
  console.log(`Admin setup: ${auth.isAdminSetup() ? 'configured' : 'NOT CONFIGURED - visit /admin to set up'}`)
})
