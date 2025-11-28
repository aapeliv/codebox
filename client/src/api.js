// API client for codebox

const API_BASE = ''

function getAdminToken() {
  return localStorage.getItem('adminToken')
}

function setAdminToken(token) {
  localStorage.setItem('adminToken', token)
}

function clearAdminToken() {
  localStorage.removeItem('adminToken')
}

async function apiRequest(method, path, body = null, useAdminAuth = false) {
  const headers = {
    'Content-Type': 'application/json'
  }

  if (useAdminAuth) {
    const token = getAdminToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || 'Request failed')
  }

  return data
}

// Admin API
export const admin = {
  async getStatus() {
    return apiRequest('GET', '/api/admin/status')
  },

  async setup(password) {
    return apiRequest('POST', '/api/admin/setup', { password })
  },

  async login(password) {
    const data = await apiRequest('POST', '/api/admin/login', { password })
    setAdminToken(data.token)
    return data
  },

  logout() {
    clearAdminToken()
  },

  isLoggedIn() {
    return !!getAdminToken()
  },

  async listNotepads() {
    return apiRequest('GET', '/api/admin/notepads', null, true)
  },

  async createNotepad(slug, protection = 'none', password = null) {
    return apiRequest('POST', '/api/admin/notepads', { slug, protection, password }, true)
  },

  async updateNotepad(slug, updates) {
    return apiRequest('PUT', `/api/admin/notepads/${encodeURIComponent(slug)}`, updates, true)
  },

  async deleteNotepad(slug) {
    return apiRequest('DELETE', `/api/admin/notepads/${encodeURIComponent(slug)}`, null, true)
  }
}

// Notepad API (public)
export const notepad = {
  async getInfo(slug) {
    return apiRequest('GET', `/api/notepads/${encodeURIComponent(slug)}`)
  },

  async authenticate(slug, userName, password = null) {
    return apiRequest('POST', `/api/notepads/${encodeURIComponent(slug)}/auth`, {
      userName,
      password
    })
  }
}
