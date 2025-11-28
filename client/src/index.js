import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { MonacoBinding } from 'y-monaco'
import * as monaco from 'monaco-editor'

import { admin, notepad } from './api.js'
import './styles.css'

// ============ LocalStorage Helpers ============

function getSavedUsername() {
  return localStorage.getItem('codebox_username') || ''
}

function saveUsername(name) {
  localStorage.setItem('codebox_username', name)
}

function getSavedPasswords() {
  try {
    return JSON.parse(localStorage.getItem('codebox_passwords') || '{}')
  } catch {
    return {}
  }
}

function getSavedPassword(slug) {
  const passwords = getSavedPasswords()
  return passwords[slug] || ''
}

function savePassword(slug, password) {
  const passwords = getSavedPasswords()
  passwords[slug] = password
  localStorage.setItem('codebox_passwords', JSON.stringify(passwords))
}

// Theme preference: 'system', 'dark', or 'light'
function getSavedTheme() {
  return localStorage.getItem('codebox_theme') || 'system'
}

// Branding: set to false to hide the "Powered by Codebox" message
const SHOW_BRANDING = true

function saveTheme(theme) {
  localStorage.setItem('codebox_theme', theme)
}

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getEffectiveTheme() {
  const saved = getSavedTheme()
  if (saved === 'system') {
    return getSystemTheme()
  }
  return saved
}

function applyTheme() {
  const theme = getEffectiveTheme()
  document.documentElement.setAttribute('data-theme', theme)

  // Update Monaco editor theme if it exists
  if (window.codebox?.editor) {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getSavedTheme() === 'system') {
    applyTheme()
  }
})

// Apply theme on load
applyTheme()

// Generate consistent color from name using HSL for infinite nice colors
function getUserColor(name) {
  const normalizedName = name.toLowerCase().trim()

  // Generate a hash from the name
  let hash = 0
  for (let i = 0; i < normalizedName.length; i++) {
    hash = ((hash << 5) - hash) + normalizedName.charCodeAt(i)
    hash = hash & hash // Convert to 32bit integer
  }

  // Use the hash to generate a hue (0-360)
  // Golden ratio conjugate helps distribute hues evenly
  // +256 offset rotation for preferred color assignments
  const hue = (Math.abs(hash) * 137.508 + 256) % 360

  // Fixed saturation and lightness for consistent vibrancy
  // Saturation: 70% - vibrant but not neon
  // Lightness: 55% - bright enough to see, dark enough for white text
  const saturation = 70
  const lightness = 55

  return `hsl(${Math.round(hue)}, ${saturation}%, ${lightness}%)`
}

// Route handling
function getRoute() {
  const path = window.location.pathname
  if (path === '/admin' || path.startsWith('/admin')) {
    return { type: 'admin' }
  }
  // Extract slug from path like /notepad/my-slug or just /my-slug
  const match = path.match(/^\/(?:notepad\/)?([a-zA-Z0-9_-]+)$/)
  if (match) {
    return { type: 'notepad', slug: match[1] }
  }
  return { type: 'home' }
}

// Build WebSocket URL
function getWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  return `${protocol}//${host}/ws`
}

// ============ Admin UI ============

