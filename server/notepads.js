import fs from 'fs'
import path from 'path'

// Protection levels:
// - "none": anyone can view and edit
// - "view-only": anyone can view, no one can edit
// - "edit-protected": anyone can view, password required to edit
// - "full-protected": password required to view and edit

export function initNotepads(dataDir) {
  const notepadsFile = path.join(dataDir, 'notepads.json')

  // Load or initialize notepads data
  let notepads = {}
  if (fs.existsSync(notepadsFile)) {
    try {
      notepads = JSON.parse(fs.readFileSync(notepadsFile, 'utf-8'))
    } catch (err) {
      console.error('Error loading notepads data:', err)
    }
  }

  function save() {
    fs.writeFileSync(notepadsFile, JSON.stringify(notepads, null, 2))
  }

  function list() {
    return Object.values(notepads)
  }

  function get(slug) {
    return notepads[slug] || null
  }

  function exists(slug) {
    return slug in notepads
  }

  function create(slug, protection = 'none', password = null) {
    if (exists(slug)) {
      throw new Error('Notepad already exists')
    }
    if (!isValidSlug(slug)) {
      throw new Error('Invalid slug format')
    }
    notepads[slug] = {
      slug,
      protection,
      password,
      createdAt: new Date().toISOString()
    }
    save()
    return notepads[slug]
  }

  function update(slug, updates) {
    if (!exists(slug)) {
      throw new Error('Notepad not found')
    }
    const notepad = notepads[slug]

    if (updates.protection !== undefined) {
      notepad.protection = updates.protection
    }
    if (updates.password !== undefined) {
      notepad.password = updates.password
    }
    if (updates.newSlug !== undefined && updates.newSlug !== slug) {
      if (!isValidSlug(updates.newSlug)) {
        throw new Error('Invalid slug format')
      }
      if (exists(updates.newSlug)) {
        throw new Error('New slug already exists')
      }
      // Rename the notepad
      notepad.slug = updates.newSlug
      notepads[updates.newSlug] = notepad
      delete notepads[slug]
    }

    save()
    return notepad
  }

  function remove(slug) {
    if (!exists(slug)) {
      throw new Error('Notepad not found')
    }
    delete notepads[slug]
    save()
  }

  // Check if user can access notepad (view)
  function canView(slug, providedPassword = null) {
    const notepad = get(slug)
    if (!notepad) {
      return { allowed: false, reason: 'not-found' }
    }

    switch (notepad.protection) {
      case 'none':
      case 'view-only':
      case 'edit-protected':
        return { allowed: true }
      case 'full-protected':
        if (notepad.password && providedPassword === notepad.password) {
          return { allowed: true }
        }
        return { allowed: false, reason: 'password-required' }
      default:
        return { allowed: false, reason: 'unknown-protection' }
    }
  }

  // Check if user can edit notepad
  function canEdit(slug, providedPassword = null) {
    const notepad = get(slug)
    if (!notepad) {
      return { allowed: false, reason: 'not-found' }
    }

    switch (notepad.protection) {
      case 'none':
        return { allowed: true }
      case 'view-only':
        return { allowed: false, reason: 'read-only' }
      case 'edit-protected':
      case 'full-protected':
        if (notepad.password && providedPassword === notepad.password) {
          return { allowed: true }
        }
        return { allowed: false, reason: 'password-required' }
      default:
        return { allowed: false, reason: 'unknown-protection' }
    }
  }

  // Get public info about a notepad (safe to send to unauthenticated users)
  function getPublicInfo(slug) {
    const notepad = get(slug)
    if (!notepad) {
      return null
    }
    return {
      slug: notepad.slug,
      protection: notepad.protection,
      requiresPassword: notepad.protection === 'edit-protected' || notepad.protection === 'full-protected'
    }
  }

  return {
    list,
    get,
    exists,
    create,
    update,
    remove,
    canView,
    canEdit,
    getPublicInfo
  }
}

function isValidSlug(slug) {
  // Allow alphanumeric, hyphens, underscores, 1-100 chars
  return /^[a-zA-Z0-9_-]{1,100}$/.test(slug)
}
