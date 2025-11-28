import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

const SALT_ROUNDS = 12

export function initAuth(dataDir) {
  const adminFile = path.join(dataDir, 'admin.json')

  // Load or initialize admin data
  let adminData = { passwordHash: null, jwtSecret: null }
  if (fs.existsSync(adminFile)) {
    try {
      adminData = JSON.parse(fs.readFileSync(adminFile, 'utf-8'))
    } catch (err) {
      console.error('Error loading admin data:', err)
    }
  }

  function saveAdminData() {
    fs.writeFileSync(adminFile, JSON.stringify(adminData, null, 2))
  }

  // Generate JWT secret if not present
  if (!adminData.jwtSecret) {
    adminData.jwtSecret = crypto.randomBytes(64).toString('hex')
    saveAdminData()
    console.log('Generated new JWT secret')
  }

  // Allow env override for JWT secret
  const JWT_SECRET = process.env.JWT_SECRET || adminData.jwtSecret

  // Check if admin password is set
  function isAdminSetup() {
    return adminData.passwordHash !== null
  }

  // Set admin password (for initial setup or password change)
  async function setAdminPassword(password) {
    adminData.passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
    saveAdminData()
  }

  // Check admin credentials
  async function checkAdminCred(password) {
    if (!adminData.passwordHash) {
      return false
    }
    return bcrypt.compare(password, adminData.passwordHash)
  }

  // Generate admin JWT token
  function generateAdminToken() {
    return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' })
  }

  // Verify admin JWT token
  function verifyAdminToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET)
      return decoded.role === 'admin'
    } catch (err) {
      return false
    }
  }

  // Generate user access token for a notepad
  function generateAccessToken(slug, canEdit) {
    return jwt.sign({ slug, canEdit }, JWT_SECRET, { expiresIn: '24h' })
  }

  // Verify user access token
  function verifyAccessToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET)
    } catch (err) {
      return null
    }
  }

  return {
    isAdminSetup,
    setAdminPassword,
    checkAdminCred,
    generateAdminToken,
    verifyAdminToken,
    generateAccessToken,
    verifyAccessToken
  }
}