async function renderAdmin() {
  const app = document.getElementById('app')

  // Check if admin is set up
  const status = await admin.getStatus()

  if (!status.isSetup) {
    app.innerHTML = `
      <div class="auth-container">
        <h1>Admin Setup</h1>
        <p>Create your admin password to get started.</p>
        <form id="setup-form">
          <input type="password" id="setup-password" placeholder="Password (min 8 chars)" minlength="8" required>
          <input type="password" id="setup-confirm" placeholder="Confirm password" required>
          <button type="submit">Set Password</button>
          <div id="setup-error" class="error"></div>
        </form>
      </div>
    `
    document.getElementById('setup-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const password = document.getElementById('setup-password').value
      const confirm = document.getElementById('setup-confirm').value
      const errorEl = document.getElementById('setup-error')

      if (password !== confirm) {
        errorEl.textContent = 'Passwords do not match'
        return
      }

      try {
        await admin.setup(password)
        renderAdmin()
      } catch (err) {
        errorEl.textContent = err.message
      }
    })
    return
  }

  // Check if logged in
  if (!admin.isLoggedIn()) {
    app.innerHTML = `
      <div class="auth-container">
        <h1>Admin Login</h1>
        <form id="login-form">
          <input type="password" id="login-password" placeholder="Admin password" required>
          <button type="submit">Login</button>
          <div id="login-error" class="error"></div>
        </form>
      </div>
    `
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const password = document.getElementById('login-password').value
      const errorEl = document.getElementById('login-error')

      try {
        await admin.login(password)
        renderAdmin()
      } catch (err) {
        errorEl.textContent = err.message
      }
    })
    return
  }

  // Show admin dashboard
  renderAdminDashboard()
}

async function renderAdminDashboard() {
  const app = document.getElementById('app')

  app.innerHTML = `
    <div class="admin-dashboard">
      <header class="admin-header">
        <h1>Codebox Admin</h1>
        <button id="logout-btn">Logout</button>
      </header>
      <div class="admin-content">
        <div class="admin-section">
          <h2>Create Notepad</h2>
          <form id="create-form" class="create-form">
            <input type="text" id="create-slug" placeholder="slug (e.g., meeting-notes)" pattern="[a-zA-Z0-9_-]+" required>
            <select id="create-protection">
              <option value="none">Unprotected</option>
              <option value="view-only">View Only (no editing)</option>
              <option value="edit-protected">Password to Edit</option>
              <option value="full-protected">Password to View & Edit</option>
            </select>
            <div id="create-password-row" class="password-row hidden">
              <input type="password" id="create-password" placeholder="Notepad password">
              <button type="button" id="create-toggle-pwd" class="toggle-pwd">Show</button>
            </div>
            <button type="submit">Create</button>
            <div id="create-error" class="error"></div>
          </form>
        </div>
        <div class="admin-section">
          <h2>Notepads</h2>
          <div id="notepads-list" class="notepads-list">Loading...</div>
        </div>
      </div>
    </div>
  `

  document.getElementById('logout-btn').addEventListener('click', () => {
    admin.logout()
    renderAdmin()
  })

  // Protection select handler
  const protectionSelect = document.getElementById('create-protection')
  const passwordRow = document.getElementById('create-password-row')
  protectionSelect.addEventListener('change', () => {
    const needsPassword = ['edit-protected', 'full-protected'].includes(protectionSelect.value)
    passwordRow.classList.toggle('hidden', !needsPassword)
  })

  // Toggle password visibility
  document.getElementById('create-toggle-pwd').addEventListener('click', (e) => {
    const input = document.getElementById('create-password')
    const isPassword = input.type === 'password'
    input.type = isPassword ? 'text' : 'password'
    e.target.textContent = isPassword ? 'Hide' : 'Show'
  })

  // Create form
  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const slug = document.getElementById('create-slug').value.trim()
    const protection = document.getElementById('create-protection').value
    const password = document.getElementById('create-password').value || null
    const errorEl = document.getElementById('create-error')

    try {
      await admin.createNotepad(slug, protection, password)
      document.getElementById('create-slug').value = ''
      document.getElementById('create-password').value = ''
      loadNotepads()
    } catch (err) {
      errorEl.textContent = err.message
    }
  })

  loadNotepads()
}

async function loadNotepads() {
  const listEl = document.getElementById('notepads-list')

  try {
    const data = await admin.listNotepads()

    if (data.notepads.length === 0) {
      listEl.innerHTML = '<p class="empty">No notepads yet. Create one above.</p>'
      return
    }

    listEl.innerHTML = data.notepads.map(np => `
      <div class="notepad-item" data-slug="${np.slug}">
        <div class="notepad-info">
          <a href="/${np.slug}" class="notepad-slug" target="_blank">${np.slug}</a>
          <span class="notepad-protection protection-${np.protection}">${formatProtection(np.protection)}</span>
        </div>
        <div class="notepad-actions">
          <button class="edit-btn" data-slug="${np.slug}">Edit</button>
          <button class="delete-btn" data-slug="${np.slug}">Delete</button>
        </div>
        <div class="notepad-edit-form hidden" id="edit-form-${np.slug}">
          <select class="edit-protection" data-slug="${np.slug}">
            <option value="none" ${np.protection === 'none' ? 'selected' : ''}>Unprotected</option>
            <option value="view-only" ${np.protection === 'view-only' ? 'selected' : ''}>View Only</option>
            <option value="edit-protected" ${np.protection === 'edit-protected' ? 'selected' : ''}>Password to Edit</option>
            <option value="full-protected" ${np.protection === 'full-protected' ? 'selected' : ''}>Password to View & Edit</option>
          </select>
          <div class="password-row ${['edit-protected', 'full-protected'].includes(np.protection) ? '' : 'hidden'}">
            <input type="password" class="edit-password" data-slug="${np.slug}" value="${np.password || ''}" placeholder="Password">
            <button type="button" class="toggle-pwd">Show</button>
          </div>
          <div class="edit-actions">
            <button class="save-btn" data-slug="${np.slug}">Save</button>
            <button class="cancel-btn" data-slug="${np.slug}">Cancel</button>
          </div>
        </div>
      </div>
    `).join('')

    // Attach event handlers
    listEl.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const slug = btn.dataset.slug
        document.getElementById(`edit-form-${slug}`).classList.remove('hidden')
        btn.classList.add('hidden')
      })
    })

    listEl.querySelectorAll('.cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const slug = btn.dataset.slug
        document.getElementById(`edit-form-${slug}`).classList.add('hidden')
        listEl.querySelector(`.edit-btn[data-slug="${slug}"]`).classList.remove('hidden')
      })
    })

    listEl.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.slug
        if (confirm(`Delete notepad "${slug}"? This cannot be undone.`)) {
          try {
            await admin.deleteNotepad(slug)
            loadNotepads()
          } catch (err) {
            alert(err.message)
          }
        }
      })
    })

    listEl.querySelectorAll('.save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.slug
        const protection = listEl.querySelector(`.edit-protection[data-slug="${slug}"]`).value
        const password = listEl.querySelector(`.edit-password[data-slug="${slug}"]`).value || null

        try {
          await admin.updateNotepad(slug, { protection, password })
          loadNotepads()
        } catch (err) {
          alert(err.message)
        }
      })
    })

    listEl.querySelectorAll('.edit-protection').forEach(select => {
      select.addEventListener('change', () => {
        const slug = select.dataset.slug
        const needsPassword = ['edit-protected', 'full-protected'].includes(select.value)
        const passwordRow = document.getElementById(`edit-form-${slug}`).querySelector('.password-row')
        passwordRow.classList.toggle('hidden', !needsPassword)
      })
    })

    listEl.querySelectorAll('.toggle-pwd').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = btn.previousElementSibling
        const isPassword = input.type === 'password'
        input.type = isPassword ? 'text' : 'password'
        btn.textContent = isPassword ? 'Hide' : 'Show'
      })
    })

  } catch (err) {
    if (err.message === 'Unauthorized') {
      admin.logout()
      renderAdmin()
    } else {
      listEl.innerHTML = `<p class="error">${err.message}</p>`
    }
  }
}

function formatProtection(p) {
  const labels = {
    'none': 'Open',
    'view-only': 'View Only',
    'edit-protected': 'Edit Protected',
    'full-protected': 'Fully Protected'
  }
  return labels[p] || p
}

// ============ Notepad UI ============

async function renderNotepad(slug) {
  const app = document.getElementById('app')

  // Get notepad info
  let info
  try {
    const data = await notepad.getInfo(slug)
    info = data.notepad
  } catch (err) {
    app.innerHTML = `
      <div class="auth-container">
        <h1>Notepad Not Found</h1>
        <p>The notepad "${slug}" does not exist.</p>
        <a href="/">Go Home</a>
      </div>
    `
    return
  }

  // Check protection type
  const isEditProtected = info.protection === 'edit-protected'
  const isFullProtected = info.protection === 'full-protected'
  const isViewOnly = info.protection === 'view-only'

  // Get saved values from localStorage
  const savedUsername = getSavedUsername()
  const savedPassword = getSavedPassword(slug)

  // Build info message based on protection type
  let infoMessage = ''
  if (isViewOnly) {
    infoMessage = '<p class="info">This notepad is read-only.</p>'
  } else if (isFullProtected) {
    infoMessage = '<p class="info">This notepad requires a password to view.</p>'
  }
  // For edit-protected, the message is shown within the toggle section

  app.innerHTML = `
    <div class="auth-container">
      <h1>Join "${slug}"</h1>
      ${infoMessage}
      <form id="join-form">
        <input type="text" id="join-name" placeholder="Your name" value="${savedUsername.replace(/"/g, '&quot;')}" required>
        ${isFullProtected ? `<input type="password" id="join-password" placeholder="Password" value="${savedPassword.replace(/"/g, '&quot;')}" required>` : ''}
        ${isEditProtected ? `
          <div class="edit-toggle-section">
            <label class="edit-toggle-label">
              <input type="checkbox" id="want-edit" ${savedPassword ? 'checked' : ''}>
              <span>I want to edit</span>
            </label>
            <div id="edit-password-section" class="${savedPassword ? '' : 'hidden'}">
              <input type="password" id="join-password" placeholder="Edit password" value="${savedPassword.replace(/"/g, '&quot;')}">
            </div>
          </div>
        ` : ''}
        <button type="submit">${isViewOnly ? 'View' : (isEditProtected ? 'Join' : 'Join')}</button>
        <div id="join-error" class="error"></div>
      </form>
    </div>
  `

  // Handle edit toggle for edit-protected notepads
  if (isEditProtected) {
    const wantEditCheckbox = document.getElementById('want-edit')
    const editPasswordSection = document.getElementById('edit-password-section')

    wantEditCheckbox.addEventListener('change', () => {
      editPasswordSection.classList.toggle('hidden', !wantEditCheckbox.checked)
    })
  }

  document.getElementById('join-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const userName = document.getElementById('join-name').value.trim()
    const errorEl = document.getElementById('join-error')

    // Determine password based on protection type
    let password = null
    if (isFullProtected) {
      password = document.getElementById('join-password').value
    } else if (isEditProtected) {
      const wantEdit = document.getElementById('want-edit').checked
      if (wantEdit) {
        password = document.getElementById('join-password').value
      }
    }

    try {
      const authData = await notepad.authenticate(slug, userName, password)
      // Save username globally and password for this notepad
      saveUsername(userName)
      if (password) {
        savePassword(slug, password)
      }
      startEditor(slug, authData.token, authData.canEdit, userName)
    } catch (err) {
      errorEl.textContent = err.message
    }
  })
}

function createThemeToggle() {
  const currentTheme = getSavedTheme()
  return `
    <select id="theme-toggle" class="theme-toggle">
      <option value="system" ${currentTheme === 'system' ? 'selected' : ''}>System</option>
      <option value="light" ${currentTheme === 'light' ? 'selected' : ''}>Light</option>
      <option value="dark" ${currentTheme === 'dark' ? 'selected' : ''}>Dark</option>
    </select>
  `
}

function attachThemeToggle() {
  const toggle = document.getElementById('theme-toggle')
  if (toggle) {
    toggle.addEventListener('change', (e) => {
      saveTheme(e.target.value)
      applyTheme()
    })
  }
}

function createBranding() {
  if (!SHOW_BRANDING) return ''
  return `
    <div class="branding">
      Powered by <a href="https://github.com/aapeliv/codebox" target="_blank">Codebox</a> by <a href="https://www.aapelivuorinen.com/" target="_blank">Aapeli</a>
    </div>
  `
}

function startEditor(slug, token, canEdit, userName) {
  const app = document.getElementById('app')

  app.innerHTML = `
    <header>
      <h1>Codebox</h1>
      <div class="doc-info">
        <span class="doc-slug">${slug}</span>
        <span class="doc-mode ${canEdit ? 'mode-edit' : 'mode-view'}">${canEdit ? 'Edit' : 'View Only'}</span>
      </div>
      <div class="controls">
        <span class="user-name">${userName}</span>
        <span id="status" class="status hidden">connecting</span>
        ${createThemeToggle()}
        <button id="connect-btn" class="hidden">Reconnect</button>
      </div>
    </header>
    <div id="editor"></div>
    ${createBranding()}
  `

  attachThemeToggle()

  // Initialize Yjs document
  const ydoc = new Y.Doc()

  // Connect with token
  const wsUrl = getWsUrl()
  const provider = new WebsocketProvider(wsUrl, slug, ydoc, {
    params: { token }
  })

  const ytext = ydoc.getText('monaco')

  // Create Monaco editor
  const editorTheme = getEffectiveTheme() === 'dark' ? 'vs-dark' : 'vs'
  const editor = monaco.editor.create(document.getElementById('editor'), {
    value: '',
    language: 'markdown',
    theme: editorTheme,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    lineNumbers: 'on',
    wordWrap: 'on',
    padding: { top: 16 },
    readOnly: !canEdit
  })

  // Bind Yjs to Monaco
  const monacoBinding = new MonacoBinding(
    ytext,
    editor.getModel(),
    new Set([editor]),
    provider.awareness
  )

  // Set awareness with user name and consistent color
  const userColor = getUserColor(userName)

  function updateAwareness() {
    provider.awareness.setLocalStateField('user', {
      name: userName,
      color: userColor,
      lastActive: Date.now()
    })
  }

  // Initial awareness update
  updateAwareness()

  // Heartbeat: update awareness every 5 seconds to show we're still alive
  const heartbeatInterval = setInterval(updateAwareness, 5000)

  // Create dynamic styles for remote cursors with names
  const styleSheet = document.createElement('style')
  document.head.appendChild(styleSheet)

  // Track when each user was last "active" (typing/moving cursor)
  // and their last known cursor position to detect actual movement
  const userLastActivity = new Map()
  const userLastCursor = new Map() // Track cursor position to detect real movement
  const NAME_SHOW_DURATION = 2000 // Show name for 2 seconds after activity

  function updateCursorStyles() {
    const states = provider.awareness.getStates()
    const now = Date.now()
    let styles = ''

    states.forEach((state, clientId) => {
      if (clientId === provider.awareness.clientID) return // Skip self
      if (!state.user) return

      // Skip users who haven't sent a heartbeat in 15 seconds
      if (state.user.lastActive && (now - state.user.lastActive) > 15000) {
        return
      }

      const { name, color } = state.user
      const escapedName = name.replace(/"/g, '\\"').replace(/'/g, "\\'")

      // Check if this user was recently active (show name) or idle (show dot)
      const lastActivity = userLastActivity.get(clientId) || 0
      const isRecentlyActive = (now - lastActivity) < NAME_SHOW_DURATION

      styles += `
        .yRemoteSelection-${clientId} {
          background-color: ${color}40 !important;
        }
        .yRemoteSelectionHead-${clientId} {
          border-left-color: ${color} !important;
        }
        .yRemoteSelectionHead-${clientId}::after {
          content: '' !important;
          position: absolute !important;
          width: 6px !important;
          height: 6px !important;
          border-radius: 50% !important;
          background-color: ${color} !important;
          left: -4px !important;
          top: -3px !important;
          opacity: ${isRecentlyActive ? '0' : '1'} !important;
          transition: opacity 0.2s ease !important;
        }
        .yRemoteSelectionHead-${clientId}::before {
          content: "${escapedName}" !important;
          position: absolute !important;
          top: -18px !important;
          left: -2px !important;
          background-color: ${color} !important;
          color: white !important;
          font-size: 10px !important;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
          padding: 2px 6px !important;
          border-radius: 3px 3px 3px 0 !important;
          white-space: nowrap !important;
          font-weight: 500 !important;
          z-index: 1000 !important;
          pointer-events: none !important;
          opacity: ${isRecentlyActive ? '1' : '0'} !important;
          transition: opacity 0.3s ease !important;
        }
        .yRemoteSelectionHead-${clientId}:hover::before {
          opacity: 1 !important;
        }
        .yRemoteSelectionHead-${clientId}:hover::after {
          opacity: 0 !important;
        }
      `
    })

    styleSheet.textContent = styles
  }

  // Check if cursor/selection position actually changed (not just heartbeat)
  function getSelectionKey(state) {
    if (!state || !state.selection) return null
    // y-monaco stores selection with anchor and head as relative positions
    const sel = state.selection
    if (!sel.anchor || !sel.head) return null
    // Stringify the relative positions to detect changes
    return JSON.stringify({ anchor: sel.anchor, head: sel.head })
  }

  // Update cursor styles when awareness changes
  provider.awareness.on('change', ({ added, updated }) => {
    const now = Date.now()
    const states = provider.awareness.getStates()

    // Only mark users as active when their selection actually changed
    ;[...added, ...updated].forEach(clientId => {
      if (clientId === provider.awareness.clientID) return

      const state = states.get(clientId)
      const newSelectionKey = getSelectionKey(state)
      const oldSelectionKey = userLastCursor.get(clientId)

      // Only trigger activity if selection changed or user is new
      if (added.includes(clientId) || newSelectionKey !== oldSelectionKey) {
        userLastActivity.set(clientId, now)
        userLastCursor.set(clientId, newSelectionKey)
      }
    })

    updateCursorStyles()

    // Schedule another update after the name should hide
    setTimeout(updateCursorStyles, NAME_SHOW_DURATION + 100)
  })

  // Also periodically check for stale cursors (users who stopped sending heartbeats)
  const staleCheckInterval = setInterval(updateCursorStyles, 5000)

  // Cleanup on disconnect
  provider.on('status', ({ status }) => {
    if (status === 'disconnected') {
      clearInterval(heartbeatInterval)
      clearInterval(staleCheckInterval)
    }
  })

  // Connection status - only show when disconnected
  const statusEl = document.getElementById('status')
  const connectBtn = document.getElementById('connect-btn')

  provider.on('status', ({ status }) => {
    statusEl.textContent = status
    statusEl.className = `status ${status}`

    // Only show status and reconnect button when disconnected
    if (status === 'connected') {
      statusEl.classList.add('hidden')
      connectBtn.classList.add('hidden')
    } else {
      statusEl.classList.remove('hidden')
      connectBtn.classList.remove('hidden')
    }
  })

  // Reconnect button
  connectBtn.addEventListener('click', () => {
    provider.connect()
  })

  window.codebox = { ydoc, provider, ytext, editor, monacoBinding }
}

// ============ Home UI ============

function renderHome() {
  const app = document.getElementById('app')

  app.innerHTML = `
    <div class="home-container">
      <h1>Codebox</h1>
      <p>Collaborative note-taking for your team.</p>
      <div class="home-actions">
        <a href="/admin" class="btn">Admin</a>
      </div>
    </div>
  `
}

// ============ Router ============

window.addEventListener('load', () => {
  const route = getRoute()

  switch (route.type) {
    case 'admin':
      renderAdmin()
      break
    case 'notepad':
      renderNotepad(route.slug)
      break
    default:
      renderHome()
  }
})
