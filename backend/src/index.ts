import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { PrismaClient, Prisma } from '@prisma/client'
import * as trpcExpress from '@trpc/server/adapters/express'
import { appRouter } from './trpc'

import { maintenanceRouter, partsOrderingRouter, maintenanceData, tctoRouter, pmiRouter, shippingRouter, sortieRouter, configurationRouter, notificationRouter, inventoryRouter, reportsRouter, sparesRouter, bitPcRouter, softwareRouter, meterRouter } from "./services"
// Load environment variables
dotenv.config()

// Global error handlers to prevent server crashes from unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[SERVER] Unhandled Rejection at:', promise, 'reason:', reason)
  // Don't crash the server - just log the error
})

process.on('uncaughtException', (error) => {
  console.error('[SERVER] Uncaught Exception:', error)
  // Log but don't exit - let the server try to continue
})

// Initialize Prisma Client
const prisma = new PrismaClient()

// Configure uploads directory
const UPLOADS_DIR = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR)
  },
  filename: (_req, file, cb) => {
    // Generate unique filename with timestamp and original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname)
    cb(null, `attachment-${uniqueSuffix}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    // Allow common document and image types
    const allowedMimeTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ]
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Invalid file type. Only PDF, images, Word, Excel, and text files are allowed.'))
    }
  }
})

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
// In production, when frontend is served from /public, we need permissive CORS
const isProduction = process.env.NODE_ENV === 'production'

app.use(cors({
  origin: isProduction
    ? true // Allow all origins in production (same-origin + any proxy)
    : (origin, callback) => {
      // Development: strict CORS for localhost
      const allowedOrigins = [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        'http://localhost:5176',
        'http://localhost:5177',
        'http://localhost:5178',
        'http://localhost:5179',
        'http://localhost:5180',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:5174',
        'http://127.0.0.1:5175',
        'http://127.0.0.1:5176',
        'http://127.0.0.1:5177',
        'http://127.0.0.1:5178',
        'http://127.0.0.1:5179',
        'http://127.0.0.1:5180',        'http://192.168.7.59:5173',        'http://192.168.7.59:5174',        'http://192.168.7.90:5173',
      ]

      // Allow FRONTEND_URL from env if set
      const frontendUrl = process.env.FRONTEND_URL
      if (frontendUrl && !allowedOrigins.includes(frontendUrl)) {
        allowedOrigins.push(frontendUrl)
      }

      // Allow requests with no origin (same-origin, curl, etc.)
      if (!origin) return callback(null, true)

      if (allowedOrigins.includes(origin)) {
        callback(null, true)
      } else {
        callback(new Error('Not allowed by CORS'))
      }
    },
  credentials: true,
}))
app.use(express.json())

// Serve static files from uploads directory
app.use('/uploads', express.static(UPLOADS_DIR))

// Serve static frontend files from public directory (frontend build)
app.use(express.static(path.join(__dirname, '../public')))

// V2 Maintenance API - Database-backed with workflow cascade
app.use("/api/v2/maintenance", maintenanceRouter)
app.use("/api/v2/parts", partsOrderingRouter)
app.use("/api/v2/tcto", tctoRouter)
app.use("/api/v2/pmi", pmiRouter)
app.use("/api/v2/shipping", shippingRouter)
app.use("/api/v2/sorties", sortieRouter)
app.use("/api/v2/config", configurationRouter)
app.use("/api/v2/notifications", notificationRouter)
app.use("/api/v2/inventory", inventoryRouter)
app.use("/api/v2/reports", reportsRouter)
app.use("/api/v2/spares", sparesRouter)
app.use("/api/v2/bitpc", bitPcRouter)
app.use("/api/v2/software", softwareRouter)
app.use("/api/v2/meters", meterRouter)

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'RIMSS API',
    version: '0.1.0',
  })
})

// ============================================================================
// Code Lookup Cache - for resolving code IDs to actual code values
// ============================================================================
// This cache maps string code IDs (from original Oracle data) to code values
// The location table stores original Oracle CODE_IDs as strings (e.g., "24892")
// which need to be resolved to actual code values (e.g., "AFGSC")
let codeCache: Map<string, { code_type: string; code_value: string; description: string | null }> | null = null;

async function loadCodeCache(): Promise<Map<string, { code_type: string; code_value: string; description: string | null }>> {
  if (codeCache) return codeCache;

  console.log('[CODE-CACHE] Loading code lookup cache...');

  // Try to load from the original CSV file which has the Oracle CODE_IDs
  const csvPath = path.join(process.cwd(), '..', 'data', 'GLOBALEYE.code.csv');
  if (fs.existsSync(csvPath)) {
    console.log('[CODE-CACHE] Loading from CSV file:', csvPath);
    codeCache = new Map();

    const fileContent = fs.readFileSync(csvPath, 'utf-8');
    const lines = fileContent.split('\n');

    // Skip header lines (SQL> and column headers)
    let startLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('"CODE_ID"')) {
        startLine = i + 1;
        break;
      }
    }

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Parse CSV line - format: CODE_ID,CODE_TYPE,CODE_VALUE,DESCRIPTION,...
      const match = line.match(/^(\d+),"([^"]+)","([^"]*)"(?:,"([^"]*)")?/);
      if (match) {
        const [, codeId, codeType, codeValue, description] = match;
        codeCache.set(codeId, {
          code_type: codeType,
          code_value: codeValue,
          description: description || null
        });
      }
    }
    console.log(`[CODE-CACHE] Loaded ${codeCache.size} codes from CSV`);
  } else {
    // Fallback: load from database (may have ID mismatch, but try anyway)
    console.log('[CODE-CACHE] CSV not found at', csvPath, '- loading from database');
    const codes = await prisma.code.findMany({
      select: { code_id: true, code_type: true, code_value: true, description: true }
    });

    codeCache = new Map();
    for (const code of codes) {
      codeCache.set(String(code.code_id), {
        code_type: code.code_type,
        code_value: code.code_value,
        description: code.description
      });
    }
    console.log(`[CODE-CACHE] Loaded ${codeCache.size} codes from database`);
  }

  return codeCache;
}

// Helper to resolve a code ID (stored as string) to its actual code value
function resolveCodeId(codeId: string | null, cache: Map<string, { code_type: string; code_value: string; description: string | null }>): string {
  if (!codeId) return '';

  // Trim whitespace - Oracle exports often have padded values
  const trimmedId = codeId.trim();

  // Try direct lookup with the trimmed string ID
  const code = cache.get(trimmedId);
  if (code) {
    return code.code_value;
  }

  // If not found, return original trimmed value (might already be a code value)
  return trimmedId;
}

// tRPC middleware - type-safe API endpoints
app.use(
  '/api/trpc',
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext: () => ({}), // Empty context for now
    onError: ({ error, path }) => {
      // Log full error details on server for debugging
      console.error(`[tRPC Error] ${path}:`, error.message);

      // Remove stack trace from error response to avoid exposing internal paths
      // This prevents sensitive information like file paths from being sent to clients
      if (error.stack) {
        delete (error as unknown as { stack?: string }).stack;
      }
      // Also remove any internal data that might contain stack traces
      if (error.cause && typeof error.cause === 'object' && 'stack' in error.cause) {
        delete (error.cause as { stack?: string }).stack;
      }
    },
  })
)

// Maintenance level types
// SHOP (I-level): Field maintenance - can REQUEST parts
// DEPOT (D-level): Depot maintenance - can ACKNOWLEDGE, FILL, SHIP parts orders
type MaintenanceLevel = 'SHOP' | 'DEPOT';

// Mock user data for testing
const mockUsers = [
  {
    user_id: 1,
    username: 'admin',
    email: 'admin@example.mil',
    first_name: 'John',
    last_name: 'Admin',
    role: 'ADMIN',
    programs: [
      { pgm_id: 2, pgm_cd: 'ACTS', pgm_name: 'Advanced Targeting Capability System', is_default: true },
      { pgm_id: 1, pgm_cd: 'CRIIS', pgm_name: 'Common Remotely Operated Integrated Reconnaissance System', is_default: false },
      { pgm_id: 3, pgm_cd: 'ARDS', pgm_name: 'Airborne Reconnaissance Data System', is_default: false },
      { pgm_id: 4, pgm_cd: '236', pgm_name: 'Program 236', is_default: false },
    ],
    locations: [
      // ACTS locations (mapped from Oracle IDs via id-mappings-v2.json)
      { loc_id: 41, display_name: 'Shaw AFB - 20 FW', is_default: true, pgm_id: 2 }, // Oracle 18 -> PG 41
      { loc_id: 24, display_name: 'Langley AFB - 1 FW', is_default: false, pgm_id: 2 }, // Oracle 1 -> PG 24
      { loc_id: 46, display_name: 'Hill AFB - 388 FW', is_default: false, pgm_id: 2 }, // Oracle 24 -> PG 46
      { loc_id: 50, display_name: 'Luke AFB - 56 FW', is_default: false, pgm_id: 2 }, // Oracle 28 -> PG 50
    ],
    // Admin has access to both SHOP and DEPOT maintenance levels
    allowedMaintenanceLevels: ['DEPOT', 'SHOP'] as MaintenanceLevel[],
  },
  {
    user_id: 2,
    username: 'depot_mgr',
    email: 'depot@example.mil',
    first_name: 'Jane',
    last_name: 'Depot',
    role: 'DEPOT_MANAGER',
    programs: [
      { pgm_id: 2, pgm_cd: 'ACTS', pgm_name: 'Advanced Targeting Capability System', is_default: true },
    ],
    locations: [
      { loc_id: 41, display_name: 'Shaw AFB - 20 FW', is_default: true, pgm_id: 2 }, // ACTS DEPOT location
    ],
    // Depot manager has DEPOT level - can fulfill parts orders
    allowedMaintenanceLevels: ['DEPOT'] as MaintenanceLevel[],
  },
  {
    user_id: 3,
    username: 'field_tech',
    email: 'field@example.mil',
    first_name: 'Bob',
    last_name: 'Field',
    role: 'FIELD_TECHNICIAN',
    programs: [
      { pgm_id: 2, pgm_cd: 'ACTS', pgm_name: 'Advanced Targeting Capability System', is_default: true },
    ],
    locations: [
      { loc_id: 24, display_name: 'Langley AFB - 1 FW', is_default: true, pgm_id: 2 }, // ACTS SHOP location
    ],
    // Field technician has SHOP level - can request parts but not fulfill
    allowedMaintenanceLevels: ['SHOP'] as MaintenanceLevel[],
  },
  {
    user_id: 4,
    username: 'viewer',
    email: 'viewer@example.mil',
    first_name: 'Sam',
    last_name: 'Viewer',
    role: 'VIEWER',
    programs: [
      { pgm_id: 2, pgm_cd: 'ACTS', pgm_name: 'Advanced Targeting Capability System', is_default: true },
    ],
    locations: [],
    // Viewer has no maintenance level - read-only access
    allowedMaintenanceLevels: [] as MaintenanceLevel[],
  },
  {
    user_id: 5,
    username: 'acts_user',
    email: 'acts@example.mil',
    first_name: 'Alice',
    last_name: 'ACTS',
    role: 'FIELD_TECHNICIAN',
    programs: [
      { pgm_id: 2, pgm_cd: 'ACTS', pgm_name: 'Advanced Targeting Capability System', is_default: true },
    ],
    locations: [
      { loc_id: 41, display_name: 'Shaw AFB - 20 FW', is_default: true, pgm_id: 2 }, // Oracle 18 -> PG 41
      { loc_id: 46, display_name: 'Hill AFB - 388 FW', is_default: false, pgm_id: 2 }, // Oracle 24 -> PG 46
    ],
    // Field technician at ACTS has SHOP level
    allowedMaintenanceLevels: ['SHOP'] as MaintenanceLevel[],
  },
]

// Mock passwords (in real app, these would be hashed)
const mockPasswords: Record<string, string> = {
  admin: 'admin123',
  depot_mgr: 'depot123',
  field_tech: 'field123',
  viewer: 'viewer123',
  acts_user: 'acts123',
}

// Token blacklist - stores invalidated tokens
const tokenBlacklist = new Set<string>()

// Mock JWT token generator (simple base64 encoding for testing)
function generateMockToken(userId: number): string {
  const payload = { userId, iat: Date.now(), exp: Date.now() + 30 * 60 * 1000 }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

// Parse mock token
function parseMockToken(token: string): { userId: number } | null {
  try {
    // Check if token is blacklisted
    if (tokenBlacklist.has(token)) {
      return null // Token has been invalidated
    }

    const payload = JSON.parse(Buffer.from(token, 'base64').toString())
    if (payload.exp < Date.now()) return null // Token expired
    return payload
  } catch {
    return null
  }
}

// Helper to resolve location display names using code cache
async function resolveUserLocations(
  locations: Array<{ loc_id: number; display_name: string; is_default: boolean; pgm_id?: number }>,
  codes: Map<string, { code_type: string; code_value: string; description: string | null }>
): Promise<Array<{ loc_id: number; display_name: string; is_default: boolean; pgm_id?: number }>> {
  if (!locations || locations.length === 0) return locations;

  // Fetch actual location data from database
  const locIds = locations.map(l => l.loc_id);
  const dbLocations = await prisma.location.findMany({
    where: { loc_id: { in: locIds } },
    select: { loc_id: true, majcom_cd: true, site_cd: true, unit_cd: true, display_name: true }
  });

  const dbLocMap = new Map(dbLocations.map(l => [l.loc_id, l]));

  return locations.map(loc => {
    const dbLoc = dbLocMap.get(loc.loc_id);
    if (!dbLoc) return loc;

    // Resolve the majcom, site, unit IDs to actual codes using string keys
    const majcom = dbLoc.majcom_cd ? resolveCodeId(dbLoc.majcom_cd, codes) : '';
    const site = dbLoc.site_cd ? resolveCodeId(dbLoc.site_cd, codes) : '';
    const unit = dbLoc.unit_cd ? resolveCodeId(dbLoc.unit_cd, codes) : '';

    // Build display name from resolved codes
    const parts = [majcom, site, unit].filter(Boolean);
    const resolvedDisplayName = parts.length > 0 ? parts.join('/') : loc.display_name;

    return {
      ...loc,
      display_name: resolvedDisplayName
    };
  });
}

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }

  const user = mockUsers.find(u => u.username === username)
  if (!user || mockPasswords[username] !== password) {
    return res.status(401).json({ error: 'Invalid username or password' })
  }

  try {
    // Load code cache and resolve location display names
    const codes = await loadCodeCache();
    const resolvedLocations = await resolveUserLocations(user.locations, codes);

    const userWithResolvedData = {
      ...user,
      locations: resolvedLocations,
      allowedMaintenanceLevels: user.allowedMaintenanceLevels || []
    };

    const token = generateMockToken(user.user_id)
    console.log(`[LOGIN] User ${user.username} logged in with maintenance levels: ${user.allowedMaintenanceLevels?.join(', ') || 'none'}`);
    res.json({ token, user: userWithResolvedData })
  } catch (error) {
    console.error('[LOGIN] Error resolving locations:', error);
    // Fallback to original user data if resolution fails
    const token = generateMockToken(user.user_id)
    res.json({ token, user: { ...user, allowedMaintenanceLevels: user.allowedMaintenanceLevels || [] } })
  }
})

// Get current user endpoint
app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const token = authHeader.substring(7)
  const payload = parseMockToken(token)

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user) {
    return res.status(401).json({ error: 'User not found' })
  }

  try {
    // Load code cache and resolve location display names
    const codes = await loadCodeCache();
    const resolvedLocations = await resolveUserLocations(user.locations, codes);

    const userWithResolvedData = {
      ...user,
      locations: resolvedLocations,
      allowedMaintenanceLevels: user.allowedMaintenanceLevels || []
    };

    res.json({ user: userWithResolvedData })
  } catch (error) {
    console.error('[AUTH/ME] Error resolving locations:', error);
    // Fallback to original user data if resolution fails
    res.json({ user: { ...user, allowedMaintenanceLevels: user.allowedMaintenanceLevels || [] } })
  }
})

// Global search endpoint - searches across assets, maintenance events, and configurations
app.get('/api/search', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const token = authHeader.substring(7)
  const payload = parseMockToken(token)

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user) {
    return res.status(401).json({ error: 'User not found' })
  }

  // Get search query parameter (required)
  const query = (req.query.q as string || '').trim().toLowerCase()

  if (!query || query.length < 2) {
    return res.json({
      assets: [],
      events: [],
      configurations: [],
      message: 'Search query must be at least 2 characters'
    })
  }

  console.log(`[SEARCH] User ${user.username} searching for: "${query}"`)

  // Get user's location IDs for authorization check
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || []
  const userProgramIds = user.programs?.map(p => p.pgm_id) || []

  console.log(`[SEARCH] User locations: ${userLocationIds.join(', ')}`)
  console.log(`[SEARCH] User programs: ${userProgramIds.join(', ')}`)

  // Search assets (filter by program AND location)
  let matchingAssets = detailedAssets.filter(asset => {
    // Only include active assets from user's programs
    if (asset.active === false) return false
    if (!userProgramIds.includes(asset.pgm_id)) return false

    // Apply location filtering
    if (userLocationIds.length > 0) {
      const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida)
      const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc)
      if (!matchesAssignedBase && !matchesCurrentBase) {
        return false
      }
    }

    // Search in asset fields
    const serialMatch = asset.serno?.toLowerCase().includes(query)
    const partMatch = asset.partno?.toLowerCase().includes(query)
    const nameMatch = asset.part_name?.toLowerCase().includes(query)
    const uiiMatch = asset.uii?.toLowerCase().includes(query)

    return serialMatch || partMatch || nameMatch || uiiMatch
  })

  // Limit asset results to 20
  matchingAssets = matchingAssets.slice(0, 20)

  console.log(`[SEARCH] Found ${matchingAssets.length} matching assets`)

  // Search maintenance events (filter by program AND location via asset join)
  let matchingEvents = maintenanceEvents.filter(event => {
    // Find the associated asset
    const asset = detailedAssets.find(a => a.asset_id === event.asset_id)
    if (!asset) return false

    // Only include events from user's programs
    if (!userProgramIds.includes(event.pgm_id)) return false

    // Apply location filtering via asset
    if (userLocationIds.length > 0) {
      const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida)
      const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc)
      if (!matchesAssignedBase && !matchesCurrentBase) {
        return false
      }
    }

    // Search in event fields
    const eventNumMatch = event.event_num?.toLowerCase().includes(query)
    const descriptionMatch = event.description?.toLowerCase().includes(query)
    const remarksMatch = event.remarks?.toLowerCase().includes(query)

    return eventNumMatch || descriptionMatch || remarksMatch
  })

  // Limit event results to 20
  matchingEvents = matchingEvents.slice(0, 20)

  console.log(`[SEARCH] Found ${matchingEvents.length} matching events`)

  // Search configurations (filter by program AND location via assets in config)
  let matchingConfigurations = configurations.filter(config => {
    // Only include configs from user's programs
    if (!userProgramIds.includes(config.pgm_id)) return false

    // For location filtering, check if any asset in this configuration set belongs to user's locations
    if (userLocationIds.length > 0) {
      const configAssets = detailedAssets.filter(a =>
        a.cfg_set_id === config.cfg_set_id && a.active !== false
      )

      const hasAccessibleAsset = configAssets.some(asset => {
        const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida)
        const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc)
        return matchesAssignedBase || matchesCurrentBase
      })

      if (!hasAccessibleAsset) {
        return false
      }
    }

    // Search in configuration fields
    const nameMatch = config.name?.toLowerCase().includes(query)
    const descriptionMatch = config.description?.toLowerCase().includes(query)
    const versionMatch = config.version?.toLowerCase().includes(query)

    return nameMatch || descriptionMatch || versionMatch
  })

  // Limit configuration results to 20
  matchingConfigurations = matchingConfigurations.slice(0, 20)

  console.log(`[SEARCH] Found ${matchingConfigurations.length} matching configurations`)

  // Format results for frontend
  const assetResults = matchingAssets.map(asset => ({
    id: asset.asset_id,
    type: 'asset' as const,
    title: `${asset.serno} - ${asset.part_name}`,
    subtitle: asset.partno,
    status: asset.status_cd,
    location: asset.admin_loc_name || asset.cust_loc_name,
    url: `/assets/${asset.asset_id}`
  }))

  const eventResults = matchingEvents.map(event => {
    const asset = detailedAssets.find(a => a.asset_id === event.asset_id)
    return {
      id: event.event_id,
      type: 'event' as const,
      title: `Event ${event.event_num}`,
      subtitle: event.description,
      status: event.status,
      asset: asset ? `${asset.serno} - ${asset.part_name}` : 'Unknown Asset',
      url: `/maintenance/${event.event_id}`
    }
  })

  const configResults = matchingConfigurations.map(config => ({
    id: config.cfg_set_id,
    type: 'configuration' as const,
    title: config.name,
    subtitle: config.description,
    version: config.version,
    url: `/configurations/${config.cfg_set_id}`
  }))

  const totalResults = assetResults.length + eventResults.length + configResults.length

  res.json({
    query,
    totalResults,
    assets: assetResults,
    events: eventResults,
    configurations: configResults
  })
})

// Token refresh endpoint
app.post('/api/auth/refresh', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const token = authHeader.substring(7)
  const payload = parseMockToken(token)

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user) {
    return res.status(401).json({ error: 'User not found' })
  }

  // Generate a new token with extended expiration
  const newToken = generateMockToken(user.user_id)
  console.log(`[AUTH] Token refreshed for user: ${user.username}`)
  res.json({ token: newToken, user })
})

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    // Add token to blacklist to invalidate it
    tokenBlacklist.add(token)
    console.log(`[AUTH] Token blacklisted on logout (total blacklisted: ${tokenBlacklist.size})`)
  }
  res.json({ message: 'Logged out successfully' })
})

// Change password endpoint
app.post('/api/auth/change-password', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const token = authHeader.substring(7)
  const payload = parseMockToken(token)

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user) {
    return res.status(401).json({ error: 'User not found' })
  }

  const { currentPassword, newPassword, confirmPassword } = req.body

  // Validate required fields
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'All password fields are required' })
  }

  // Verify current password
  if (mockPasswords[user.username] !== currentPassword) {
    return res.status(400).json({ error: 'Current password is incorrect' })
  }

  // Verify new passwords match
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New passwords do not match' })
  }

  // Validate new password requirements (12+ chars, uppercase, lowercase, number, special char)
  if (newPassword.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' })
  }
  if (!/[A-Z]/.test(newPassword)) {
    return res.status(400).json({ error: 'Password must contain at least one uppercase letter' })
  }
  if (!/[a-z]/.test(newPassword)) {
    return res.status(400).json({ error: 'Password must contain at least one lowercase letter' })
  }
  if (!/[0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'Password must contain at least one number' })
  }
  if (!/[^A-Za-z0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'Password must contain at least one special character' })
  }

  // Check new password is different from current
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'New password must be different from current password' })
  }

  // Update the password
  mockPasswords[user.username] = newPassword

  console.log(`[AUTH] Password changed for user: ${user.username}`)

  res.json({ message: 'Password changed successfully' })
})

// Update own profile endpoint (for any authenticated user)
app.put('/api/profile', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const token = authHeader.substring(7)
  const payload = parseMockToken(token)

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  const userIndex = mockUsers.findIndex(u => u.user_id === payload.userId)
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' })
  }

  const existingUser = mockUsers[userIndex]
  const { email, first_name, last_name } = req.body

  // Validate required fields
  if (!email || !first_name || !last_name) {
    return res.status(400).json({ error: 'Email, first name, and last name are required' })
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' })
  }

  // Check for duplicate email (excluding current user)
  if (mockUsers.find(u => u.email.toLowerCase() === email.toLowerCase() && u.user_id !== payload.userId)) {
    return res.status(400).json({ error: 'Email already exists' })
  }

  // Update the user (only email, first_name, last_name - no role/programs/username changes)
  const updatedUser = {
    ...existingUser,
    email,
    first_name,
    last_name,
  }

  mockUsers[userIndex] = updatedUser

  console.log(`[PROFILE] User profile updated: ${existingUser.username} (ID: ${payload.userId})`)

  res.json({
    message: 'Profile updated successfully',
    user: updatedUser
  })
})

// Programs list
const allPrograms = [
  { pgm_id: 1, pgm_cd: 'CRIIS', pgm_name: 'Common Remotely Operated Integrated Reconnaissance System' },
  { pgm_id: 2, pgm_cd: 'ACTS', pgm_name: 'Advanced Targeting Capability System' },
  { pgm_id: 3, pgm_cd: 'ARDS', pgm_name: 'Airborne Reconnaissance Data System' },
  { pgm_id: 4, pgm_cd: '236', pgm_name: 'Program 236' },
]

// Asset status codes (aligned with AFI 21-103)
const assetStatusCodes = [
  { status_cd: 'FMC', status_name: 'Fully Mission Capable', description: 'Asset is fully operational and mission ready' },
  { status_cd: 'PMC', status_name: 'Partially Mission Capable', description: 'Asset can perform some but not all mission types' },
  { status_cd: 'PMCM', status_name: 'Partially Mission Capable Maintenance', description: 'Asset partially capable, limited by maintenance' },
  { status_cd: 'PMCS', status_name: 'Partially Mission Capable Supply', description: 'Asset partially capable, limited by parts/supplies' },
  { status_cd: 'PMCB', status_name: 'Partially Mission Capable Both', description: 'Asset partially capable, limited by both maintenance and supply' },
  { status_cd: 'NMCM', status_name: 'Not Mission Capable Maintenance', description: 'Asset is down due to maintenance requirements' },
  { status_cd: 'NMCS', status_name: 'Not Mission Capable Supply', description: 'Asset is down awaiting parts/supplies' },
  { status_cd: 'NMCB', status_name: 'Not Mission Capable Both', description: 'Asset is down due to both maintenance and supply issues' },
]

// Status transition rules - defines which transitions are allowed (per AFI 21-103)
// Business rules:
// - FMC: Can transition to any PMC or NMC status (asset can degrade or need maintenance)
// - PMC variants: Can improve to FMC, degrade to NMC, or move between PMC variants based on issue resolution
// - NMC variants: Can improve to FMC or PMC variants, or move between NMC variants as issues are identified/resolved
const statusTransitionRules: Record<string, string[]> = {
  'FMC': ['PMC', 'PMCM', 'PMCS', 'PMCB', 'NMCM', 'NMCS', 'NMCB'],  // FMC can degrade to any status
  'PMC': ['FMC', 'PMCM', 'PMCS', 'PMCB', 'NMCM', 'NMCS', 'NMCB'],  // Generic PMC can transition anywhere
  'PMCM': ['FMC', 'PMC', 'PMCS', 'PMCB', 'NMCM', 'NMCS', 'NMCB'],  // PMCM can improve or degrade
  'PMCS': ['FMC', 'PMC', 'PMCM', 'PMCB', 'NMCM', 'NMCS', 'NMCB'],  // PMCS can improve or degrade
  'PMCB': ['FMC', 'PMC', 'PMCM', 'PMCS', 'NMCM', 'NMCS', 'NMCB'],  // PMCB can improve or degrade
  'NMCM': ['FMC', 'PMC', 'PMCM', 'PMCS', 'PMCB', 'NMCS', 'NMCB'],  // NMCM can improve or change issue type
  'NMCS': ['FMC', 'PMC', 'PMCM', 'PMCS', 'PMCB', 'NMCM', 'NMCB'],  // NMCS can improve or change issue type
  'NMCB': ['FMC', 'PMC', 'PMCM', 'PMCS', 'PMCB', 'NMCM', 'NMCS'],  // NMCB can improve or resolve one issue type
}

// Function to validate status transitions
function isValidStatusTransition(fromStatus: string, toStatus: string): { valid: boolean; message?: string } {
  // Same status is always allowed (no change)
  if (fromStatus === toStatus) {
    return { valid: true };
  }

  const allowedTransitions = statusTransitionRules[fromStatus];

  if (!allowedTransitions) {
    return { valid: false, message: `Unknown current status: ${fromStatus}` };
  }

  if (!allowedTransitions.includes(toStatus)) {
    const fromName = assetStatusCodes.find(s => s.status_cd === fromStatus)?.status_name || fromStatus;
    const toName = assetStatusCodes.find(s => s.status_cd === toStatus)?.status_name || toStatus;

    return {
      valid: false,
      message: `Invalid status transition: Cannot change from ${fromName} to ${toName}. Allowed transitions from ${fromName}: ${allowedTransitions.map(s => assetStatusCodes.find(sc => sc.status_cd === s)?.status_name || s).join(', ')}.`
    };
  }

  return { valid: true };
}

// Location options
const assignedLocationations = [
  { loc_id: 1, loc_cd: 'DEPOT-A', loc_name: 'Depot Alpha', active: true },
  { loc_id: 2, loc_cd: 'DEPOT-B', loc_name: 'Depot Beta', active: true },
  { loc_id: 3, loc_cd: 'DEPOT-C', loc_name: 'Depot Charlie', active: true },
  { loc_id: 4, loc_cd: 'FIELD-1', loc_name: 'Field Site 1', active: true },
  { loc_id: 5, loc_cd: 'FIELD-2', loc_name: 'Field Site 2', active: true },
  { loc_id: 6, loc_cd: 'HQ', loc_name: 'Headquarters', active: true },
]

const currentLocationations = [
  { loc_id: 1, loc_cd: 'MAINT-BAY-1', loc_name: 'Maintenance Bay 1', active: true },
  { loc_id: 2, loc_cd: 'MAINT-BAY-2', loc_name: 'Maintenance Bay 2', active: true },
  { loc_id: 3, loc_cd: 'STORAGE-A', loc_name: 'Storage Area A', active: true },
  { loc_id: 4, loc_cd: 'STORAGE-B', loc_name: 'Storage Area B', active: true },
  { loc_id: 5, loc_cd: 'FIELD-OPS', loc_name: 'Field Operations', active: true },
  { loc_id: 6, loc_cd: 'AIRCRAFT-1', loc_name: 'Aircraft 1', active: true },
  { loc_id: 7, loc_cd: 'AIRCRAFT-2', loc_name: 'Aircraft 2', active: true },
]

// Asset interface for typed data
interface Asset {
  asset_id: number
  serno: string
  partno: string
  name: string
  pgm_id: number
  status_cd: string
  admin_loc: string
  cust_loc: string
  notes: string
  active: boolean
  created_date: string
}

// Mock asset data for different programs
// Mock assets array - loaded from DB at startup (see initializeAssetsFromDb)
let mockAssets: Asset[] = [];

// Asset History interface for detailed audit trail
interface AssetHistoryChange {
  field: string
  field_label: string
  old_value: string | null
  new_value: string | null
}

interface AssetHistoryEntry {
  history_id: number
  asset_id: number
  timestamp: string
  user_id: number
  username: string
  user_full_name: string
  action_type: 'create' | 'update' | 'delete'
  changes: AssetHistoryChange[]
  description: string
}

// Asset history storage - stores all history events for assets
const assetHistory: AssetHistoryEntry[] = []

// Meter History interface and storage (supports hours, cycles, and ETI tracking)
interface MeterHistoryEntry {
  meter_history_id: number;
  asset_id: number;
  timestamp: string;
  user_id: number;
  username: string;
  user_full_name: string;
  meter_type: 'hours' | 'cycles' | 'eti';  // Type of meter reading
  old_value: number | null;  // Previous meter value
  new_value: number;  // New meter value
  value_added: number;  // Change in value
  source: 'maintenance' | 'manual' | 'sortie';  // How meter was updated
  source_id: number | null;  // ID of maintenance event, sortie, etc.
  source_ref: string | null;  // Reference like job number
  notes: string | null;
}

// Legacy type alias for backward compatibility
interface ETIHistoryEntry extends MeterHistoryEntry {
  old_eti_hours: number | null;  // Alias for old_value when meter_type is 'eti' or 'hours'
  new_eti_hours: number;  // Alias for new_value when meter_type is 'eti' or 'hours'
  hours_added: number;  // Alias for value_added when meter_type is 'eti' or 'hours'
}

// Meter history storage (renamed from etiHistory for clarity, but keeping backward compatibility)
const meterHistory: MeterHistoryEntry[] = []
const etiHistory = meterHistory;  // Alias for backward compatibility

// Meter Replacement interface and storage (tracks when meters are replaced)
interface MeterReplacementEntry {
  replacement_id: number;
  asset_id: number;
  timestamp: string;
  user_id: number;
  username: string;
  user_full_name: string;
  meter_type: 'hours' | 'cycles' | 'eti';  // Type of meter replaced
  old_meter_value: number | null;  // Final reading from old meter
  new_meter_start_value: number;  // Starting value for new meter
  replacement_reason: string;  // Why meter was replaced
  notes: string | null;
}

// Meter replacement storage
const meterReplacements: MeterReplacementEntry[] = []

// Helper function to add meter replacement entry
function addMeterReplacement(
  assetId: number,
  user: { user_id: number; username: string; first_name: string; last_name: string },
  meterType: 'hours' | 'cycles' | 'eti',
  oldMeterValue: number | null,
  newMeterStartValue: number,
  replacementReason: string,
  notes: string | null
): MeterReplacementEntry {
  const entry: MeterReplacementEntry = {
    replacement_id: meterReplacements.length + 1,
    asset_id: assetId,
    timestamp: new Date().toISOString(),
    user_id: user.user_id,
    username: user.username,
    user_full_name: `${user.first_name} ${user.last_name}`,
    meter_type: meterType,
    old_meter_value: oldMeterValue,
    new_meter_start_value: newMeterStartValue,
    replacement_reason: replacementReason,
    notes,
  };
  meterReplacements.push(entry);
  return entry;
}

// Helper function to add meter history entry
function addMeterHistory(
  assetId: number,
  user: { user_id: number; username: string; first_name: string; last_name: string },
  meterType: 'hours' | 'cycles' | 'eti',
  oldValue: number | null,
  newValue: number,
  valueAdded: number,
  source: 'maintenance' | 'manual' | 'sortie',
  sourceId: number | null,
  sourceRef: string | null,
  notes: string | null
): MeterHistoryEntry {
  const entry: MeterHistoryEntry = {
    meter_history_id: meterHistory.length + 1,
    asset_id: assetId,
    timestamp: new Date().toISOString(),
    user_id: user.user_id,
    username: user.username,
    user_full_name: `${user.first_name} ${user.last_name}`,
    meter_type: meterType,
    old_value: oldValue,
    new_value: newValue,
    value_added: valueAdded,
    source,
    source_id: sourceId,
    source_ref: sourceRef,
    notes,
  };
  meterHistory.push(entry);
  return entry;
}

// Legacy wrapper for backward compatibility with ETI-specific calls
function addETIHistory(
  assetId: number,
  user: { user_id: number; username: string; first_name: string; last_name: string },
  oldETI: number | null,
  newETI: number,
  hoursAdded: number,
  source: 'maintenance' | 'manual' | 'sortie',
  sourceId: number | null,
  sourceRef: string | null,
  notes: string | null
): MeterHistoryEntry {
  return addMeterHistory(assetId, user, 'eti', oldETI, newETI, hoursAdded, source, sourceId, sourceRef, notes);
}

// Initialize some ETI history for existing assets (simulate past updates)
function initializeETIHistory(): void {
  const today = new Date();
  const subtractDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString();
  };

  // Sample meter history entries for asset CRIIS-001 (asset_id: 1) - ETI tracking
  meterHistory.push({
    meter_history_id: 1,
    asset_id: 1,
    timestamp: subtractDays(90),
    user_id: 2,
    username: 'depot_mgr',
    user_full_name: 'Jane Depot',
    meter_type: 'eti',
    old_value: 1100,
    new_value: 1200,
    value_added: 100,
    source: 'sortie',
    source_id: null,
    source_ref: 'SORTIE-2024-045',
    notes: 'Post-mission ETI update'
  });
  meterHistory.push({
    meter_history_id: 2,
    asset_id: 1,
    timestamp: subtractDays(45),
    user_id: 2,
    username: 'depot_mgr',
    user_full_name: 'Jane Depot',
    meter_type: 'eti',
    old_value: 1200,
    new_value: 1250,
    value_added: 50,
    source: 'maintenance',
    source_id: 8,
    source_ref: 'MX-2024-008',
    notes: 'ETI recorded during 30-day PMI'
  });

  // Sample meter history for CRIIS-005 (asset_id: 5) - hours tracking
  meterHistory.push({
    meter_history_id: 3,
    asset_id: 5,
    timestamp: subtractDays(120),
    user_id: 3,
    username: 'field_tech',
    user_full_name: 'Bob Technician',
    meter_type: 'hours',
    old_value: 2800,
    new_value: 3000,
    value_added: 200,
    source: 'sortie',
    source_id: null,
    source_ref: 'SORTIE-2024-032',
    notes: 'Extended deployment mission'
  });
  meterHistory.push({
    meter_history_id: 4,
    asset_id: 5,
    timestamp: subtractDays(60),
    user_id: 2,
    username: 'depot_mgr',
    user_full_name: 'Jane Depot',
    meter_type: 'hours',
    old_value: 3000,
    new_value: 3150,
    value_added: 150,
    source: 'manual',
    source_id: null,
    source_ref: null,
    notes: 'Corrected hours after audit'
  });
  meterHistory.push({
    meter_history_id: 5,
    asset_id: 5,
    timestamp: subtractDays(10),
    user_id: 2,
    username: 'depot_mgr',
    user_full_name: 'Jane Depot',
    meter_type: 'hours',
    old_value: 3150,
    new_value: 3200,
    value_added: 50,
    source: 'maintenance',
    source_id: 1,
    source_ref: 'MX-2024-001',
    notes: 'Hours recorded at start of maintenance'
  });

  // Sample cycles meter history for asset ACTS-003 (asset_id: 13) - cycles tracking
  meterHistory.push({
    meter_history_id: 6,
    asset_id: 13,
    timestamp: subtractDays(75),
    user_id: 2,
    username: 'depot_mgr',
    user_full_name: 'Jane Depot',
    meter_type: 'cycles',
    old_value: 1200,
    new_value: 1350,
    value_added: 150,
    source: 'sortie',
    source_id: null,
    source_ref: 'SORTIE-2024-089',
    notes: 'Post-mission cycles update'
  });
  meterHistory.push({
    meter_history_id: 7,
    asset_id: 13,
    timestamp: subtractDays(15),
    user_id: 2,
    username: 'depot_mgr',
    user_full_name: 'Jane Depot',
    meter_type: 'cycles',
    old_value: 1350,
    new_value: 1480,
    value_added: 130,
    source: 'manual',
    source_id: null,
    source_ref: null,
    notes: 'Cycles adjustment after maintenance'
  });
}

// Helper function to add asset history entry
function addAssetHistory(
  assetId: number,
  user: { user_id: number; username: string; first_name: string; last_name: string },
  actionType: 'create' | 'update' | 'delete',
  changes: AssetHistoryChange[],
  description: string
): AssetHistoryEntry {
  const entry: AssetHistoryEntry = {
    history_id: assetHistory.length + 1,
    asset_id: assetId,
    timestamp: new Date().toISOString(),
    user_id: user.user_id,
    username: user.username,
    user_full_name: `${user.first_name} ${user.last_name}`,
    action_type: actionType,
    changes,
    description,
  }
  assetHistory.push(entry)
  return entry
}

// Initialize history for existing assets (simulate creation events)
function initializeAssetHistory(): void {
  mockAssets.forEach(asset => {
    const createdDate = new Date(asset.created_date)
    createdDate.setHours(9, 0, 0, 0) // Set to 9 AM

    const entry: AssetHistoryEntry = {
      history_id: assetHistory.length + 1,
      asset_id: asset.asset_id,
      timestamp: createdDate.toISOString(),
      user_id: 1, // Admin created all initial assets
      username: 'admin',
      user_full_name: 'John Admin',
      action_type: 'create',
      changes: [
        { field: 'serno', field_label: 'Serial Number', old_value: null, new_value: asset.serno },
        { field: 'partno', field_label: 'Part Number', old_value: null, new_value: asset.partno },
        { field: 'name', field_label: 'Name', old_value: null, new_value: asset.name },
        { field: 'status_cd', field_label: 'Status', old_value: null, new_value: asset.status_cd },
        { field: 'admin_loc', field_label: 'Admin Location', old_value: null, new_value: asset.admin_loc },
        { field: 'cust_loc', field_label: 'Custodial Location', old_value: null, new_value: asset.cust_loc },
      ],
      description: `Asset ${asset.serno} created`,
    }
    assetHistory.push(entry)
  })

  // Add some sample edit history for a few assets to make it more realistic
  const sampleEdits: { asset_id: number; changes: AssetHistoryChange[]; description: string; daysAgo: number }[] = [
    {
      asset_id: 1,
      changes: [
        { field: 'status_cd', field_label: 'Status', old_value: 'PMC', new_value: 'FMC' },
        { field: 'notes', field_label: 'Notes', old_value: 'Awaiting calibration', new_value: 'Primary sensor unit' },
      ],
      description: 'Status updated from PMC to FMC after calibration',
      daysAgo: 30,
    },
    {
      asset_id: 3,
      changes: [
        { field: 'cust_loc', field_label: 'Custodial Location', old_value: 'STORAGE-A', new_value: 'AIRCRAFT-1' },
      ],
      description: 'Asset transferred to Aircraft 1',
      daysAgo: 15,
    },
    {
      asset_id: 5,
      changes: [
        { field: 'status_cd', field_label: 'Status', old_value: 'FMC', new_value: 'NMCM' },
        { field: 'notes', field_label: 'Notes', old_value: '', new_value: 'Intermittent power failure' },
      ],
      description: 'Asset marked NMCM due to intermittent power failure',
      daysAgo: 7,
    },
    {
      asset_id: 6,
      changes: [
        { field: 'status_cd', field_label: 'Status', old_value: 'NMCM', new_value: 'NMCS' },
        { field: 'notes', field_label: 'Notes', old_value: 'Awaiting parts', new_value: 'Awaiting power supply module' },
      ],
      description: 'Status changed to NMCS - awaiting power supply module',
      daysAgo: 5,
    },
  ]

  sampleEdits.forEach(edit => {
    const editDate = new Date()
    editDate.setDate(editDate.getDate() - edit.daysAgo)
    editDate.setHours(14, 30, 0, 0)

    const entry: AssetHistoryEntry = {
      history_id: assetHistory.length + 1,
      asset_id: edit.asset_id,
      timestamp: editDate.toISOString(),
      user_id: 2,
      username: 'depot_mgr',
      user_full_name: 'Jane Depot',
      action_type: 'update',
      changes: edit.changes,
      description: edit.description,
    }
    assetHistory.push(entry)
  })
}

// Initialize asset history on server start
initializeAssetHistory()

// Initialize ETI history on server start
initializeETIHistory()

// Authentication middleware helper
function authenticateRequest(req: express.Request, res: express.Response): { userId: number } | null {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not authenticated' })
    return null
  }

  const token = authHeader.substring(7)
  const payload = parseMockToken(token)

  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return null
  }

  return payload
}

// Check if user is admin
function requireAdmin(req: express.Request, res: express.Response): boolean {
  const payload = authenticateRequest(req, res)
  if (!payload) return false

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user || user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin access required' })
    return false
  }

  return true
}

// Check if user is admin and return the user object
function requireAdminAndGetUser(req: express.Request, res: express.Response): { user_id: number; username: string } | null {
  const payload = authenticateRequest(req, res)
  if (!payload) return null

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user || user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin access required' })
    return null
  }

  return user
}

// Helper function to get client IP address
function getClientIP(req: express.Request): string {
  // Check X-Forwarded-For header (if behind proxy)
  const forwardedFor = req.headers['x-forwarded-for']
  if (forwardedFor) {
    // X-Forwarded-For can be a comma-separated list, take the first one
    const ips = typeof forwardedFor === 'string' ? forwardedFor.split(',') : forwardedFor
    return ips[0].trim()
  }

  // Check X-Real-IP header
  const realIp = req.headers['x-real-ip']
  if (realIp && typeof realIp === 'string') {
    return realIp
  }

  // Fall back to socket address
  return req.socket.remoteAddress || 'unknown'
}

// Audit logging helper function
async function logAuditAction(
  userId: number,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  tableName: string,
  recordId: number,
  oldValues: any = null,
  newValues: any = null,
  req: express.Request
): Promise<void> {
  try {
    const ipAddress = getClientIP(req)

    await prisma.auditLog.create({
      data: {
        user_id: userId,
        action,
        table_name: tableName,
        record_id: recordId,
        old_values: oldValues,
        new_values: newValues,
        ip_address: ipAddress,
      },
    })

    console.log(`[AUDIT] ${action} on ${tableName} record ${recordId} by user ${userId} from ${ipAddress}`)
  } catch (error) {
    console.error('[AUDIT] Failed to log audit entry:', error)
    // Don't throw - audit logging failure shouldn't break the main operation
  }
}

// Get all users (admin only)
app.get('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return

  // Return users without password information
  const usersWithActive = mockUsers.map(u => ({
    ...u,
    active: true,
  }))

  res.json({ users: usersWithActive })
})

// Get single user by ID
app.get('/api/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return

  const userId = parseInt(req.params.id, 10)
  const user = mockUsers.find(u => u.user_id === userId)

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  res.json({ user: { ...user, active: true } })
})

// Update user by ID (admin only)
app.put('/api/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return

  const userId = parseInt(req.params.id, 10)
  const userIndex = mockUsers.findIndex(u => u.user_id === userId)

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' })
  }

  const { username, email, first_name, last_name, role, password, program_ids, default_program_id, location_ids, default_location_id, active, admin_password } = req.body
  const existingUser = mockUsers[userIndex]

  // Check if role is being changed
  const roleChanged = existingUser.role !== role

  // If role is being changed, require admin password re-authentication
  if (roleChanged) {
    if (!admin_password) {
      return res.status(403).json({ error: 'Admin password is required when changing user roles' })
    }

    // Get the admin user's info from the token
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const tokenData = parseMockToken(token)
    if (!tokenData) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    const adminUser = mockUsers.find(u => u.user_id === tokenData.userId)
    if (!adminUser) {
      return res.status(401).json({ error: 'Admin user not found' })
    }

    // Verify admin password
    const adminStoredPassword = mockPasswords[adminUser.username]
    if (adminStoredPassword !== admin_password) {
      return res.status(403).json({ error: 'Incorrect admin password' })
    }

    console.log(`[SECURITY] Admin ${adminUser.username} verified password for role change: ${existingUser.username} from ${existingUser.role} to ${role}`)
  }

  // Validate required fields
  if (!username || !email || !first_name || !last_name || !role || !program_ids) {
    return res.status(400).json({ error: 'All fields are required' })
  }

  // Validate username format
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' })
  }

  // Validate username length (must match frontend: min 3, max 50)
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' })
  }
  if (username.length > 50) {
    return res.status(400).json({ error: 'Username must be at most 50 characters' })
  }

  // Validate email format (must match frontend)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  // Validate first_name length (must match frontend: max 50)
  if (first_name.length > 50) {
    return res.status(400).json({ error: 'First name must be at most 50 characters' })
  }

  // Validate last_name length (must match frontend: max 50)
  if (last_name.length > 50) {
    return res.status(400).json({ error: 'Last name must be at most 50 characters' })
  }

  // Check for duplicate username (excluding current user)
  if (mockUsers.find(u => u.username.toLowerCase() === username.toLowerCase() && u.user_id !== userId)) {
    return res.status(400).json({ error: 'Username already exists' })
  }

  // Check for duplicate email (excluding current user)
  if (mockUsers.find(u => u.email.toLowerCase() === email.toLowerCase() && u.user_id !== userId)) {
    return res.status(400).json({ error: 'Email already exists' })
  }

  // Validate role
  const validRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN', 'VIEWER']
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' })
  }

  // Validate program_ids
  if (!Array.isArray(program_ids) || program_ids.length === 0) {
    return res.status(400).json({ error: 'At least one program must be selected' })
  }

  // Validate location_ids (not required for ADMIN as they get all locations automatically)
  if (role !== 'ADMIN' && (!Array.isArray(location_ids) || location_ids.length === 0)) {
    return res.status(400).json({ error: 'At least one location must be assigned' })
  }

  // If password is provided, validate it
  if (password) {
    if (password.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' })
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter' })
    }
    if (!/[a-z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one lowercase letter' })
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number' })
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one special character' })
    }
    // Update password
    mockPasswords[username] = password
    // If username changed, remove old password entry
    if (existingUser.username !== username) {
      delete mockPasswords[existingUser.username]
    }
  } else if (existingUser.username !== username) {
    // If username changed but no new password, move password to new username
    mockPasswords[username] = mockPasswords[existingUser.username]
    delete mockPasswords[existingUser.username]
  }

  // Build programs array with is_default flag
  // Use default_program_id if provided and valid, otherwise use first program
  const effectiveDefaultId = default_program_id && program_ids.includes(default_program_id)
    ? default_program_id
    : program_ids[0]

  const programs = program_ids.map((pgmId: number) => {
    const program = allPrograms.find(p => p.pgm_id === pgmId)
    if (!program) {
      throw new Error(`Invalid program ID: ${pgmId}`)
    }
    return {
      ...program,
      is_default: pgmId === effectiveDefaultId
    }
  })

  // Build locations array with is_default flag
  // For ADMIN users, automatically assign ALL locations
  let locations
  if (role === 'ADMIN') {
    console.log('[USERS] Admin role detected - assigning all locations')
    const allLocations = await prisma.location.findMany({
      where: { active: true },
      select: {
        loc_id: true,
        display_name: true,
      },
      orderBy: { display_name: 'asc' },
    })
    console.log(`[USERS] Assigned ${allLocations.length} locations to admin user`)

    // Use default_location_id if provided and valid, otherwise use first location
    const effectiveDefaultLocationId = default_location_id && allLocations.some(l => l.loc_id === default_location_id)
      ? default_location_id
      : allLocations[0]?.loc_id

    locations = allLocations.map((loc) => ({
      ...loc,
      is_default: loc.loc_id === effectiveDefaultLocationId
    }))
  } else {
    // Use default_location_id if provided and valid, otherwise use first location
    const effectiveDefaultLocationId = default_location_id && location_ids?.includes(default_location_id)
      ? default_location_id
      : location_ids?.[0]

    locations = (location_ids || []).map((locId: number) => {
      return {
        loc_id: locId,
        display_name: `Location ${locId}`, // In real app, fetch from database
        is_default: locId === effectiveDefaultLocationId
      }
    })
  }

  // Determine allowed maintenance levels based on role
  // ADMIN: Both DEPOT and SHOP
  // DEPOT_MANAGER: DEPOT only
  // FIELD_TECHNICIAN: SHOP only
  // VIEWER: None
  let allowedMaintenanceLevels: MaintenanceLevel[] = [];
  if (role === 'ADMIN') {
    allowedMaintenanceLevels = ['DEPOT', 'SHOP'];
  } else if (role === 'DEPOT_MANAGER') {
    allowedMaintenanceLevels = ['DEPOT'];
  } else if (role === 'FIELD_TECHNICIAN') {
    allowedMaintenanceLevels = ['SHOP'];
  }
  // VIEWER gets no maintenance levels

  // Update the user
  const updatedUser = {
    user_id: userId,
    username,
    email,
    first_name,
    last_name,
    role,
    programs,
    locations,
    allowedMaintenanceLevels,
  }

  mockUsers[userIndex] = updatedUser

  const defaultProgramCode = programs.find(p => p.is_default)?.pgm_cd || 'none'
  console.log(`[USERS] User updated: ${username} (ID: ${userId}, Role: ${role}, Default Program: ${defaultProgramCode})`)

  res.json({
    message: 'User updated successfully',
    user: { ...updatedUser, active: active !== false }
  })
})

// Delete user by ID (admin only)
app.delete('/api/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return

  const payload = authenticateRequest(req, res)
  if (!payload) return

  const userId = parseInt(req.params.id, 10)
  const userIndex = mockUsers.findIndex(u => u.user_id === userId)

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' })
  }

  const user = mockUsers[userIndex]

  // Store user data for audit log before deletion
  const deletedUserData = {
    user_id: user.user_id,
    username: user.username,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    programs: user.programs.map(p => p.pgm_id)
  }

  // Remove user from mock data
  mockUsers.splice(userIndex, 1)

  // Remove password entry
  delete mockPasswords[user.username]

  // Log the deletion to audit log
  await logAuditAction(
    payload.userId,
    'DELETE',
    'User',
    userId,
    deletedUserData, // old_values: the user data that was deleted
    null, // new_values: null for delete operations
    req
  )

  console.log(`[USERS] User deleted: ${user.username} (ID: ${userId})`)

  res.json({
    message: 'User deleted successfully',
    user: { user_id: userId, username: user.username }
  })
})

// Create new user (admin only)
app.post('/api/users', async (req, res) => {
  if (!requireAdmin(req, res)) return

  const { username, email, first_name, last_name, role, password, program_ids, location_ids } = req.body

  // Validate required fields
  if (!username || !email || !first_name || !last_name || !role || !password || !program_ids) {
    return res.status(400).json({ error: 'All fields are required' })
  }

  // Validate username format
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' })
  }

  // Validate username length (must match frontend: min 3, max 50)
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' })
  }
  if (username.length > 50) {
    return res.status(400).json({ error: 'Username must be at most 50 characters' })
  }

  // Validate email format (must match frontend)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  // Validate first_name length (must match frontend: max 50)
  if (first_name.length > 50) {
    return res.status(400).json({ error: 'First name must be at most 50 characters' })
  }

  // Validate last_name length (must match frontend: max 50)
  if (last_name.length > 50) {
    return res.status(400).json({ error: 'Last name must be at most 50 characters' })
  }

  // Check for duplicate username
  if (mockUsers.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Username already exists' })
  }

  // Check for duplicate email
  if (mockUsers.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Email already exists' })
  }

  // Validate role
  const validRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN', 'VIEWER']
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' })
  }

  // Validate program_ids
  if (!Array.isArray(program_ids) || program_ids.length === 0) {
    return res.status(400).json({ error: 'At least one program must be selected' })
  }

  // Validate location_ids (not required for ADMIN as they get all locations automatically)
  if (role !== 'ADMIN' && (!Array.isArray(location_ids) || location_ids.length === 0)) {
    return res.status(400).json({ error: 'At least one location must be assigned' })
  }

  // Validate password requirements
  if (password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' })
  }
  if (!/[A-Z]/.test(password)) {
    return res.status(400).json({ error: 'Password must contain at least one uppercase letter' })
  }
  if (!/[a-z]/.test(password)) {
    return res.status(400).json({ error: 'Password must contain at least one lowercase letter' })
  }
  if (!/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must contain at least one number' })
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must contain at least one special character' })
  }

  // Generate new user ID
  const newUserId = Math.max(...mockUsers.map(u => u.user_id)) + 1

  // Build programs array with is_default flag
  const programs = program_ids.map((pgmId: number, index: number) => {
    const program = allPrograms.find(p => p.pgm_id === pgmId)
    if (!program) {
      throw new Error(`Invalid program ID: ${pgmId}`)
    }
    return {
      ...program,
      is_default: index === 0 // First program is default
    }
  })

  // Build locations array with is_default flag
  // For ADMIN users, automatically assign ALL locations
  let locations
  if (role === 'ADMIN') {
    console.log('[USERS] Admin role detected - assigning all locations')
    const allLocations = await prisma.location.findMany({
      where: { active: true },
      select: {
        loc_id: true,
        display_name: true,
      },
      orderBy: { display_name: 'asc' },
    })
    console.log(`[USERS] Assigned ${allLocations.length} locations to admin user`)
    locations = allLocations.map((loc, index) => ({
      ...loc,
      is_default: index === 0 // First location is default
    }))
  } else {
    locations = (location_ids || []).map((locId: number, index: number) => {
      return {
        loc_id: locId,
        display_name: `Location ${locId}`, // In real app, fetch from database
        is_default: index === 0 // First location is default
      }
    })
  }

  // Determine allowed maintenance levels based on role
  let newUserAllowedLevels: MaintenanceLevel[] = [];
  if (role === 'ADMIN') {
    newUserAllowedLevels = ['DEPOT', 'SHOP'];
  } else if (role === 'DEPOT_MANAGER') {
    newUserAllowedLevels = ['DEPOT'];
  } else if (role === 'FIELD_TECHNICIAN') {
    newUserAllowedLevels = ['SHOP'];
  }

  // Create the new user
  const newUser = {
    user_id: newUserId,
    username,
    email,
    first_name,
    last_name,
    role,
    programs,
    locations,
    allowedMaintenanceLevels: newUserAllowedLevels,
  }

  // Add to mock data
  mockUsers.push(newUser)
  mockPasswords[username] = password

  console.log(`[USERS] New user created: ${username} (ID: ${newUserId}, Role: ${role})`)

  res.status(201).json({
    message: 'User created successfully',
    user: { ...newUser, active: true }
  })
})

// Get locations (admin only - for user management)
// Optional query param: program_ids (comma-separated) to filter locations by program
app.get('/api/locations', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const programIdsParam = req.query.program_ids as string | undefined

    // If program_ids provided, filter locations to only those with assets from those programs
    if (programIdsParam) {
      const programIds = programIdsParam.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id))

      if (programIds.length > 0) {
        console.log(`[LOCATIONS] Filtering locations by programs: ${programIds.join(', ')}`)

        // Query to get distinct locations that have assets from the specified programs
        // Use Prisma.sql to properly handle the array parameter
        const rawLocationsFromAssets = await prisma.$queryRaw<Array<{loc_id: number, display_name: string | null, majcom_cd: string | null, site_cd: string | null, unit_cd: string | null, description: string | null}>>`
          SELECT DISTINCT
            l.loc_id,
            l.display_name,
            l.majcom_cd,
            l.site_cd,
            l.unit_cd,
            l.description
          FROM location l
          WHERE l.active = true
          AND l.loc_id IN (
            SELECT DISTINCT COALESCE(a.loc_ida, a.loc_idc) as loc_id
            FROM asset a
            JOIN part_list pl ON a.partno_id = pl.partno_id
            WHERE a.active = true
            AND pl.pgm_id = ANY(ARRAY[${Prisma.join(programIds)}]::int[])
            AND COALESCE(a.loc_ida, a.loc_idc) IS NOT NULL
          )
          ORDER BY l.display_name ASC;
        `

        // Load code cache to resolve display names
        const codes = await loadCodeCache()

        // Resolve display names for locations that don't have them
        const locationsFromAssets = rawLocationsFromAssets.map(loc => {
          let displayName = loc.display_name?.trim()

          // If no display name, try description
          if (!displayName && loc.description && loc.description !== 'NONE') {
            displayName = loc.description.trim()
          }

          // If still no display name, resolve the code IDs to actual code values
          if (!displayName) {
            const majcom = loc.majcom_cd ? resolveCodeId(loc.majcom_cd, codes) : ''
            const site = loc.site_cd ? resolveCodeId(loc.site_cd, codes) : ''
            const unit = loc.unit_cd ? resolveCodeId(loc.unit_cd, codes) : ''

            const parts = [majcom, site, unit].filter(Boolean)
            displayName = parts.length > 0 ? parts.join(' - ') : `Location ${loc.loc_id}`
          }

          return {
            ...loc,
            display_name: displayName,
          }
        })

        // Sort by display name after resolving
        locationsFromAssets.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''))

        console.log(`[LOCATIONS] Found ${locationsFromAssets.length} locations for programs ${programIds.join(', ')}`)
        return res.json({ locations: locationsFromAssets })
      }
    }

    // Default: return all active locations (no program filter)
    const rawLocations = await prisma.location.findMany({
      where: { active: true },
      select: {
        loc_id: true,
        display_name: true,
        majcom_cd: true,
        site_cd: true,
        unit_cd: true,
        description: true,
      },
    })

    // Load code cache to resolve display names
    const codes = await loadCodeCache()

    // Resolve display names for locations that don't have them
    const locations = rawLocations.map(loc => {
      let displayName = loc.display_name?.trim()

      // If no display name, try description
      if (!displayName && loc.description && loc.description !== 'NONE') {
        displayName = loc.description.trim()
      }

      // If still no display name, resolve the code IDs to actual code values
      if (!displayName) {
        const majcom = loc.majcom_cd ? resolveCodeId(loc.majcom_cd, codes) : ''
        const site = loc.site_cd ? resolveCodeId(loc.site_cd, codes) : ''
        const unit = loc.unit_cd ? resolveCodeId(loc.unit_cd, codes) : ''

        const parts = [majcom, site, unit].filter(Boolean)
        displayName = parts.length > 0 ? parts.join(' - ') : `Location ${loc.loc_id}`
      }

      return {
        ...loc,
        display_name: displayName,
      }
    })

    // Sort by display name after resolving
    locations.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''))

    console.log(`[LOCATIONS] Returning all ${locations.length} active locations (no program filter)`)
    res.json({ locations })
  } catch (error) {
    console.error('[LOCATIONS] Error fetching locations:', error)
    res.status(500).json({ error: 'Failed to fetch locations' })
  }
})

// Get locations for a specific program using loc_set table
// This is the proper way to get program-specific locations from the legacy RIMSS data
// The loc_set table maps programs to their authorized locations via set_name patterns like 'ACTS_LOC', 'CRIIS_LOC'
app.get('/api/program/:programId/locations', async (req, res) => {
  const payload = authenticateRequest(req, res)
  if (!payload) return

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user) {
    return res.status(401).json({ error: 'User not found' })
  }

  const programId = parseInt(req.params.programId, 10)
  if (isNaN(programId)) {
    return res.status(400).json({ error: 'Invalid program ID' })
  }

  try {
    // Load code cache for resolving code IDs to readable values
    const codes = await loadCodeCache()

    // Get the program code to build the loc_set pattern
    const program = await prisma.program.findUnique({
      where: { pgm_id: programId },
      select: { pgm_id: true, pgm_cd: true, pgm_name: true }
    })

    if (!program) {
      return res.status(404).json({ error: 'Program not found' })
    }

    // Build the set_name patterns for this program (e.g., 'ACTS_LOC', 'ACTS_SPARE_LOCATIONS', 'ACTS_DEPOT_LOC')
    const programCode = program.pgm_cd.toUpperCase()
    const setNamePatterns = [
      `${programCode}_LOC`,
      `${programCode}_SPARE_LOCATIONS`,
      `${programCode}_DEPOT_LOC`,
      `${programCode}_NETWORK`,
    ]

    console.log(`[PROGRAM-LOCATIONS] Looking for loc_set entries with patterns: ${setNamePatterns.join(', ')}`)

    // Query loc_set to get all locations for this program
    const locSetEntries = await prisma.locSet.findMany({
      where: {
        set_name: { in: setNamePatterns },
        active: true,
      },
      include: {
        location: {
          select: {
            loc_id: true,
            display_name: true,
            majcom_cd: true,
            site_cd: true,
            unit_cd: true,
            description: true,
            active: true,
          }
        }
      }
    })

    // Also try using pgm_id directly if loc_set has it populated
    const locSetByPgmId = await prisma.locSet.findMany({
      where: {
        pgm_id: programId,
        active: true,
      },
      include: {
        location: {
          select: {
            loc_id: true,
            display_name: true,
            majcom_cd: true,
            site_cd: true,
            unit_cd: true,
            description: true,
            active: true,
          }
        }
      }
    })

    // Combine both approaches and deduplicate by loc_id
    const allEntries = [...locSetEntries, ...locSetByPgmId]
    const locationMap = new Map<number, {
      loc_id: number
      display_name: string | null
      majcom_cd: string | null
      site_cd: string | null
      unit_cd: string | null
      description: string | null
      set_name: string
    }>()

    // Debug: log code cache status and verify some codes exist
    console.log(`[PROGRAM-LOCATIONS] Code cache has ${codes.size} entries`)
    // Test specific code lookups
    const testCodes = ['743', '24892', '526', '527', '1258', '1369']
    for (const testCode of testCodes) {
      const result = codes.get(testCode)
      if (result) {
        console.log(`[PROGRAM-LOCATIONS] Code ${testCode} = ${result.code_value} (${result.code_type})`)
      } else {
        console.log(`[PROGRAM-LOCATIONS] Code ${testCode} NOT FOUND in cache`)
      }
    }

    for (const entry of allEntries) {
      if (entry.location && entry.location.active) {
        // Priority for display name:
        // 1. loc_set.display_name (human-readable name from legacy data like "SHAW AFB")
        // 2. location.display_name (base name from location table)
        // 3. location.description (often has meaningful info like "F-16")
        // 4. Resolve majcom/site/unit codes to readable values (e.g., "ACC/SHAW/4FW")
        // 5. Fall back to "Location {loc_id}"
        let displayName = entry.display_name?.trim() || entry.location.display_name?.trim()

        // Check if display_name looks like unresolved code IDs (pattern: "123/456/789")
        // If so, we should resolve them to human-readable names
        const looksLikeUnresolvedCodes = displayName && /^\d+\/\d+\/\d+$/.test(displayName)

        // If no display name or it looks like unresolved code IDs, try description or resolve codes
        if (!displayName) {
          if (entry.location.description && entry.location.description !== 'NONE') {
            displayName = entry.location.description.trim()
          }
        }

        // If display_name looks like unresolved codes OR we still don't have a good name, resolve the code IDs
        if (looksLikeUnresolvedCodes || !displayName) {
          const majcom = entry.location.majcom_cd ? resolveCodeId(entry.location.majcom_cd, codes) : ''
          const site = entry.location.site_cd ? resolveCodeId(entry.location.site_cd, codes) : ''
          const unit = entry.location.unit_cd ? resolveCodeId(entry.location.unit_cd, codes) : ''

          // Debug first few resolutions
          if (locationMap.size < 3) {
            console.log(`[PROGRAM-LOCATIONS] Code resolution for loc_id ${entry.location.loc_id}:`)
            console.log(`  majcom_cd: "${entry.location.majcom_cd}" (len=${entry.location.majcom_cd?.length}) -> "${majcom}"`)
            console.log(`  site_cd: "${entry.location.site_cd}" (len=${entry.location.site_cd?.length}) -> "${site}"`)
            console.log(`  unit_cd: "${entry.location.unit_cd}" (len=${entry.location.unit_cd?.length}) -> "${unit}"`)
            console.log(`  Previous display_name: "${displayName}"`)
          }

          const parts = [majcom, site, unit].filter(Boolean)
          const resolvedName = parts.length > 0 ? parts.join(' / ') : `Location ${entry.location.loc_id}`

          // Only use resolved name if we actually got meaningful values (not just the same numbers)
          // If resolution didn't help, keep the original or use description
          if (looksLikeUnresolvedCodes && resolvedName && !resolvedName.match(/^\d+\/\d+\/\d+$/)) {
            displayName = resolvedName
          } else if (!displayName) {
            displayName = resolvedName
          }
        }

        if (!locationMap.has(entry.location.loc_id)) {
          locationMap.set(entry.location.loc_id, {
            loc_id: entry.location.loc_id,
            display_name: displayName,
            majcom_cd: entry.location.majcom_cd,
            site_cd: entry.location.site_cd,
            unit_cd: entry.location.unit_cd,
            description: entry.location.description,
            set_name: entry.set_name,
          })
        }
      }
    }

    const locations = Array.from(locationMap.values())
      .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''))

    console.log(`[PROGRAM-LOCATIONS] Found ${locations.length} locations for program ${program.pgm_cd} (ID: ${programId})`)

    // For non-admin users, filter to only their assigned locations
    let filteredLocations = locations
    if (user.role !== 'ADMIN') {
      const userLocationIds = user.locations?.map(l => l.loc_id) || []
      filteredLocations = locations.filter(loc => userLocationIds.includes(loc.loc_id))
      console.log(`[PROGRAM-LOCATIONS] Filtered to ${filteredLocations.length} locations for non-admin user`)
    }

    res.json({
      program: {
        pgm_id: program.pgm_id,
        pgm_cd: program.pgm_cd,
        pgm_name: program.pgm_name,
      },
      locations: filteredLocations,
      total: filteredLocations.length,
    })
  } catch (error) {
    console.error('[PROGRAM-LOCATIONS] Error fetching program locations:', error)
    res.status(500).json({ error: 'Failed to fetch program locations' })
  }
})

// Get all locations with search and filter (admin only - for location management)
app.get('/api/admin/locations', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const search = req.query.search as string | undefined
    const majcom = req.query.majcom as string | undefined
    const active = req.query.active as string | undefined
    const page = parseInt(req.query.page as string || '1', 10)
    const limit = parseInt(req.query.limit as string || '50', 10)

    // Build where clause
    const where: any = {}

    // Search by display_name (base name)
    if (search) {
      where.display_name = {
        contains: search,
        mode: 'insensitive' as const
      }
    }

    // Filter by MAJCOM
    if (majcom && majcom !== 'all') {
      where.majcom_cd = majcom
    }

    // Filter by active status
    if (active === 'true') {
      where.active = true
    } else if (active === 'false') {
      where.active = false
    }
    // If active is undefined or 'all', don't filter by active status

    // Get total count for pagination
    const totalCount = await prisma.location.count({ where })

    // Get locations with pagination
    const locations = await prisma.location.findMany({
      where,
      select: {
        loc_id: true,
        display_name: true,
        majcom_cd: true,
        site_cd: true,
        unit_cd: true,
        squad_cd: true,
        description: true,
        geoloc: true,
        active: true,
        ins_by: true,
        ins_date: true,
        chg_by: true,
        chg_date: true,
      },
      orderBy: { display_name: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    })

    // Get distinct MAJCOMs for filter dropdown
    const majcoms = await prisma.location.findMany({
      select: {
        majcom_cd: true,
      },
      where: {
        majcom_cd: {
          not: null
        }
      },
      distinct: ['majcom_cd'],
      orderBy: { majcom_cd: 'asc' }
    })

    const totalPages = Math.ceil(totalCount / limit)

    console.log(`[ADMIN-LOCATIONS] Retrieved ${locations.length} locations (page ${page}/${totalPages}, total: ${totalCount})`)
    res.json({
      locations,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages
      },
      majcoms: majcoms.map(m => m.majcom_cd).filter(Boolean)
    })
  } catch (error) {
    console.error('[ADMIN-LOCATIONS] Error fetching locations:', error)
    res.status(500).json({ error: 'Failed to fetch locations' })
  }
})

// Get single location by ID (admin only)
app.get('/api/admin/locations/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const locationId = parseInt(req.params.id, 10)

    if (isNaN(locationId)) {
      return res.status(400).json({ error: 'Invalid location ID' })
    }

    const location = await prisma.location.findUnique({
      where: { loc_id: locationId },
      select: {
        loc_id: true,
        display_name: true,
        majcom_cd: true,
        site_cd: true,
        unit_cd: true,
        squad_cd: true,
        description: true,
        geoloc: true,
        active: true,
        ins_by: true,
        ins_date: true,
        chg_by: true,
        chg_date: true,
        old_loc_id: true,
      },
    })

    if (!location) {
      return res.status(404).json({ error: 'Location not found' })
    }

    console.log(`[ADMIN-LOCATIONS] Retrieved location ${locationId}: ${location.display_name}`)
    res.json(location)
  } catch (error) {
    console.error('[ADMIN-LOCATIONS] Error fetching location:', error)
    res.status(500).json({ error: 'Failed to fetch location' })
  }
})

// Update location (admin only) - LOC_ID cannot be changed
app.put('/api/admin/locations/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const locationId = parseInt(req.params.id, 10)

    if (isNaN(locationId)) {
      return res.status(400).json({ error: 'Invalid location ID' })
    }

    // Check if location exists
    const existingLocation = await prisma.location.findUnique({
      where: { loc_id: locationId }
    })

    if (!existingLocation) {
      return res.status(404).json({ error: 'Location not found' })
    }

    // Get updatable fields from request body
    const {
      display_name,
      majcom_cd,
      site_cd,
      unit_cd,
      squad_cd,
      description,
      geoloc,
      active
    } = req.body

    // Validate required field
    if (!display_name || display_name.trim() === '') {
      return res.status(400).json({ error: 'Display name is required' })
    }

    // Update location (LOC_ID is excluded - cannot be changed)
    const updatedLocation = await prisma.location.update({
      where: { loc_id: locationId },
      data: {
        display_name: display_name.trim(),
        majcom_cd: majcom_cd || null,
        site_cd: site_cd || null,
        unit_cd: unit_cd || null,
        squad_cd: squad_cd || null,
        description: description || null,
        geoloc: geoloc || null,
        active: active !== undefined ? active : true,
        chg_by: req.user?.username || 'system',
        chg_date: new Date()
      },
      select: {
        loc_id: true,
        display_name: true,
        majcom_cd: true,
        site_cd: true,
        unit_cd: true,
        squad_cd: true,
        description: true,
        geoloc: true,
        active: true,
        ins_by: true,
        ins_date: true,
        chg_by: true,
        chg_date: true,
        old_loc_id: true,
      }
    })

    console.log(`[ADMIN-LOCATIONS] Updated location ${locationId}: ${updatedLocation.display_name} by ${req.user?.username}`)
    res.json(updatedLocation)
  } catch (error) {
    console.error('[ADMIN-LOCATIONS] Error updating location:', error)
    res.status(500).json({ error: 'Failed to update location' })
  }
})

// Create new location (admin only)
app.post('/api/admin/locations', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    // Get fields from request body
    const {
      display_name,
      majcom_cd,
      site_cd,
      unit_cd,
      squad_cd,
      description,
      geoloc,
      active
    } = req.body

    // Validate required field
    if (!display_name || display_name.trim() === '') {
      return res.status(400).json({ error: 'Display name is required' })
    }

    // Create new location
    const newLocation = await prisma.location.create({
      data: {
        display_name: display_name.trim(),
        majcom_cd: majcom_cd || null,
        site_cd: site_cd || null,
        unit_cd: unit_cd || null,
        squad_cd: squad_cd || null,
        description: description || null,
        geoloc: geoloc || null,
        active: active !== undefined ? active : true,
        ins_by: req.user?.username || 'system',
        ins_date: new Date()
      },
      select: {
        loc_id: true,
        display_name: true,
        majcom_cd: true,
        site_cd: true,
        unit_cd: true,
        squad_cd: true,
        description: true,
        geoloc: true,
        active: true,
        ins_by: true,
        ins_date: true,
        chg_by: true,
        chg_date: true,
        old_loc_id: true,
      }
    })

    console.log(`[ADMIN-LOCATIONS] Created new location ${newLocation.loc_id}: ${newLocation.display_name} by ${req.user?.username}`)
    res.status(201).json(newLocation)
  } catch (error) {
    console.error('[ADMIN-LOCATIONS] Error creating location:', error)
    res.status(500).json({ error: 'Failed to create location' })
  }
})

// Get audit logs (admin only)
app.get('/api/audit-logs', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    // Query filters from query params
    const userId = req.query.user_id ? parseInt(req.query.user_id as string, 10) : undefined
    const tableName = req.query.table_name as string | undefined
    const action = req.query.action as string | undefined
    const startDate = req.query.start_date as string | undefined
    const endDate = req.query.end_date as string | undefined
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0

    // Build where clause
    const where: any = {}
    if (userId) where.user_id = userId
    if (tableName) where.table_name = tableName
    if (action) where.action = action
    if (startDate || endDate) {
      where.created_at = {}
      if (startDate) where.created_at.gte = new Date(startDate)
      if (endDate) where.created_at.lte = new Date(endDate)
    }

    // Get audit logs from database with user info
    const auditLogs = await prisma.auditLog.findMany({
      where,
      include: {
        user: {
          select: {
            username: true,
            first_name: true,
            last_name: true,
          },
        },
      },
      orderBy: {
        created_at: 'desc',
      },
      take: limit,
      skip: offset,
    })

    // Get total count for pagination
    const totalCount = await prisma.auditLog.count({ where })

    // Format the response
    const formattedLogs = auditLogs.map(log => ({
      log_id: log.log_id,
      user_id: log.user_id,
      username: log.user?.username || 'Unknown',
      user_full_name: log.user ? `${log.user.first_name} ${log.user.last_name}` : 'Unknown User',
      action: log.action,
      table_name: log.table_name,
      record_id: log.record_id,
      old_values: log.old_values,
      new_values: log.new_values,
      ip_address: log.ip_address,
      created_at: log.created_at.toISOString(),
    }))

    console.log(`[AUDIT] Audit logs requested by admin - returned ${formattedLogs.length} of ${totalCount} logs`)
    res.json({
      logs: formattedLogs,
      total: totalCount,
      limit,
      offset,
    })
  } catch (error) {
    console.error('[AUDIT] Error fetching audit logs:', error)
    res.status(500).json({ error: 'Failed to fetch audit logs' })
  }
})

// ============================================================================
// CODE MANAGEMENT (Admin only)
// ============================================================================

// Get all code values (admin only)
app.get('/api/admin/codes', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const { code_type, active } = req.query

    const where: any = {}
    if (code_type) where.code_type = code_type as string
    if (active !== undefined) where.active = active === 'true'

    const codes = await prisma.code.findMany({
      where,
      orderBy: [
        { code_type: 'asc' },
        { sort_order: 'asc' },
        { code_value: 'asc' },
      ],
    })

    console.log(`[CODE-MGMT] Fetched ${codes.length} codes${code_type ? ` for type ${code_type}` : ''}`)
    res.json({ codes })
  } catch (error) {
    console.error('[CODE-MGMT] Error fetching codes:', error)
    res.status(500).json({ error: 'Failed to fetch codes' })
  }
})

// Get code types (admin only)
app.get('/api/admin/code-types', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const codeTypes = await prisma.code.findMany({
      select: {
        code_type: true,
      },
      distinct: ['code_type'],
      orderBy: {
        code_type: 'asc',
      },
    })

    console.log(`[CODE-MGMT] Fetched ${codeTypes.length} code types`)
    res.json({ code_types: codeTypes.map(c => c.code_type) })
  } catch (error) {
    console.error('[CODE-MGMT] Error fetching code types:', error)
    res.status(500).json({ error: 'Failed to fetch code types' })
  }
})

// Get a single code value (admin only)
app.get('/api/admin/codes/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const codeId = parseInt(req.params.id, 10)

    const code = await prisma.code.findUnique({
      where: { code_id: codeId },
    })

    if (!code) {
      return res.status(404).json({ error: 'Code not found' })
    }

    console.log(`[CODE-MGMT] Fetched code ${codeId}`)
    res.json({ code })
  } catch (error) {
    console.error('[CODE-MGMT] Error fetching code:', error)
    res.status(500).json({ error: 'Failed to fetch code' })
  }
})

// Create a new code value (admin only)
app.post('/api/admin/codes', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const { code_type, code_value, description, active = true, sort_order = 0 } = req.body

    // Validation
    if (!code_type || !code_value) {
      return res.status(400).json({ error: 'code_type and code_value are required' })
    }

    if (typeof code_type !== 'string' || code_type.length > 50) {
      return res.status(400).json({ error: 'code_type must be a string (max 50 characters)' })
    }

    if (typeof code_value !== 'string' || code_value.length > 50) {
      return res.status(400).json({ error: 'code_value must be a string (max 50 characters)' })
    }

    const user = req.user as { user_id: number; username: string }

    // Check if code already exists
    const existing = await prisma.code.findUnique({
      where: {
        code_type_code_value: {
          code_type,
          code_value,
        },
      },
    })

    if (existing) {
      return res.status(409).json({ error: 'Code with this type and value already exists' })
    }

    // Create the code
    const code = await prisma.code.create({
      data: {
        code_type,
        code_value,
        description: description || null,
        active,
        sort_order,
        ins_by: user.username,
      },
    })

    console.log(`[CODE-MGMT] Created code ${code_type}/${code_value} (ID: ${code.code_id})`)

    res.status(201).json({
      message: 'Code created successfully',
      code,
    })
  } catch (error) {
    console.error('[CODE-MGMT] Error creating code:', error)
    res.status(500).json({ error: 'Failed to create code' })
  }
})

// Update a code value (admin only)
app.put('/api/admin/codes/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const codeId = parseInt(req.params.id, 10)
    const { code_value, description, active, sort_order } = req.body

    // Check if code exists
    const existing = await prisma.code.findUnique({
      where: { code_id: codeId },
    })

    if (!existing) {
      return res.status(404).json({ error: 'Code not found' })
    }

    const user = req.user as { user_id: number; username: string }

    // Build update data
    const updateData: any = {
      chg_by: user.username,
      chg_date: new Date(),
    }

    if (code_value !== undefined) {
      if (typeof code_value !== 'string' || code_value.length > 50) {
        return res.status(400).json({ error: 'code_value must be a string (max 50 characters)' })
      }
      updateData.code_value = code_value
    }

    if (description !== undefined) {
      updateData.description = description
    }

    if (active !== undefined) {
      updateData.active = active
    }

    if (sort_order !== undefined) {
      updateData.sort_order = sort_order
    }

    // Update the code
    const code = await prisma.code.update({
      where: { code_id: codeId },
      data: updateData,
    })

    console.log(`[CODE-MGMT] Updated code ${existing.code_type}/${code_value || existing.code_value} (ID: ${codeId})`)

    res.json({
      message: 'Code updated successfully',
      code,
    })
  } catch (error) {
    console.error('[CODE-MGMT] Error updating code:', error)
    res.status(500).json({ error: 'Failed to update code' })
  }
})

// Deactivate a code value (soft delete) - admin only
app.patch('/api/admin/codes/:id/deactivate', async (req, res) => {
  const user = requireAdminAndGetUser(req, res)
  if (!user) return

  try {
    const codeId = parseInt(req.params.id, 10)

    // Check if code exists
    const existing = await prisma.code.findUnique({
      where: { code_id: codeId },
    })

    if (!existing) {
      return res.status(404).json({ error: 'Code not found' })
    }

    if (!existing.active) {
      return res.status(400).json({ error: 'Code is already deactivated' })
    }

    // Soft delete by setting active to false
    const code = await prisma.code.update({
      where: { code_id: codeId },
      data: {
        active: false,
        chg_by: user.username,
        chg_date: new Date(),
      },
    })

    console.log(`[CODE-MGMT] Deactivated code ${existing.code_type}/${existing.code_value} (ID: ${codeId})`)

    res.json({
      message: 'Code deactivated successfully',
      code,
    })
  } catch (error) {
    console.error('[CODE-MGMT] Error deactivating code:', error)
    res.status(500).json({ error: 'Failed to deactivate code' })
  }
})

// Reactivate a code value - admin only
app.patch('/api/admin/codes/:id/activate', async (req, res) => {
  const user = requireAdminAndGetUser(req, res)
  if (!user) return

  try {
    const codeId = parseInt(req.params.id, 10)

    // Check if code exists
    const existing = await prisma.code.findUnique({
      where: { code_id: codeId },
    })

    if (!existing) {
      return res.status(404).json({ error: 'Code not found' })
    }

    if (existing.active) {
      return res.status(400).json({ error: 'Code is already active' })
    }

    // Reactivate the code
    const code = await prisma.code.update({
      where: { code_id: codeId },
      data: {
        active: true,
        chg_by: user.username,
        chg_date: new Date(),
      },
    })

    console.log(`[CODE-MGMT] Reactivated code ${existing.code_type}/${existing.code_value} (ID: ${codeId})`)

    res.json({
      message: 'Code reactivated successfully',
      code,
    })
  } catch (error) {
    console.error('[CODE-MGMT] Error reactivating code:', error)
    res.status(500).json({ error: 'Failed to reactivate code' })
  }
})

// Delete a code value (hard delete) - admin only
app.delete('/api/admin/codes/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const codeId = parseInt(req.params.id, 10)

    // Check if code exists
    const existing = await prisma.code.findUnique({
      where: { code_id: codeId },
    })

    if (!existing) {
      return res.status(404).json({ error: 'Code not found' })
    }

    // Delete the code
    await prisma.code.delete({
      where: { code_id: codeId },
    })

    console.log(`[CODE-MGMT] Deleted code ${existing.code_type}/${existing.code_value} (ID: ${codeId})`)

    res.json({
      message: 'Code deleted successfully',
    })
  } catch (error) {
    console.error('[CODE-MGMT] Error deleting code:', error)
    res.status(500).json({ error: 'Failed to delete code' })
  }
})

// ============================================================================
// END CODE MANAGEMENT
// ============================================================================

// System Settings: Get all settings (admin only)
app.get('/api/settings', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const settings = await prisma.admVariable.findMany({
      where: {
        active: true,
      },
      orderBy: {
        var_name: 'asc',
      },
    })

    console.log(`[SETTINGS] Settings requested by admin - returned ${settings.length} settings`)
    res.json({ settings })
  } catch (error) {
    console.error('[SETTINGS] Error fetching settings:', error)
    res.status(500).json({ error: 'Failed to fetch settings' })
  }
})

// System Settings: Update a setting (admin only)
app.put('/api/settings/:varName', async (req, res) => {
  if (!requireAdmin(req, res)) return

  const { varName } = req.params
  const { var_value } = req.body

  if (var_value === undefined) {
    return res.status(400).json({ error: 'var_value is required' })
  }

  try {
    const payload = authenticateRequest(req, res)
    if (!payload) return

    // Check if setting exists
    const existingSetting = await prisma.admVariable.findUnique({
      where: { var_name: varName },
    })

    if (!existingSetting) {
      return res.status(404).json({ error: 'Setting not found' })
    }

    // Store old value for audit log
    const oldValue = existingSetting.var_value

    // Update the setting
    const updatedSetting = await prisma.admVariable.update({
      where: { var_name: varName },
      data: {
        var_value: String(var_value),
        chg_by: payload.username,
        chg_date: new Date(),
      },
    })

    // Log the change in audit log
    await prisma.auditLog.create({
      data: {
        user_id: payload.userId,
        action: 'UPDATE',
        table_name: 'AdmVariable',
        record_id: updatedSetting.var_id,
        old_values: { var_value: oldValue },
        new_values: { var_value: var_value },
        ip_address: getClientIP(req),
      },
    })

    console.log(`[SETTINGS] Setting '${varName}' updated by ${payload.username}: ${oldValue} -> ${var_value}`)
    res.json({ setting: updatedSetting })
  } catch (error) {
    console.error('[SETTINGS] Error updating setting:', error)
    res.status(500).json({ error: 'Failed to update setting' })
  }
})

// Program Locations: Get all programs with their assigned locations (admin only)
app.get('/api/program-locations', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const programs = await prisma.program.findMany({
      where: {
        active: true,
      },
      include: {
        programLocations: {
          where: {
            active: true,
          },
          include: {
            location: true,
          },
        },
      },
      orderBy: {
        pgm_name: 'asc',
      },
    })

    console.log(`[PROGRAM-LOCATIONS] Retrieved ${programs.length} programs with location mappings`)
    res.json({ programs })
  } catch (error) {
    console.error('[PROGRAM-LOCATIONS] Error fetching program locations:', error)
    res.status(500).json({ error: 'Failed to fetch program locations' })
  }
})

// Program Locations: Get locations for a specific program (admin only)
app.get('/api/program-locations/:programId', async (req, res) => {
  if (!requireAdmin(req, res)) return

  const programId = parseInt(req.params.programId, 10)
  if (isNaN(programId)) {
    return res.status(400).json({ error: 'Invalid program ID' })
  }

  try {
    const program = await prisma.program.findUnique({
      where: { pgm_id: programId },
      include: {
        programLocations: {
          where: {
            active: true,
          },
          include: {
            location: true,
          },
        },
      },
    })

    if (!program) {
      return res.status(404).json({ error: 'Program not found' })
    }

    console.log(`[PROGRAM-LOCATIONS] Retrieved locations for program ${program.pgm_name}`)
    res.json({ program })
  } catch (error) {
    console.error('[PROGRAM-LOCATIONS] Error fetching program locations:', error)
    res.status(500).json({ error: 'Failed to fetch program locations' })
  }
})

// Program Locations: Get all available locations (admin only)
app.get('/api/locations', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const locations = await prisma.location.findMany({
      where: {
        active: true,
      },
      orderBy: {
        display_name: 'asc',
      },
    })

    console.log(`[PROGRAM-LOCATIONS] Retrieved ${locations.length} active locations`)
    res.json({ locations })
  } catch (error) {
    console.error('[PROGRAM-LOCATIONS] Error fetching locations:', error)
    res.status(500).json({ error: 'Failed to fetch locations' })
  }
})

// Program Locations: Add location to program (admin only)
app.post('/api/program-locations/:programId/locations', async (req, res) => {
  if (!requireAdmin(req, res)) return

  const payload = authenticateRequest(req, res)
  if (!payload) return

  const programId = parseInt(req.params.programId, 10)
  const { loc_id } = req.body

  if (isNaN(programId)) {
    return res.status(400).json({ error: 'Invalid program ID' })
  }

  if (!loc_id) {
    return res.status(400).json({ error: 'Location ID is required' })
  }

  try {
    // Check if program exists
    const program = await prisma.program.findUnique({
      where: { pgm_id: programId },
    })

    if (!program) {
      return res.status(404).json({ error: 'Program not found' })
    }

    // Check if location exists
    const location = await prisma.location.findUnique({
      where: { loc_id },
    })

    if (!location) {
      return res.status(404).json({ error: 'Location not found' })
    }

    // Check if mapping already exists
    const existingMapping = await prisma.programLocation.findUnique({
      where: {
        pgm_id_loc_id: {
          pgm_id: programId,
          loc_id,
        },
      },
    })

    if (existingMapping) {
      if (existingMapping.active) {
        return res.status(400).json({ error: 'Location is already assigned to this program' })
      } else {
        // Reactivate the existing mapping
        const reactivatedMapping = await prisma.programLocation.update({
          where: { program_location_id: existingMapping.program_location_id },
          data: {
            active: true,
            chg_by: payload.username,
            chg_date: new Date(),
          },
          include: {
            location: true,
          },
        })

        console.log(`[PROGRAM-LOCATIONS] Reactivated location ${location.display_name} for program ${program.pgm_name} by ${payload.username}`)
        return res.json({ programLocation: reactivatedMapping })
      }
    }

    // Create new mapping
    const programLocation = await prisma.programLocation.create({
      data: {
        pgm_id: programId,
        loc_id,
        ins_by: payload.username,
      },
      include: {
        location: true,
      },
    })

    // Log in audit log
    await prisma.auditLog.create({
      data: {
        user_id: payload.userId,
        action: 'CREATE',
        table_name: 'ProgramLocation',
        record_id: programLocation.program_location_id,
        new_values: { pgm_id: programId, loc_id },
        ip_address: getClientIP(req),
      },
    })

    console.log(`[PROGRAM-LOCATIONS] Added location ${location.display_name} to program ${program.pgm_name} by ${payload.username}`)
    res.json({ programLocation })
  } catch (error) {
    console.error('[PROGRAM-LOCATIONS] Error adding location to program:', error)
    res.status(500).json({ error: 'Failed to add location to program' })
  }
})

// Program Locations: Remove location from program (admin only)
app.delete('/api/program-locations/:programId/locations/:locationId', async (req, res) => {
  if (!requireAdmin(req, res)) return

  const payload = authenticateRequest(req, res)
  if (!payload) return

  const programId = parseInt(req.params.programId, 10)
  const locationId = parseInt(req.params.locationId, 10)

  if (isNaN(programId) || isNaN(locationId)) {
    return res.status(400).json({ error: 'Invalid program ID or location ID' })
  }

  try {
    // Find the mapping
    const mapping = await prisma.programLocation.findUnique({
      where: {
        pgm_id_loc_id: {
          pgm_id: programId,
          loc_id: locationId,
        },
      },
      include: {
        program: true,
        location: true,
      },
    })

    if (!mapping) {
      return res.status(404).json({ error: 'Location is not assigned to this program' })
    }

    // Soft delete by setting active to false
    const updatedMapping = await prisma.programLocation.update({
      where: { program_location_id: mapping.program_location_id },
      data: {
        active: false,
        chg_by: payload.username,
        chg_date: new Date(),
      },
    })

    // Log in audit log
    await prisma.auditLog.create({
      data: {
        user_id: payload.userId,
        action: 'DELETE',
        table_name: 'ProgramLocation',
        record_id: mapping.program_location_id,
        old_values: { pgm_id: programId, loc_id: locationId, active: true },
        new_values: { active: false },
        ip_address: getClientIP(req),
      },
    })

    console.log(`[PROGRAM-LOCATIONS] Removed location ${mapping.location.display_name} from program ${mapping.program.pgm_name} by ${payload.username}`)
    res.json({ success: true, message: 'Location removed from program' })
  } catch (error) {
    console.error('[PROGRAM-LOCATIONS] Error removing location from program:', error)
    res.status(500).json({ error: 'Failed to remove location from program' })
  }
})

// Dashboard: Get asset status summary (requires authentication)
app.get('/api/dashboard/asset-status', async (req, res) => {
  const payload = authenticateRequest(req, res)
  if (!payload) return

  const user = mockUsers.find(u => u.user_id === payload.userId)
  if (!user) {
    return res.status(401).json({ error: 'User not found' })
  }

  // Get the program ID from query param, or use user's default program
  let programId = parseInt(req.query.program_id as string, 10)
  if (isNaN(programId)) {
    // Default to user's default program
    const defaultProgram = user.programs.find(p => p.is_default)
    programId = defaultProgram?.pgm_id || user.programs[0]?.pgm_id || 1
  }

  // Check if user has access to this program
  if (!user.programs.find(p => p.pgm_id === programId) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this program' })
  }

  // Get user's location IDs for authorization check
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || []

  // Get location filter from query string (optional)
  let locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null

  // If location specified, verify user has access to it
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' })
  }

  try {
    // Query assets from database using Prisma - group by status_cd
    // Note: Asset doesn't have direct pgm_id - it's via part.pgm_id relation
    const whereClause: Prisma.AssetWhereInput = {
      part: {
        pgm_id: programId,
      },
      active: true,
    }

    // Apply location filter if specified
    if (locationIdFilter) {
      whereClause.OR = [
        { loc_ida: locationIdFilter },
        { loc_idc: locationIdFilter },
      ]
    }

    // Get total count
    const totalAssets = await prisma.asset.count({ where: whereClause })

    // Get status counts grouped by status_cd
    const statusGroups = await prisma.asset.groupBy({
      by: ['status_cd'],
      where: whereClause,
      _count: {
        status_cd: true,
      },
    })

    // Build status counts map
    const statusCounts: Record<string, number> = {
      FMC: 0,
      PMC: 0,
      PMCM: 0,
      PMCS: 0,
      PMCB: 0,
      NMCM: 0,
      NMCS: 0,
      NMCB: 0,
      CNDM: 0,
    }

    statusGroups.forEach(group => {
      if (group.status_cd && statusCounts.hasOwnProperty(group.status_cd)) {
        statusCounts[group.status_cd] = group._count.status_cd
      }
    })

    // Build response with status details
    const statusSummary = assetStatusCodes.map(status => ({
      status_cd: status.status_cd,
      status_name: status.status_name,
      description: status.description,
      count: statusCounts[status.status_cd] || 0,
    }))

    // Calculate mission capability rate (FMC + PMC + PMCM + PMCS + PMCB as capable)
    const missionCapable = statusCounts.FMC + statusCounts.PMC + statusCounts.PMCM + statusCounts.PMCS + statusCounts.PMCB
    const missionCapabilityRate = totalAssets > 0 ? Math.round((missionCapable / totalAssets) * 100) : 0

    res.json({
      program_id: programId,
      program_cd: allPrograms.find(p => p.pgm_id === programId)?.pgm_cd || 'UNKNOWN',
      total_assets: totalAssets,
      mission_capability_rate: missionCapabilityRate,
      status_summary: statusSummary,
    })
  } catch (error) {
    console.error('[Dashboard] Error fetching asset status:', error)
    res.status(500).json({ error: 'Failed to fetch asset status' })
  }
})

// Mock PMI data for testing
interface PMIRecord {
  pmi_id: number;
  asset_id: number;
  asset_sn: string;
  asset_name: string;
  pmi_type: string;
  wuc_cd: string;
  next_due_date: string;
  days_until_due: number;
  completed_date: string | null;
  pgm_id: number;
  status: 'overdue' | 'due_soon' | 'upcoming' | 'completed';
  interval_days: number; // PMI interval in days (30, 60, 90, 180, 365)
}

// Helper to calculate days until due
function calculateDaysUntilDue(dateString: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(dateString);
  dueDate.setHours(0, 0, 0, 0);
  const diffTime = dueDate.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Helper to determine PMI status based on days until due
function getPMIStatus(daysUntilDue: number): PMIRecord['status'] {
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue <= 7) return 'due_soon';  // Red - within 7 days
  if (daysUntilDue <= 30) return 'upcoming'; // Yellow - 8-30 days
  return 'upcoming'; // Green - after 30 days
}

// Generate dynamic PMI data based on current date
// PMI data cache - loaded from DB
let cachedPMIRecords: PMIRecord[] = [];
let pmiCacheLoaded = false;

function generateMockPMIData(): PMIRecord[] {
  // Return cached DB data instead of hardcoded mock
  return cachedPMIRecords;
}

function calculateDaysUntilDueFromDate(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(dateStr);
  dueDate.setHours(0, 0, 0, 0);
  return Math.floor((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function getPMIStatusFromDays(days: number): 'overdue' | 'due_soon' | 'upcoming' | 'scheduled' | 'completed' {
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_soon';
  if (days <= 30) return 'upcoming';
  return 'scheduled';
}

async function initializePMIFromDb(): Promise<void> {
  try {
    const inspections = await prisma.assetInspection.findMany({
      where: { complete_date: null }, // Only incomplete/pending PMIs
      include: {
        asset: {
          include: {
            part: true,
            assignedLocation: true,
          },
        },
      },
    });

    // Map PMI types to interval days
    const pmiIntervalMap: Record<string, number> = {
      '30-DAY': 30,
      '60-DAY': 60,
      '90-DAY': 90,
      '180-DAY': 180,
      '365-DAY': 365,
      'SPECIAL': 90,
    };

    cachedPMIRecords = inspections.map(insp => {
      const nextDueStr = insp.next_due_date ? new Date(insp.next_due_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      const daysUntilDue = calculateDaysUntilDueFromDate(nextDueStr);
      const pmiType = insp.pmi_type ?? 'SPECIAL';
      
      return {
        pmi_id: insp.hist_id,
        asset_id: insp.asset_id,
        asset_sn: insp.asset?.serno ?? '',
        asset_name: insp.asset?.part?.noun ?? '',
        pmi_type: pmiType,
        wuc_cd: insp.wuc_cd ?? '',
        next_due_date: nextDueStr,
        days_until_due: daysUntilDue,
        completed_date: insp.complete_date ? new Date(insp.complete_date).toISOString().split('T')[0] : null,
        pgm_id: insp.asset?.part?.pgm_id ?? 0,
        status: getPMIStatusFromDays(daysUntilDue) as any,
        interval_days: pmiIntervalMap[pmiType] ?? 90,
      };
    });

    pmiCacheLoaded = true;
    console.log(`[PMI] Loaded ${cachedPMIRecords.length} PMI records from database`);
  } catch (error) {
    console.error('[PMI] Failed to load from DB:', error);
  }
}

// Get PMI due soon endpoint (with optional program filtering)
app.get('/api/pmi/due-soon', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get program filter from query string (optional)
  const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // Get user's location IDs for authorization check
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get location filter from query string (optional)
  let locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;

  // If location specified, verify user has access to it
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' });
  }

  // Get interval filter from query string (optional) - supports 30, 60, 90, 180, 365
  const intervalFilter = req.query.interval_days ? parseInt(req.query.interval_days as string, 10) : null;

  // Get search filter from query string (optional) - searches asset serial number and name
  const searchFilter = req.query.search ? (req.query.search as string).toLowerCase().trim() : null;

  // Get overdue_only filter from query string (optional) - shows only overdue PMIs
  const overdueOnlyFilter = req.query.overdue_only === 'true';

  // Fetch real PMI data from database
  const dbPMIs = await prisma.assetInspection.findMany({
    where: {
      complete_date: null, // Only incomplete PMIs
      next_due_date: { gte: new Date('2025-01-01') }, // PMIs due in the future
    },
    include: {
      asset: {
        include: {
          part: true, // Include part to get pgm_id
        },
      },
    },
  });

  console.log(`[PMI-DEBUG] Found ${dbPMIs.length} PMI records in database`);

  // Transform database records to PMI format
  const allPMI = dbPMIs.map(pmi => {
    const daysUntilDue = pmi.next_due_date
      ? Math.ceil((new Date(pmi.next_due_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
      : 999;

    return {
      pmi_id: pmi.hist_id,
      asset_id: pmi.asset_id,
      asset_sn: pmi.asset?.serno || 'Unknown',
      asset_name: pmi.asset?.part?.noun || 'Unknown Asset',
      pmi_type: pmi.pmi_type || 'PMI',
      wuc_cd: pmi.wuc_cd || '',
      next_due_date: pmi.next_due_date?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0],
      days_until_due: daysUntilDue,
      completed_date: pmi.complete_date?.toISOString().split('T')[0] || null,
      pgm_id: pmi.asset?.part?.pgm_id || 1,
      status: pmi.complete_date ? 'completed' as const : getPMIStatus(daysUntilDue),
    };
  });

  // Filter PMI records by user's accessible programs
  let filteredPMI = allPMI.filter(pmi => userProgramIds.includes(pmi.pgm_id));

  // Apply program filter if specified
  if (programIdFilter && userProgramIds.includes(programIdFilter)) {
    filteredPMI = filteredPMI.filter(pmi => pmi.pgm_id === programIdFilter);
  }

  // SECURITY: Filter by location - use real asset data from database
  // ADMIN role bypasses location filtering to see all PMIs for their programs
  if (user.role !== 'ADMIN' && (locationIdFilter || userLocationIds.length > 0)) {
    filteredPMI = filteredPMI.filter(pmi => {
      // Asset location data is already included from the database query
      const asset = pmi.asset; // Use the asset from the PMI record
      if (!asset) return false;

      if (locationIdFilter) {
        // Filter by specific location
        const matchesAssignedBase = asset.loc_ida === locationIdFilter;
        const matchesCurrentBase = asset.loc_idc === locationIdFilter;
        return matchesAssignedBase || matchesCurrentBase;
      } else if (userLocationIds.length > 0) {
        // Filter by all user's locations
        const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida);
        const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc);
        return matchesAssignedBase || matchesCurrentBase;
      }
      return true;
    });
  }

  // Apply interval filter if specified (30, 60, 90, 180, 365 days)
  if (intervalFilter && [30, 60, 90, 180, 365].includes(intervalFilter)) {
    filteredPMI = filteredPMI.filter(pmi => pmi.interval_days === intervalFilter);
  }

  // Apply search filter if specified (searches asset serial number and asset name)
  if (searchFilter) {
    filteredPMI = filteredPMI.filter(pmi =>
      pmi.asset_sn.toLowerCase().includes(searchFilter) ||
      pmi.asset_name.toLowerCase().includes(searchFilter) ||
      pmi.pmi_type.toLowerCase().includes(searchFilter)
    );
  }

  // Apply overdue only filter if specified
  if (overdueOnlyFilter) {
    filteredPMI = filteredPMI.filter(pmi => pmi.days_until_due < 0);
  }

  // Sort by days_until_due (most urgent first)
  filteredPMI.sort((a, b) => a.days_until_due - b.days_until_due);

  // Calculate summary counts
  const summary = {
    overdue: filteredPMI.filter(p => p.days_until_due < 0).length,
    red: filteredPMI.filter(p => p.days_until_due >= 0 && p.days_until_due <= 7).length,
    yellow: filteredPMI.filter(p => p.days_until_due > 7 && p.days_until_due <= 30).length,
    green: filteredPMI.filter(p => p.days_until_due > 30).length,
    total: filteredPMI.length,
  };

  console.log(`[PMI] Due soon request by ${user.username} - Total: ${summary.total}, Red: ${summary.red + summary.overdue}, Yellow: ${summary.yellow}, Green: ${summary.green}`);

  res.json({
    pmi: filteredPMI,
    summary,
  });
});

// Custom PMI records storage (for user-created PMIs)
let customPMIRecords: PMIRecord[] = [];
let nextCustomPMIId = 100; // Start custom IDs at 100 to avoid conflicts

// Get all PMI records (for PMI list page)
app.get('/api/pmi', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's accessible program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get user's location IDs for location-based filtering
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get program filter from query string (optional)
  const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // Get location filter from query string (optional)
  const locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;

  // Validate location filter if specified
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' });
  }

  // Get search filter from query string (optional) - searches asset serial number, name, and PMI type
  const searchFilter = req.query.search ? (req.query.search as string).toLowerCase().trim() : null;

  // Get overdue_only filter from query string (optional) - shows only overdue PMIs
  const overdueOnlyFilter = req.query.overdue_only === 'true';

  // Get interval filter from query string (optional) - supports 30, 60, 90, 180, 365
  const intervalFilter = req.query.interval_days ? parseInt(req.query.interval_days as string, 10) : null;

  // Get both generated and custom PMI data
  // Custom records may include overrides for generated PMIs, so we need to dedupe
  const generatedPMI = generateMockPMIData();
  const customPMIIds = new Set(customPMIRecords.map(p => p.pmi_id));
  // Filter out generated PMIs that have been overridden by custom records
  const filteredGeneratedPMI = generatedPMI.filter(p => !customPMIIds.has(p.pmi_id));
  const allPMI = [...filteredGeneratedPMI, ...customPMIRecords];

  // Filter PMI records by user's accessible programs
  let filteredPMI = allPMI.filter(pmi => userProgramIds.includes(pmi.pgm_id));

  // Apply program filter if specified
  if (programIdFilter && userProgramIds.includes(programIdFilter)) {
    filteredPMI = filteredPMI.filter(pmi => pmi.pgm_id === programIdFilter);
  }

  // SECURITY: Filter by location - PMI records shown only if associated asset is at user's locations
  // Join with assets to get location information
  if (locationIdFilter) {
    // Filter by specific requested location
    filteredPMI = filteredPMI.filter(pmi => {
      const asset = detailedAssets.find(a => a.asset_id === pmi.asset_id);
      if (!asset) return false;
      const matchesAssignedBase = asset.loc_ida === locationIdFilter;
      const matchesCurrentBase = asset.loc_idc === locationIdFilter;
      return matchesAssignedBase || matchesCurrentBase;
    });
  } else if (userLocationIds.length > 0) {
    // Filter by all user's locations (non-admin users)
    filteredPMI = filteredPMI.filter(pmi => {
      const asset = detailedAssets.find(a => a.asset_id === pmi.asset_id);
      if (!asset) return false;
      const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida);
      const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc);
      return matchesAssignedBase || matchesCurrentBase;
    });
  }

  // Update days_until_due and status dynamically
  filteredPMI = filteredPMI.map(pmi => {
    const daysUntilDue = calculateDaysUntilDue(pmi.next_due_date);
    return {
      ...pmi,
      days_until_due: daysUntilDue,
      status: pmi.completed_date ? 'completed' as const : getPMIStatus(daysUntilDue),
    };
  });

  // Apply search filter if specified (searches asset serial number, name, and PMI type)
  if (searchFilter) {
    filteredPMI = filteredPMI.filter(pmi =>
      pmi.asset_sn.toLowerCase().includes(searchFilter) ||
      pmi.asset_name.toLowerCase().includes(searchFilter) ||
      pmi.pmi_type.toLowerCase().includes(searchFilter)
    );
  }

  // Apply overdue only filter if specified
  if (overdueOnlyFilter) {
    filteredPMI = filteredPMI.filter(pmi => pmi.days_until_due < 0);
  }

  // Apply interval filter if specified (30, 60, 90, 180, 365 days)
  if (intervalFilter && [30, 60, 90, 180, 365].includes(intervalFilter)) {
    filteredPMI = filteredPMI.filter(pmi => pmi.interval_days === intervalFilter);
  }

  // Sort by days_until_due (most urgent first)
  filteredPMI.sort((a, b) => a.days_until_due - b.days_until_due);

  console.log(`[PMI] List request by ${user.username} - Total: ${filteredPMI.length}${searchFilter ? ` (search: "${searchFilter}")` : ''}${overdueOnlyFilter ? ' (overdue only)' : ''}`);

  res.json({
    pmi: filteredPMI,
    total: filteredPMI.length,
  });
});

// ============================================
// TCTO (Time Compliance Technical Order) API
// ============================================

// Helper to calculate days until compliance deadline
function calculateDaysUntilDeadline(dateString: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadlineDate = new Date(dateString);
  deadlineDate.setHours(0, 0, 0, 0);
  const diffTime = deadlineDate.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// GET /api/tcto - List all TCTOs for user's programs
app.get('/api/tcto', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get user's location IDs for location-based filtering
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get program filter from query string (optional)
  const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // Get location filter from query string (optional)
  const locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;

  // Validate location filter if specified
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' });
  }

  // Get status filter from query string (optional)
  const statusFilter = req.query.status as string | undefined; // 'open', 'closed', or undefined for all

  // Get search filter from query string (optional)
  const searchFilter = req.query.search ? (req.query.search as string).toLowerCase().trim() : null;

  // Helper function to check if an asset is at user's location(s)
  const isAssetAtUserLocation = (assetId: number): boolean => {
    const asset = detailedAssets.find(a => a.asset_id === assetId);
    if (!asset) return false;

    if (locationIdFilter) {
      // Check against specific location filter
      return asset.loc_ida === locationIdFilter || asset.loc_idc === locationIdFilter;
    } else if (userLocationIds.length > 0) {
      // Check against all user's locations
      const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida);
      const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc);
      return matchesAssignedBase || matchesCurrentBase;
    }
    // Admin users with no location restrictions see all assets
    return true;
  };

  // Filter TCTO records by user's accessible programs
  let filteredTCTO = tctoRecords.filter(tcto => userProgramIds.includes(tcto.pgm_id));

  // Apply program filter if specified
  if (programIdFilter && userProgramIds.includes(programIdFilter)) {
    filteredTCTO = filteredTCTO.filter(tcto => tcto.pgm_id === programIdFilter);
  }

  // SECURITY: Filter by location - only show TCTOs that have at least one affected asset at user's locations
  // Also filter the affected_assets and compliant_assets arrays to only include assets at user's locations
  // ADMIN users are exempt from location filtering
  if ((locationIdFilter || userLocationIds.length > 0) && user.role !== 'ADMIN') {
    filteredTCTO = filteredTCTO
      .map(tcto => {
        // Filter affected and compliant assets by location
        const filteredAffectedAssets = tcto.affected_assets.filter(isAssetAtUserLocation);
        const filteredCompliantAssets = tcto.compliant_assets.filter(isAssetAtUserLocation);

        return {
          ...tcto,
          affected_assets: filteredAffectedAssets,
          compliant_assets: filteredCompliantAssets,
        };
      })
      .filter(tcto => tcto.affected_assets.length > 0); // Only show TCTOs with at least one affected asset at user's location
  }

  // Apply status filter if specified
  if (statusFilter === 'open' || statusFilter === 'closed') {
    filteredTCTO = filteredTCTO.filter(tcto => tcto.status === statusFilter);
  }

  // Apply search filter if specified (searches TCTO number and title)
  if (searchFilter) {
    filteredTCTO = filteredTCTO.filter(tcto =>
      tcto.tcto_no.toLowerCase().includes(searchFilter) ||
      tcto.title.toLowerCase().includes(searchFilter) ||
      tcto.description.toLowerCase().includes(searchFilter)
    );
  }

  // Calculate compliance info for each TCTO (using the filtered asset arrays)
  const tctoWithCompliance = filteredTCTO.map(tcto => {
    const daysUntilDeadline = calculateDaysUntilDeadline(tcto.compliance_deadline);
    const compliancePercentage = tcto.affected_assets.length > 0
      ? Math.round((tcto.compliant_assets.length / tcto.affected_assets.length) * 100)
      : 100;

    // Get program info
    const program = allPrograms.find(p => p.pgm_id === tcto.pgm_id);

    return {
      ...tcto,
      days_until_deadline: daysUntilDeadline,
      compliance_percentage: compliancePercentage,
      assets_remaining: tcto.affected_assets.length - tcto.compliant_assets.length,
      is_overdue: daysUntilDeadline < 0 && tcto.status === 'open',
      program_code: program?.pgm_cd || '',
      program_name: program?.pgm_name || '',
    };
  });

  // Sort by deadline (most urgent first), then by TCTO number
  tctoWithCompliance.sort((a, b) => {
    // Open TCTOs first
    if (a.status !== b.status) {
      return a.status === 'open' ? -1 : 1;
    }
    // Then by days until deadline
    return a.days_until_deadline - b.days_until_deadline;
  });

  // Calculate summary counts
  const summary = {
    total: tctoWithCompliance.length,
    open: tctoWithCompliance.filter(t => t.status === 'open').length,
    closed: tctoWithCompliance.filter(t => t.status === 'closed').length,
    overdue: tctoWithCompliance.filter(t => t.is_overdue).length,
    critical: tctoWithCompliance.filter(t => t.priority === 'Critical' && t.status === 'open').length,
    urgent: tctoWithCompliance.filter(t => t.priority === 'Urgent' && t.status === 'open').length,
    routine: tctoWithCompliance.filter(t => t.priority === 'Routine' && t.status === 'open').length,
  };

  console.log(`[TCTO] List request by ${user.username} - Total: ${summary.total}, Open: ${summary.open}, Closed: ${summary.closed}`);

  res.json({
    tcto: tctoWithCompliance,
    summary,
    total: tctoWithCompliance.length,
  });
});

// POST /api/tcto - Create new TCTO record
app.post('/api/tcto', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Only admin and depot_manager can create TCTOs
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Only Admin and Depot Manager can create TCTO records' });
  }

  const {
    tcto_no,
    title,
    tcto_type,
    sys_type,
    effective_date,
    compliance_deadline,
    priority,
    description,
    remarks,
  } = req.body;

  // Validation
  if (!tcto_no || tcto_no.trim() === '') {
    return res.status(400).json({ error: 'TCTO number is required' });
  }
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'TCTO title is required' });
  }
  if (!effective_date) {
    return res.status(400).json({ error: 'Effective date is required' });
  }
  if (!compliance_deadline) {
    return res.status(400).json({ error: 'Compliance deadline is required' });
  }
  if (!priority || !['Routine', 'Urgent', 'Critical'].includes(priority)) {
    return res.status(400).json({ error: 'Valid priority is required (Routine, Urgent, Critical)' });
  }

  // Get the current program ID (user's first accessible program or specified in request)
  const pgm_id = req.body.pgm_id || user.programs[0]?.pgm_id;
  if (!pgm_id) {
    return res.status(400).json({ error: 'Program ID is required' });
  }

  // Verify user has access to the program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this program' });
  }

  // Check for duplicate TCTO number within the program
  const existingTcto = tctoRecords.find(t =>
    t.tcto_no.toLowerCase() === tcto_no.trim().toLowerCase() && t.pgm_id === pgm_id
  );
  if (existingTcto) {
    return res.status(400).json({ error: 'TCTO number already exists for this program' });
  }

  // Create new TCTO record
  const newTCTO: TCTORecord = {
    tcto_id: tctoNextId++,
    tcto_no: tcto_no.trim(),
    title: title.trim(),
    effective_date,
    compliance_deadline,
    pgm_id,
    status: 'open',
    priority,
    affected_assets: [], // Assets can be added later
    compliant_assets: [],
    description: description?.trim() || '',
    created_by_id: user.user_id,
    created_by_name: `${user.first_name} ${user.last_name}`,
    created_at: new Date().toISOString().split('T')[0],
  };

  // Add to records
  tctoRecords.push(newTCTO);

  // Calculate compliance info for response
  const daysUntilDeadline = calculateDaysUntilDeadline(newTCTO.compliance_deadline);
  const program = allPrograms.find(p => p.pgm_id === pgm_id);

  const responseData = {
    ...newTCTO,
    days_until_deadline: daysUntilDeadline,
    compliance_percentage: 100, // No assets yet
    assets_remaining: 0,
    is_overdue: daysUntilDeadline < 0,
    program_code: program?.pgm_cd || '',
    program_name: program?.pgm_name || '',
    tcto_type: tcto_type || '',
    sys_type: sys_type || '',
    remarks: remarks || '',
  };

  console.log(`[TCTO] Created TCTO ${newTCTO.tcto_no} (ID: ${newTCTO.tcto_id}) by ${user.username}`);

  res.status(201).json(responseData);
});

// PUT /api/tcto/:id - Update TCTO record
app.put('/api/tcto/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Only ADMIN and DEPOT_MANAGER can edit TCTOs
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Only Admin and Depot Manager can edit TCTO records' });
  }

  const tctoId = parseInt(req.params.id, 10);
  if (isNaN(tctoId)) {
    return res.status(400).json({ error: 'Invalid TCTO ID' });
  }

  // Find the TCTO record
  const tctoIndex = tctoRecords.findIndex(t => t.tcto_id === tctoId);
  if (tctoIndex === -1) {
    return res.status(404).json({ error: 'TCTO not found' });
  }

  const tcto = tctoRecords[tctoIndex];

  // Verify user has access to the TCTO's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(tcto.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this TCTO' });
  }

  const {
    effective_date,
    compliance_deadline,
    priority,
    status,
    description,
  } = req.body;

  // Validation
  if (effective_date !== undefined && !effective_date) {
    return res.status(400).json({ error: 'Effective date cannot be empty' });
  }
  if (compliance_deadline !== undefined && !compliance_deadline) {
    return res.status(400).json({ error: 'Compliance deadline cannot be empty' });
  }
  if (priority !== undefined && !['Routine', 'Urgent', 'Critical'].includes(priority)) {
    return res.status(400).json({ error: 'Valid priority is required (Routine, Urgent, Critical)' });
  }
  if (status !== undefined && !['open', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Valid status is required (open, closed)' });
  }

  // Update only provided fields
  if (effective_date !== undefined) {
    tcto.effective_date = effective_date;
  }
  if (compliance_deadline !== undefined) {
    tcto.compliance_deadline = compliance_deadline;
  }
  if (priority !== undefined) {
    tcto.priority = priority;
  }
  if (status !== undefined) {
    tcto.status = status;
  }
  if (description !== undefined) {
    tcto.description = description;
  }

  // Calculate compliance info for response
  const daysUntilDeadline = calculateDaysUntilDeadline(tcto.compliance_deadline);
  const compliancePercentage = tcto.affected_assets.length > 0
    ? Math.round((tcto.compliant_assets.length / tcto.affected_assets.length) * 100)
    : 100;
  const program = allPrograms.find(p => p.pgm_id === tcto.pgm_id);

  const responseData = {
    ...tcto,
    days_until_deadline: daysUntilDeadline,
    compliance_percentage: compliancePercentage,
    assets_remaining: tcto.affected_assets.length - tcto.compliant_assets.length,
    is_overdue: daysUntilDeadline < 0 && tcto.status === 'open',
    program_code: program?.pgm_cd || '',
    program_name: program?.pgm_name || '',
  };

  console.log(`[TCTO] Updated TCTO ${tcto.tcto_no} (ID: ${tcto.tcto_id}) by ${user.username}`);

  res.json({ message: 'TCTO updated successfully', tcto: responseData });
});

// DELETE /api/tcto/:id - Delete a TCTO record (ADMIN only)
app.delete('/api/tcto/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN can delete TCTO records
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied. Only administrators can delete TCTO records.' });
  }

  const tctoId = parseInt(req.params.id, 10);
  if (isNaN(tctoId)) {
    return res.status(400).json({ error: 'Invalid TCTO ID' });
  }

  // Find the TCTO record
  const tctoIndex = tctoRecords.findIndex(t => t.tcto_id === tctoId);
  if (tctoIndex === -1) {
    return res.status(404).json({ error: 'TCTO not found' });
  }

  const tcto = tctoRecords[tctoIndex];

  // Verify user has access to the TCTO's program (admin has access to all, but double-check)
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(tcto.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this TCTO' });
  }

  // Remove the TCTO record
  const deletedTCTO = tctoRecords.splice(tctoIndex, 1)[0];

  console.log(`[TCTO] Deleted TCTO ${deletedTCTO.tcto_no} (ID: ${deletedTCTO.tcto_id}) by ${user.username}`);

  res.json({
    message: 'TCTO deleted successfully',
    tcto: {
      tcto_id: deletedTCTO.tcto_id,
      tcto_no: deletedTCTO.tcto_no,
      title: deletedTCTO.title,
      status: deletedTCTO.status,
    },
  });
});

// GET /api/tcto/:id - Get a single TCTO with asset compliance details
app.get('/api/tcto/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const tctoId = parseInt(req.params.id, 10);
  if (isNaN(tctoId)) {
    return res.status(400).json({ error: 'Invalid TCTO ID' });
  }

  // Find the TCTO record
  const tcto = tctoRecords.find(t => t.tcto_id === tctoId);
  if (!tcto) {
    return res.status(404).json({ error: 'TCTO not found' });
  }

  // Verify user has access to the TCTO's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(tcto.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this TCTO' });
  }

  // Calculate compliance info
  const daysUntilDeadline = calculateDaysUntilDeadline(tcto.compliance_deadline);
  const compliancePercentage = tcto.affected_assets.length > 0
    ? Math.round((tcto.compliant_assets.length / tcto.affected_assets.length) * 100)
    : 100;

  // Get program info
  const program = allPrograms.find(p => p.pgm_id === tcto.pgm_id);

  // Get detailed asset information for affected assets including completion data
  const completionDataForTcto = tctoAssetCompletionData.get(tctoId) || [];
  const affectedAssetsDetails = tcto.affected_assets.map(assetId => {
    const asset = mockAssets.find(a => a.asset_id === assetId);
    const isCompliant = tcto.compliant_assets.includes(assetId);
    const completionInfo = completionDataForTcto.find(c => c.asset_id === assetId);

    // Look up linked repair if present
    let linkedRepair = null;
    if (completionInfo?.linked_repair_id) {
      const repair = repairs.find(r => r.repair_id === completionInfo.linked_repair_id);
      if (repair) {
        const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
        linkedRepair = {
          repair_id: repair.repair_id,
          event_id: repair.event_id,
          job_no: event?.job_no || 'Unknown',
          narrative: repair.narrative,
        };
      }
    }

    return {
      asset_id: assetId,
      serno: asset?.serno || 'Unknown',
      partno: asset?.partno || 'Unknown',
      name: asset?.name || 'Unknown Asset',
      status_cd: asset?.status_cd || 'Unknown',
      admin_loc: asset?.admin_loc || 'Unknown',
      cust_loc: asset?.cust_loc || 'Unknown',
      is_compliant: isCompliant,
      compliance_status: isCompliant ? 'Compliant' : 'Non-Compliant',
      completion_date: completionInfo?.completion_date || null,
      linked_repair_id: completionInfo?.linked_repair_id || null,
      linked_repair: linkedRepair,
      completed_by: completionInfo?.completed_by_name || null,
      completed_at: completionInfo?.completed_at || null,
    };
  });

  const responseData = {
    tcto: {
      ...tcto,
      days_until_deadline: daysUntilDeadline,
      compliance_percentage: compliancePercentage,
      assets_remaining: tcto.affected_assets.length - tcto.compliant_assets.length,
      is_overdue: daysUntilDeadline < 0 && tcto.status === 'open',
      program_code: program?.pgm_cd || '',
      program_name: program?.pgm_name || '',
    },
    assets: affectedAssetsDetails,
    summary: {
      total_affected: tcto.affected_assets.length,
      compliant: tcto.compliant_assets.length,
      non_compliant: tcto.affected_assets.length - tcto.compliant_assets.length,
      compliance_percentage: compliancePercentage,
    },
  };

  console.log(`[TCTO] Detail request for ${tcto.tcto_no} (ID: ${tcto.tcto_id}) by ${user.username}`);

  res.json(responseData);
});

// POST /api/tcto/:id/compliance - Update asset compliance status for a TCTO
app.post('/api/tcto/:id/compliance', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can update compliance
  if (!['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to update TCTO compliance' });
  }

  const tctoId = parseInt(req.params.id, 10);
  if (isNaN(tctoId)) {
    return res.status(400).json({ error: 'Invalid TCTO ID' });
  }

  const { asset_id, is_compliant, completion_date, linked_repair_id } = req.body;

  if (typeof asset_id !== 'number') {
    return res.status(400).json({ error: 'Asset ID is required' });
  }

  if (typeof is_compliant !== 'boolean') {
    return res.status(400).json({ error: 'Compliance status (is_compliant) is required' });
  }

  // If marking compliant, completion_date is required
  if (is_compliant && !completion_date) {
    return res.status(400).json({ error: 'Completion date is required when marking an asset as compliant' });
  }

  // Validate linked_repair_id if provided
  if (linked_repair_id !== undefined && linked_repair_id !== null && typeof linked_repair_id !== 'number') {
    return res.status(400).json({ error: 'Invalid linked repair ID' });
  }

  // Find the TCTO record
  const tctoIndex = tctoRecords.findIndex(t => t.tcto_id === tctoId);
  if (tctoIndex === -1) {
    return res.status(404).json({ error: 'TCTO not found' });
  }

  const tcto = tctoRecords[tctoIndex];

  // Verify user has access to the TCTO's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(tcto.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this TCTO' });
  }

  // Verify the asset is in the affected_assets list
  if (!tcto.affected_assets.includes(asset_id)) {
    return res.status(400).json({ error: 'Asset is not in the affected assets list for this TCTO' });
  }

  // Update compliance status
  const asset = mockAssets.find(a => a.asset_id === asset_id);
  let completionData: TCTOAssetCompletionData | undefined;

  if (is_compliant) {
    // Add to compliant list if not already there
    if (!tcto.compliant_assets.includes(asset_id)) {
      tcto.compliant_assets.push(asset_id);
    }

    // Store completion data
    completionData = {
      asset_id,
      completion_date: completion_date,
      linked_repair_id: linked_repair_id || undefined,
      completed_by_id: user.user_id,
      completed_by_name: user.full_name,
      completed_at: new Date().toISOString(),
    };

    // Initialize or update completion data array for this TCTO
    if (!tctoAssetCompletionData.has(tctoId)) {
      tctoAssetCompletionData.set(tctoId, []);
    }
    const completionArray = tctoAssetCompletionData.get(tctoId)!;
    const existingIndex = completionArray.findIndex(c => c.asset_id === asset_id);
    if (existingIndex !== -1) {
      completionArray[existingIndex] = completionData;
    } else {
      completionArray.push(completionData);
    }

    console.log(`[TCTO] Asset ${asset?.serno || asset_id} marked COMPLIANT for ${tcto.tcto_no} by ${user.username} (completion date: ${completion_date}${linked_repair_id ? `, linked repair: ${linked_repair_id}` : ''})`);
  } else {
    // Remove from compliant list if present
    const compliantIndex = tcto.compliant_assets.indexOf(asset_id);
    if (compliantIndex !== -1) {
      tcto.compliant_assets.splice(compliantIndex, 1);
    }

    // Remove completion data
    if (tctoAssetCompletionData.has(tctoId)) {
      const completionArray = tctoAssetCompletionData.get(tctoId)!;
      const existingIndex = completionArray.findIndex(c => c.asset_id === asset_id);
      if (existingIndex !== -1) {
        completionArray.splice(existingIndex, 1);
      }
    }

    console.log(`[TCTO] Asset ${asset?.serno || asset_id} marked NON-COMPLIANT for ${tcto.tcto_no} by ${user.username}`);
  }

  // Calculate updated compliance info
  const compliancePercentage = tcto.affected_assets.length > 0
    ? Math.round((tcto.compliant_assets.length / tcto.affected_assets.length) * 100)
    : 100;

  // Look up linked repair if provided
  let linkedRepair = null;
  if (linked_repair_id) {
    // Search through all events to find the repair
    for (const event of maintenanceEvents) {
      const repair = event.repairs.find(r => r.repair_id === linked_repair_id);
      if (repair) {
        linkedRepair = {
          repair_id: repair.repair_id,
          event_id: event.event_id,
          job_no: event.job_no,
          narrative: repair.narrative,
        };
        break;
      }
    }
  }

  res.json({
    message: `Asset ${asset?.serno || asset_id} ${is_compliant ? 'marked compliant' : 'marked non-compliant'} for ${tcto.tcto_no}`,
    asset: {
      asset_id: asset_id,
      serno: asset?.serno || 'Unknown',
      name: asset?.name || 'Unknown',
      is_compliant: is_compliant,
      completion_date: is_compliant ? completion_date : null,
      linked_repair_id: is_compliant ? linked_repair_id : null,
      linked_repair: linkedRepair,
      completed_by: is_compliant ? user.full_name : null,
      completed_at: is_compliant ? completionData?.completed_at : null,
    },
    tcto_summary: {
      total_affected: tcto.affected_assets.length,
      compliant: tcto.compliant_assets.length,
      non_compliant: tcto.affected_assets.length - tcto.compliant_assets.length,
      compliance_percentage: compliancePercentage,
    },
  });
});

// GET /api/tcto/:id/assets/:assetId/repairs - Get repairs for an asset to link to TCTO completion
app.get('/api/tcto/:id/assets/:assetId/repairs', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const tctoId = parseInt(req.params.id, 10);
  const assetId = parseInt(req.params.assetId, 10);

  if (isNaN(tctoId)) {
    return res.status(400).json({ error: 'Invalid TCTO ID' });
  }
  if (isNaN(assetId)) {
    return res.status(400).json({ error: 'Invalid asset ID' });
  }

  // Find the TCTO record
  const tcto = tctoRecords.find(t => t.tcto_id === tctoId);
  if (!tcto) {
    return res.status(404).json({ error: 'TCTO not found' });
  }

  // Verify user has access to the TCTO's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(tcto.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this TCTO' });
  }

  // Find the asset
  const asset = mockAssets.find(a => a.asset_id === assetId);
  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Find maintenance events for this asset
  const assetEvents = maintenanceEvents.filter(e => e.asset_id === assetId);

  // Get all repairs for these events
  const assetRepairs: Array<{
    repair_id: number;
    event_id: number;
    job_no: string;
    repair_seq: number;
    type_maint: string | null;
    narrative: string | null;
    start_date: string;
    stop_date: string | null;
    shop_status: string;
  }> = [];

  assetEvents.forEach(event => {
    event.repairs.forEach(repair => {
      assetRepairs.push({
        repair_id: repair.repair_id,
        event_id: event.event_id,
        job_no: event.job_no,
        repair_seq: repair.repair_seq,
        type_maint: repair.type_maint,
        narrative: repair.narrative,
        start_date: repair.start_date,
        stop_date: repair.stop_date,
        shop_status: repair.shop_status,
      });
    });
  });

  // Sort by most recent first
  assetRepairs.sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime());

  console.log(`[TCTO] Repairs for asset ${asset.serno} (ID: ${assetId}) requested by ${user.username} - ${assetRepairs.length} repairs found`);

  res.json({
    asset_id: assetId,
    serno: asset.serno,
    repairs: assetRepairs,
    total: assetRepairs.length,
  });
});

// Mock Sortie data
interface Sortie {
  sortie_id: number;
  pgm_id: number;
  asset_id: number;
  mission_id: string;
  serno: string;
  ac_tailno: string | null;
  sortie_date: string;
  sortie_effect: string | null;
  current_unit: string | null;
  assigned_unit: string | null;
  range: string | null;
  reason: string | null;
  remarks: string | null;
}

// Persistent storage for sorties
let sorties: Sortie[] = [];

// Initialize sortie data
function initializeSorties(): void {
  const today = new Date();
  const addDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  };

  sorties = [
    // CRIIS program sorties
    {
      sortie_id: 1,
      pgm_id: 1,
      asset_id: 1,
      mission_id: 'CRIIS-SORTIE-001',
      serno: 'CRIIS-001',
      ac_tailno: 'AC-001',
      sortie_date: addDays(-5),
      sortie_effect: 'Fully Mission Capable',
      current_unit: 'Unit Alpha',
      assigned_unit: 'Unit Alpha',
      range: 'Range A',
      reason: 'Operational deployment',
      remarks: 'Successful reconnaissance mission',
    },
    {
      sortie_id: 2,
      pgm_id: 1,
      asset_id: 5,
      mission_id: 'CRIIS-SORTIE-002',
      serno: 'CRIIS-005',
      ac_tailno: 'AC-005',
      sortie_date: addDays(-3),
      sortie_effect: 'Partially Mission Capable',
      current_unit: 'Unit Bravo',
      assigned_unit: 'Unit Alpha',
      range: 'Range B',
      reason: 'Training exercise',
      remarks: 'Camera system showed intermittent issues',
    },
    {
      sortie_id: 3,
      pgm_id: 1,
      asset_id: 6,
      mission_id: 'CRIIS-SORTIE-003',
      serno: 'CRIIS-006',
      ac_tailno: 'AC-006',
      sortie_date: addDays(-10),
      sortie_effect: 'Non-Mission Capable',
      current_unit: 'Unit Alpha',
      assigned_unit: 'Unit Alpha',
      range: 'Range A',
      reason: 'Maintenance check flight',
      remarks: 'Power supply failure detected during flight',
    },
    {
      sortie_id: 4,
      pgm_id: 1,
      asset_id: 3,
      mission_id: 'CRIIS-SORTIE-004',
      serno: 'CRIIS-003',
      ac_tailno: 'AC-003',
      sortie_date: addDays(-2),
      sortie_effect: 'Fully Mission Capable',
      current_unit: 'Unit Charlie',
      assigned_unit: 'Unit Charlie',
      range: 'Range C',
      reason: 'Surveillance mission',
      remarks: 'All systems operational',
    },
    // ACTS program sorties
    {
      sortie_id: 5,
      pgm_id: 2,
      asset_id: 13,
      mission_id: 'ACTS-SORTIE-001',
      serno: 'ACTS-001',
      ac_tailno: 'AC-101',
      sortie_date: addDays(-4),
      sortie_effect: 'Partially Mission Capable',
      current_unit: 'Unit Delta',
      assigned_unit: 'Unit Delta',
      range: 'Range D',
      reason: 'Target acquisition training',
      remarks: 'Laser designator alignment issue noted',
    },
    {
      sortie_id: 6,
      pgm_id: 2,
      asset_id: 14,
      mission_id: 'ACTS-SORTIE-002',
      serno: 'ACTS-002',
      ac_tailno: 'AC-102',
      sortie_date: addDays(-6),
      sortie_effect: 'Fully Mission Capable',
      current_unit: 'Unit Echo',
      assigned_unit: 'Unit Echo',
      range: 'Range E',
      reason: 'Certification flight',
      remarks: 'All targeting subsystems passed certification',
    },
    // ARDS program sorties
    {
      sortie_id: 7,
      pgm_id: 3,
      asset_id: 17,
      mission_id: 'ARDS-SORTIE-001',
      serno: 'ARDS-001',
      ac_tailno: 'AC-201',
      sortie_date: addDays(-8),
      sortie_effect: 'Non-Mission Capable',
      current_unit: 'Unit Foxtrot',
      assigned_unit: 'Unit Foxtrot',
      range: 'Range F',
      reason: 'Data collection mission',
      remarks: 'Overheating issue during high-altitude operation',
    },
    // 236 program sorties
    {
      sortie_id: 8,
      pgm_id: 4,
      asset_id: 23,
      mission_id: '236-SORTIE-001',
      serno: '236-001',
      ac_tailno: 'AC-301',
      sortie_date: addDays(-4),
      sortie_effect: 'Fully Mission Capable',
      current_unit: 'Unit Golf',
      assigned_unit: 'Unit Golf',
      range: 'Range G',
      reason: 'Classified operation',
      remarks: 'Classified - refer to secure documentation',
    },
  ];
}

// Initialize sorties on startup
initializeSorties();

// TCTO (Time Compliance Technical Order) Interface
interface TCTORecord {
  tcto_id: number;
  tcto_no: string;        // TCTO number (unique per program)
  title: string;          // TCTO title/description
  effective_date: string; // Date TCTO became effective
  compliance_deadline: string; // Deadline for compliance
  pgm_id: number;
  status: 'open' | 'closed'; // Overall TCTO status
  priority: 'Routine' | 'Urgent' | 'Critical';
  affected_assets: number[]; // Array of asset_ids that need compliance
  compliant_assets: number[]; // Array of asset_ids that are compliant
  description: string;    // Full TCTO description
  created_by_id: number;
  created_by_name: string;
  created_at: string;
}

// Asset completion data for TCTO compliance
interface TCTOAssetCompletionData {
  asset_id: number;
  completion_date: string;
  linked_repair_id?: number;
  completed_by_id: number;
  completed_by_name: string;
  completed_at: string;
}

// Storage for asset completion data (keyed by tcto_id)
const tctoAssetCompletionData: Map<number, TCTOAssetCompletionData[]> = new Map();

// Persistent storage for TCTO records
let tctoRecords: TCTORecord[] = [];
let tctoNextId = 6; // Start after mock data IDs

// Initialize TCTO data - async to query real asset IDs from database
async function initializeTCTOData(): Promise<void> {
  try {
    const today = new Date();
    const addDays = (days: number): string => {
      const date = new Date(today);
      date.setDate(date.getDate() + days);
      return date.toISOString().split('T')[0];
    };

    // Query real asset IDs from the database for each program
    // CRIIS = pgm_id 1, ACTS = pgm_id 2, ARDS = pgm_id 3

    // Get assets for CRIIS (program 1)
    const criisAssets = await prisma.asset.findMany({
      where: {
        part: {
          pgm_id: 1
        }
      },
      select: { asset_id: true },
      take: 10,
      orderBy: { asset_id: 'asc' }
    });

    // Get assets for ACTS (program 2) - spread across admin's key locations
    // Pull assets from Shaw (41), Langley (24), Hill (46), Luke (50) so TCTOs show at each base
    const actsAssets = await prisma.asset.findMany({
      where: {
        part: { pgm_id: 2 },
        loc_ida: { in: [41, 24, 46, 50] }
      },
      select: { asset_id: true, loc_ida: true },
      take: 20,
      orderBy: { asset_id: 'asc' }
    });

    // Get assets for ARDS (program 3)
    const ardsAssets = await prisma.asset.findMany({
      where: {
        part: {
          pgm_id: 3
        }
      },
      select: { asset_id: true },
      take: 5,
      orderBy: { asset_id: 'asc' }
    });

    // Extract asset IDs (use empty arrays if no assets found)
    const criisIds = criisAssets.map(a => a.asset_id);
    const actsIds = actsAssets.map(a => a.asset_id);
    const ardsIds = ardsAssets.map(a => a.asset_id);

    console.log(`[TCTO] Initializing with real asset IDs - CRIIS: ${criisIds.length}, ACTS: ${actsIds.length}, ARDS: ${ardsIds.length}`);

    // Only create TCTO records for programs that have assets
    const records: TCTORecord[] = [];
    let nextId = 1;

    // CRIIS program TCTOs (only if CRIIS has assets)
    if (criisIds.length >= 3) {
      records.push({
        tcto_id: nextId++,
        tcto_no: 'TCTO-2024-001',
        title: 'Sensor Firmware Update v2.3.1',
        effective_date: addDays(-30),
        compliance_deadline: addDays(15),
        pgm_id: 1,
        status: 'open',
        priority: 'Urgent',
        affected_assets: criisIds.slice(0, 3), // First 3 CRIIS assets
        compliant_assets: [criisIds[0]], // First asset is compliant
        description: 'Critical firmware update addressing sensor calibration drift issue. All affected sensor units must be updated before deadline.',
        created_by_id: 1,
        created_by_name: 'John Admin',
        created_at: addDays(-30),
      });
    }

    if (criisIds.length >= 6) {
      records.push({
        tcto_id: nextId++,
        tcto_no: 'TCTO-2024-002',
        title: 'Communication System Software Patch',
        effective_date: addDays(-45),
        compliance_deadline: addDays(-5), // Overdue
        pgm_id: 1,
        status: 'open',
        priority: 'Critical',
        affected_assets: criisIds.slice(3, 6), // Assets 4-6
        compliant_assets: [], // None compliant yet
        description: 'Mandatory software patch to address communication security vulnerability CVE-2024-1234.',
        created_by_id: 1,
        created_by_name: 'John Admin',
        created_at: addDays(-45),
      });
    }

    if (criisIds.length >= 8) {
      records.push({
        tcto_id: nextId++,
        tcto_no: 'TCTO-2024-003',
        title: 'Radar Unit Calibration Procedure Update',
        effective_date: addDays(-60),
        compliance_deadline: addDays(-30),
        pgm_id: 1,
        status: 'closed',
        priority: 'Routine',
        affected_assets: criisIds.slice(6, 8), // Assets 7-8
        compliant_assets: criisIds.slice(6, 8), // All compliant
        description: 'Updated calibration procedure for improved accuracy in high-altitude operations.',
        created_by_id: 1,
        created_by_name: 'John Admin',
        created_at: addDays(-60),
      });
    }

    // ACTS program TCTOs - spread across admin's key locations
    // Group ACTS assets by location for better TCTO coverage
    const actsAtShaw = actsAssets.filter(a => a.loc_ida === 41).map(a => a.asset_id);
    const actsAtLangley = actsAssets.filter(a => a.loc_ida === 24).map(a => a.asset_id);
    const actsAtHill = actsAssets.filter(a => a.loc_ida === 46).map(a => a.asset_id);
    const actsAtLuke = actsAssets.filter(a => a.loc_ida === 50).map(a => a.asset_id);

    if (actsIds.length >= 3) {
      // TCTO affecting Shaw and Langley
      records.push({
        tcto_id: nextId++,
        tcto_no: 'TCTO-2024-004',
        title: 'Targeting System Optics Alignment',
        effective_date: addDays(-20),
        compliance_deadline: addDays(30),
        pgm_id: 2,
        status: 'open',
        priority: 'Urgent',
        affected_assets: [...actsAtShaw.slice(0, 3), ...actsAtLangley.slice(0, 3)],
        compliant_assets: [actsAtShaw[0], actsAtLangley[0]].filter(Boolean),
        description: 'Realignment procedure for targeting optics to correct parallax error identified in field reports.',
        created_by_id: 2,
        created_by_name: 'Jane Depot',
        created_at: addDays(-20),
      });

      // TCTO affecting Hill and Luke
      records.push({
        tcto_id: nextId++,
        tcto_no: 'TCTO-2024-006',
        title: 'Power Supply Module Retrofit',
        effective_date: addDays(-45),
        compliance_deadline: addDays(10),
        pgm_id: 2,
        status: 'open',
        priority: 'Critical',
        affected_assets: [...actsAtHill.slice(0, 4), ...actsAtLuke.slice(0, 4)],
        compliant_assets: [actsAtHill[0]].filter(Boolean),
        description: 'Replace legacy power supply modules with updated units to address thermal runaway risk. Immediate compliance required.',
        created_by_id: 1,
        created_by_name: 'John Admin',
        created_at: addDays(-45),
      });

      // Closed TCTO affecting all locations
      records.push({
        tcto_id: nextId++,
        tcto_no: 'TCTO-2024-007',
        title: 'Software Security Patch v4.1.2',
        effective_date: addDays(-90),
        compliance_deadline: addDays(-30),
        pgm_id: 2,
        status: 'closed',
        priority: 'Routine',
        affected_assets: [...actsAtShaw.slice(0, 2), ...actsAtLangley.slice(0, 2), ...actsAtHill.slice(0, 2), ...actsAtLuke.slice(0, 2)],
        compliant_assets: [...actsAtShaw.slice(0, 2), ...actsAtLangley.slice(0, 2), ...actsAtHill.slice(0, 2), ...actsAtLuke.slice(0, 2)],
        description: 'Applied security patch to address CVE-2024-3891 vulnerability in targeting system firmware.',
        created_by_id: 1,
        created_by_name: 'John Admin',
        created_at: addDays(-90),
      });
    }

    // ARDS program TCTOs (only if ARDS has assets)
    if (ardsIds.length >= 3) {
      records.push({
        tcto_id: nextId++,
        tcto_no: 'TCTO-2024-005',
        title: 'Data Processing Unit Memory Upgrade',
        effective_date: addDays(-10),
        compliance_deadline: addDays(60),
        pgm_id: 3,
        status: 'open',
        priority: 'Routine',
        affected_assets: ardsIds.slice(0, 3), // First 3 ARDS assets
        compliant_assets: [],
        description: 'Memory module replacement to support new data processing algorithms in software update 3.0.',
        created_by_id: 2,
        created_by_name: 'Jane Depot',
        created_at: addDays(-10),
      });
    }

    tctoRecords = records;
    tctoNextId = nextId;

    // Initialize completion data for TCTOs with real asset IDs
    // For TCTO-2024-001 (first CRIIS TCTO): mark first 3 assets as compliant
    if (criisIds.length >= 3 && tctoRecords.length > 0) {
      const tcto1 = tctoRecords.find(t => t.tcto_no === 'TCTO-2024-001');
      if (tcto1) {
        tctoAssetCompletionData.set(tcto1.tcto_id, [
          {
            asset_id: criisIds[0],
            is_compliant: true,
            completion_date: addDays(-1),
            linked_repair_id: undefined,
            completed_by: 'John Admin',
            completed_at: addDays(-1),
          },
          {
            asset_id: criisIds[1],
            is_compliant: true,
            completion_date: addDays(-1),
            linked_repair_id: undefined,
            completed_by: 'Bob Field',
            completed_at: addDays(-1),
          },
          {
            asset_id: criisIds[2],
            is_compliant: true,
            completion_date: addDays(-1),
            linked_repair_id: undefined,
            completed_by: 'Jane Depot',
            completed_at: addDays(-1),
          },
        ]);
        // Update compliant_assets to match completion data
        tcto1.compliant_assets = criisIds.slice(0, 3);
      }
    }

    // For TCTO-2024-003 (closed CRIIS TCTO): all assets compliant
    if (criisIds.length >= 8) {
      const tcto3 = tctoRecords.find(t => t.tcto_no === 'TCTO-2024-003');
      if (tcto3) {
        tctoAssetCompletionData.set(tcto3.tcto_id, [
          {
            asset_id: criisIds[6],
            is_compliant: true,
            completion_date: addDays(-30),
            linked_repair_id: undefined,
            completed_by: 'Jane Depot',
            completed_at: addDays(-30),
          },
          {
            asset_id: criisIds[7],
            is_compliant: true,
            completion_date: addDays(-30),
            linked_repair_id: undefined,
            completed_by: 'Jane Depot',
            completed_at: addDays(-30),
          },
        ]);
      }
    }

    console.log(`[TCTO] Initialized ${tctoRecords.length} TCTO records with real asset IDs`);
  } catch (error) {
    // Silently fail - server will continue running with empty TCTO data
    console.log('Failed to init TCTO data');
    // Fall back to empty records
    tctoRecords = [];
  }
}

// Initialize TCTO data on startup (async - will complete after server starts)
// This initialization is non-blocking and errors will not crash the server
initializeTCTOData().catch(err => {
  console.error('[TCTO] Initialization failed:', err);
  console.error('[TCTO] Server will continue running with empty TCTO data');
});

// Mock Maintenance Events data
interface MaintenanceEvent {
  event_id: number;
  asset_id: number;
  asset_sn: string;
  asset_name: string;
  job_no: string;
  discrepancy: string;
  start_job: string;
  stop_job: string | null;
  event_type: 'Standard' | 'PMI' | 'TCTO' | 'BIT/PC';
  priority: 'Routine' | 'Urgent' | 'Critical';
  status: 'open' | 'closed';
  pgm_id: number;
  location: string;
  loc_id: number; // Location ID where maintenance is performed
  etic?: string | null; // Estimated Time In Commission
  sortie_id?: number | null; // Associated sortie (optional)
  pqdr?: boolean; // Product Quality Deficiency Report flag
  created_by_id?: number;
  created_by_name?: string;
  // Progress tracking fields (calculated from repairs)
  total_repairs?: number; // Total number of repairs for this event
  closed_repairs?: number; // Number of closed repairs
  progress_percentage?: number; // Completion percentage (0-100)
  created_at?: string;
}

// Persistent storage for maintenance events (initialized with mock data)
let maintenanceEvents: MaintenanceEvent[] = [];
let maintenanceEventNextId = 11; // Start after mock data IDs
let maintenanceJobNextSeq = 11; // Start after mock job numbers (MX-2024-010)

// Location-based job number tracking
// Key: location string, Value: next sequence number for that location
const locationJobSeqMap: Map<string, number> = new Map();

// Map location display names to location IDs (for maintenance events)
const maintenanceLocationNameToId: Record<string, number> = {
  'Depot Alpha': 154,
  'Depot Beta': 437,
  'Field Site Bravo': 394,
  'Field Site Charlie': 212,
  'Field Site Delta': 663,
  'Secure Facility': 154,
};

// Initialize maintenance events on startup
function initializeMaintenanceEvents(): void {
  // Stub — will be replaced by async DB load in initializeMaintenanceEventsFromDb
  console.log('[MAINTENANCE] Skipping sync init — DB init will populate');
}

// Map DB event_type to MaintenanceEvent event_type
function mapEventType(dbType: string | null): 'Standard' | 'PMI' | 'TCTO' | 'BIT/PC' {
  switch (dbType) {
    case 'PM': return 'PMI';
    case 'CM': return 'Standard';
    case 'INS': return 'Standard';
    default: return 'Standard';
  }
}

async function initializeMaintenanceEventsFromDb(): Promise<void> {
  try {
    const dbEvents = await prisma.event.findMany({
      include: {
        asset: {
          include: {
            part: true,
            assignedLocation: true,
          },
        },
        location: true,
      },
      orderBy: { event_id: 'desc' },
    });

    maintenanceEvents = dbEvents.map(e => ({
      event_id: e.event_id,
      asset_id: e.asset_id,
      asset_sn: e.asset?.serno ?? '',
      asset_name: e.asset?.part?.noun ?? '',
      job_no: e.job_no ?? `EVT-${e.event_id}`,
      discrepancy: e.discrepancy ?? '',
      start_job: e.start_job ? new Date(e.start_job).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      stop_job: e.stop_job ? new Date(e.stop_job).toISOString().split('T')[0] : null,
      event_type: mapEventType(e.event_type),
      priority: (e.priority as 'Critical' | 'Urgent' | 'Routine') ?? 'Routine',
      status: e.stop_job ? 'closed' as const : 'open' as const,
      pgm_id: e.asset?.part?.pgm_id ?? 0,
      location: e.location?.display_name ?? e.asset?.assignedLocation?.display_name ?? 'Unknown',
      loc_id: e.loc_id ?? e.asset?.loc_ida ?? 0,
      etic: e.etic_date ? new Date(e.etic_date).toISOString().split('T')[0] : null,
      sortie_id: e.sortie_id ?? null,
      pqdr: false,
      created_by_id: undefined,
      created_by_name: e.ins_by ?? undefined,
      created_at: e.ins_date ? new Date(e.ins_date).toISOString() : undefined,
    }));

    // Update next IDs
    if (maintenanceEvents.length > 0) {
      maintenanceEventNextId = Math.max(...maintenanceEvents.map(e => e.event_id)) + 1;
    }

    console.log(`[MAINTENANCE] Loaded ${maintenanceEvents.length} events from database (${maintenanceEvents.filter(e => e.status === 'open').length} open)`);
  } catch (error) {
    console.error('[MAINTENANCE] Failed to load events from DB:', error);
  }
}

// Initialize maintenance events on server start
initializeMaintenanceEvents();

// Initialize location job sequence tracking based on existing events
// This ensures new job numbers don't conflict with existing ones
function initializeLocationJobSeqMap(): void {
  // Group existing events by location and find the highest sequence per location
  maintenanceEvents.forEach(event => {
    const currentMax = locationJobSeqMap.get(event.location) || 0;
    // Try to parse the sequence from the job number
    // Format: MX-{PREFIX}-{YEAR}-{SEQ} or legacy MX-{YEAR}-{SEQ}
    const parts = event.job_no.split('-');
    if (parts.length >= 2) {
      const seqStr = parts[parts.length - 1]; // Last part is always the sequence
      const seq = parseInt(seqStr, 10);
      if (!isNaN(seq) && seq > currentMax) {
        locationJobSeqMap.set(event.location, seq);
      }
    }
  });

  // Increment each location's sequence so new events start after existing ones
  locationJobSeqMap.forEach((seq, location) => {
    locationJobSeqMap.set(location, seq + 1);
  });

  console.log('[EVENTS] Location job sequence map initialized:', Object.fromEntries(locationJobSeqMap));
}
initializeLocationJobSeqMap();

// Repair interface for maintenance event repairs
interface Repair {
  repair_id: number;
  event_id: number;
  repair_seq: number;
  asset_id: number;
  start_date: string;
  stop_date: string | null;
  type_maint: string; // 'Corrective' | 'Preventive' | 'Modification' | 'Inspection'
  how_mal: string | null; // How Malfunctioned code
  when_disc: string | null; // When Discovered code
  action_taken: string | null; // Action Taken code (T = cannibalization, R = repair, etc.)
  shop_status: 'open' | 'closed';
  narrative: string;
  tag_no: string | null;
  doc_no: string | null;
  micap: boolean; // Mission Capable impacting flag
  micap_login: string | null; // User who flagged as MICAP
  chief_review: boolean; // Flagged for chief review
  chief_review_by: string | null; // User who flagged for chief review
  super_review: boolean; // Flagged for supervisor review
  super_review_by: string | null; // User who flagged for supervisor review
  repeat_recur: boolean; // Flagged as repeat/recurring issue
  repeat_recur_by: string | null; // User who flagged as repeat/recur
  // Cannibalization (Action T) fields
  donor_asset_id: number | null; // ID of asset being cannibalized from
  donor_asset_sn: string | null; // Serial number of donor asset
  donor_asset_pn: string | null; // Part number of donor asset
  donor_asset_name: string | null; // Name of donor asset
  // ETI (Elapsed Time Indicator) tracking
  eti_in: number | null; // ETI meter value at repair start
  eti_out: number | null; // ETI meter value at repair end
  eti_delta: number | null; // Calculated difference (eti_out - eti_in)
  meter_changed: boolean; // Flag indicating physical meter was replaced
  created_by_name: string;
  created_at: string;
}

// Persistent storage for repairs
let repairs: Repair[] = [];
let repairNextId = 20; // Start after mock data IDs

// Initialize repairs with mock data
function initializeRepairs(): void {
  const today = new Date();
  const addDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  };

  repairs = [
    // Repairs for Event 1 (MX-2024-001 - Power failure) - 2 repairs, 1 open
    {
      repair_id: 1,
      event_id: 1,
      repair_seq: 1,
      asset_id: 5,
      start_date: addDays(-5),
      stop_date: addDays(-4),
      type_maint: 'Corrective',
      how_mal: 'PWR',
      when_disc: 'BIT',
      action_taken: 'R', // Regular repair
      shop_status: 'closed',
      narrative: 'Replaced faulty power supply connector. Tested - intermittent fault no longer present.',
      tag_no: 'TAG-001',
      doc_no: 'DOC-2024-001',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 780.5,
      eti_out: 782.0,
      eti_delta: 1.5,
      meter_changed: false,
      created_by_name: 'Bob Field',
      created_at: addDays(-5),
    },
    {
      repair_id: 2,
      event_id: 1,
      repair_seq: 2,
      asset_id: 5,
      start_date: addDays(-3),
      stop_date: null,
      type_maint: 'Corrective',
      how_mal: 'PWR',
      when_disc: 'OPS',
      action_taken: null,
      shop_status: 'open',
      narrative: 'Additional power fault found. Investigating main circuit board.',
      tag_no: 'TAG-002',
      doc_no: null,
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: true, // This repair is flagged as repeat/recur
      repeat_recur_by: 'bob_field',
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 782.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'Bob Field',
      created_at: addDays(-3),
    },
    // Repairs for Event 2 (MX-2024-002 - Radar) - 1 open repair
    {
      repair_id: 3,
      event_id: 2,
      repair_seq: 1,
      asset_id: 6,
      start_date: addDays(-10),
      stop_date: null,
      type_maint: 'Corrective',
      how_mal: 'FAIL',
      when_disc: 'OPS',
      action_taken: null,
      shop_status: 'open',
      narrative: 'Power supply module failed. Awaiting replacement part PN-PSU-001.',
      tag_no: 'TAG-003',
      doc_no: 'DOC-2024-002',
      micap: true, // This repair is flagged as MICAP
      micap_login: 'jane_depot',
      chief_review: false,
      chief_review_by: null,
      super_review: true, // This repair is flagged for supervisor review
      super_review_by: 'jane_depot',
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 1500.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'Jane Depot',
      created_at: addDays(-10),
    },
    // Repairs for Event 3 (MX-2024-003 - PMI) - 1 open repair
    {
      repair_id: 4,
      event_id: 3,
      repair_seq: 1,
      asset_id: 3,
      start_date: addDays(-2),
      stop_date: null,
      type_maint: 'Preventive',
      how_mal: null,
      when_disc: 'PMI',
      action_taken: null,
      shop_status: 'open',
      narrative: '90-day calibration in progress. Sensor alignment adjustments underway.',
      tag_no: 'TAG-004',
      doc_no: 'DOC-2024-003',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 2100.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'Bob Field',
      created_at: addDays(-2),
    },
    // Repairs for Event 4 (MX-2024-004 - TCTO) - 1 open repair
    {
      repair_id: 5,
      event_id: 4,
      repair_seq: 1,
      asset_id: 8,
      start_date: addDays(-1),
      stop_date: null,
      type_maint: 'Modification',
      how_mal: null,
      when_disc: 'TCTO',
      action_taken: null,
      shop_status: 'open',
      narrative: 'Applying software update per TCTO 2024-15. Download and install in progress.',
      tag_no: 'TAG-005',
      doc_no: 'DOC-2024-004',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 550.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'Bob Field',
      created_at: addDays(-1),
    },
    // Repairs for Event 5 (ACTS) - 1 open repair
    {
      repair_id: 6,
      event_id: 5,
      repair_seq: 1,
      asset_id: 13,
      start_date: addDays(-3),
      stop_date: null,
      type_maint: 'Corrective',
      how_mal: 'OPTIC',
      when_disc: 'BIT',
      action_taken: null,
      shop_status: 'open',
      narrative: 'Optical sensor cleaning and realignment in progress.',
      tag_no: 'TAG-006',
      doc_no: 'DOC-2024-005',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 1200.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'Jane Depot',
      created_at: addDays(-3),
    },
    // Repairs for Event 6 (ACTS) - 1 open repair
    {
      repair_id: 7,
      event_id: 6,
      repair_seq: 1,
      asset_id: 14,
      start_date: addDays(-5),
      stop_date: null,
      type_maint: 'Inspection',
      how_mal: null,
      when_disc: 'PMI',
      action_taken: null,
      shop_status: 'open',
      narrative: 'Full system inspection underway. Checking all targeting subsystems.',
      tag_no: 'TAG-007',
      doc_no: 'DOC-2024-006',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 890.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'Jane Depot',
      created_at: addDays(-5),
    },
    // Repairs for Event 7 (ARDS) - 1 open repair
    {
      repair_id: 8,
      event_id: 7,
      repair_seq: 1,
      asset_id: 17,
      start_date: addDays(-7),
      stop_date: null,
      type_maint: 'Corrective',
      how_mal: 'OVHT',
      when_disc: 'OPS',
      action_taken: null,
      shop_status: 'open',
      narrative: 'Thermal paste reapplication and cooling fan inspection.',
      tag_no: 'TAG-008',
      doc_no: 'DOC-2024-007',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 620.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'Bob Field',
      created_at: addDays(-7),
    },
    // Repairs for Event 8 (closed) - all closed
    {
      repair_id: 9,
      event_id: 8,
      repair_seq: 1,
      asset_id: 1,
      start_date: addDays(-15),
      stop_date: addDays(-13),
      type_maint: 'Preventive',
      how_mal: null,
      when_disc: 'PMI',
      action_taken: 'M', // Regular maintenance
      shop_status: 'closed',
      narrative: '30-day inspection completed. All systems nominal.',
      tag_no: 'TAG-009',
      doc_no: 'DOC-2024-008',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 1235.0,
      eti_out: 1238.5,
      eti_delta: 3.5,
      meter_changed: false,
      created_by_name: 'Bob Field',
      created_at: addDays(-15),
    },
    {
      repair_id: 10,
      event_id: 8,
      repair_seq: 2,
      asset_id: 1,
      start_date: addDays(-14),
      stop_date: addDays(-12),
      type_maint: 'Preventive',
      how_mal: null,
      when_disc: 'PMI',
      action_taken: 'L', // Lubrication
      shop_status: 'closed',
      narrative: 'Lubrication and cable inspection completed.',
      tag_no: 'TAG-010',
      doc_no: 'DOC-2024-009',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 1238.5,
      eti_out: 1240.0,
      eti_delta: 1.5,
      meter_changed: false,
      created_by_name: 'Bob Field',
      created_at: addDays(-14),
    },
    // Repairs for Event 9 (closed) - all closed
    {
      repair_id: 11,
      event_id: 9,
      repair_seq: 1,
      asset_id: 11,
      start_date: addDays(-20),
      stop_date: addDays(-18),
      type_maint: 'Preventive',
      how_mal: null,
      when_disc: 'PMI',
      action_taken: 'C', // Calibration
      shop_status: 'closed',
      narrative: 'Annual calibration completed successfully. All targets within spec.',
      tag_no: 'TAG-011',
      doc_no: 'DOC-2024-010',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 3450.0,
      eti_out: 3455.0,
      eti_delta: 5.0,
      meter_changed: false,
      created_by_name: 'Jane Depot',
      created_at: addDays(-20),
    },
    // Repairs for Event 10 (236 program) - 1 open repair
    {
      repair_id: 12,
      event_id: 10,
      repair_seq: 1,
      asset_id: 23,
      start_date: addDays(-4),
      stop_date: null,
      type_maint: 'Corrective',
      how_mal: 'COMP',
      when_disc: 'BIT',
      action_taken: null,
      shop_status: 'open',
      narrative: 'Classified component replacement required. Awaiting secure delivery.',
      tag_no: 'TAG-012',
      doc_no: 'DOC-2024-011',
      micap: false,
      micap_login: null,
      chief_review: false,
      chief_review_by: null,
      super_review: false,
      super_review_by: null,
      repeat_recur: false,
      repeat_recur_by: null,
      donor_asset_id: null,
      donor_asset_sn: null,
      donor_asset_pn: null,
      donor_asset_name: null,
      eti_in: 150.0,
      eti_out: null,
      eti_delta: null,
      meter_changed: false,
      created_by_name: 'John Admin',
      created_at: addDays(-4),
    },
  ];
}

// Initialize repairs on server start
initializeRepairs();

// InstalledPart interface for tracking parts installed during repairs
interface InstalledPart {
  installed_part_id: number;
  repair_id: number;
  event_id: number;
  asset_id: number; // The asset that was installed
  asset_sn: string; // Serial number of installed asset
  asset_pn: string; // Part number of installed asset
  asset_name: string; // Name of installed asset
  installation_date: string;
  installation_notes: string | null;
  previous_location: string | null; // Where the asset was before installation
  installed_by: number;
  installed_by_name: string;
  created_at: string;
}

// Persistent storage for installed parts
let installedParts: InstalledPart[] = [];
let installedPartNextId = 1;

// Initialize installed parts with mock data
function initializeInstalledParts(): void {
  // Example: Part installed in Repair #1 (closed repair)
  installedParts = [
    {
      installed_part_id: 1,
      repair_id: 1,
      event_id: 1,
      asset_id: 2, // Example asset
      asset_sn: 'CRIIS-002',
      asset_pn: 'PN-PWR-001',
      asset_name: 'Power Supply Unit',
      installation_date: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      installation_notes: 'Replaced faulty PSU connector with spare unit',
      previous_location: 'Depot Alpha',
      installed_by: 3,
      installed_by_name: 'Bob Field',
      created_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
  installedPartNextId = 2;
}

// Initialize installed parts on server start
initializeInstalledParts();

// RemovedPart interface for tracking parts removed during repairs
interface RemovedPart {
  removed_part_id: number;
  repair_id: number;
  event_id: number;
  asset_id: number; // The asset that was removed
  asset_sn: string; // Serial number of removed asset
  asset_pn: string; // Part number of removed asset
  asset_name: string; // Name of removed asset
  removal_date: string;
  removal_reason: string | null; // Reason for removal (failed, damaged, etc.)
  removal_notes: string | null;
  new_status: string | null; // What status the asset should be set to (NMCM, NMCS, etc.)
  removed_by: number;
  removed_by_name: string;
  created_at: string;
}

// Persistent storage for removed parts
let removedParts: RemovedPart[] = [];
let removedPartNextId = 1;

// Initialize removed parts with mock data
function initializeRemovedParts(): void {
  // Example: Part removed in Repair #1 (closed repair)
  removedParts = [
    {
      removed_part_id: 1,
      repair_id: 1,
      event_id: 1,
      asset_id: 3, // Example asset - CRIIS-003 Sensor Unit B
      asset_sn: 'CRIIS-003',
      asset_pn: 'PN-SENSOR-B',
      asset_name: 'Sensor Unit B',
      removal_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      removal_reason: 'FAILED',
      removal_notes: 'Faulty power connector caused sensor failure. Removed for depot repair.',
      new_status: 'NMCM',
      removed_by: 3,
      removed_by_name: 'Bob Field',
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
  removedPartNextId = 2;
}

// Initialize removed parts on server start
initializeRemovedParts();

// ============================================
// LABOR RECORDS
// ============================================

// Labor interface for tracking labor records within repairs
interface Labor {
  labor_id: number;
  repair_id: number;
  labor_seq: number;
  asset_id: number;
  action_taken: string | null; // Action taken code
  how_mal: string | null;
  when_disc: string | null;
  type_maint: string | null;
  cat_labor: string | null; // Category of labor code
  start_date: string;
  stop_date: string | null;
  hours: number | null;
  crew_chief: string | null;
  crew_size: number | null;
  corrective: string | null; // Corrective action narrative
  discrepancy: string | null; // Discrepancy description
  remarks: string | null;
  corrected_by: string | null;
  inspected_by: string | null;
  bit_log: string | null; // BIT (Built-In Test) log capture
  sent_imds: boolean;
  valid: boolean;
  created_by: number;
  created_by_name: string;
  created_at: string;
}

// Persistent storage for labor records
let laborRecords: Labor[] = [];
let laborNextId = 1;

// Initialize labor records with mock data
function initializeLaborRecords(): void {
  const today = new Date();
  const addDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  };

  laborRecords = [
    // Labor for Repair #1 (closed repair for Event 1)
    {
      labor_id: 1,
      repair_id: 1,
      labor_seq: 1,
      asset_id: 1,
      action_taken: 'R', // Repair
      how_mal: 'D', // Discovered by operator
      when_disc: 'OPS', // Operations
      type_maint: 'U', // Unscheduled
      cat_labor: 'R', // Repair
      start_date: addDays(-5),
      stop_date: addDays(-4),
      hours: 4.5,
      crew_chief: 'Bob Field',
      crew_size: 2,
      corrective: 'Replaced faulty power connector. Tested system functionality.',
      discrepancy: 'Power connector failed causing intermittent connection issues.',
      remarks: 'Used spare connector from inventory',
      corrected_by: 'Bob Field',
      inspected_by: 'Jane Depot',
      bit_log: null,
      sent_imds: false,
      valid: true,
      created_by: 3,
      created_by_name: 'Bob Field',
      created_at: addDays(-5),
    },
    // Labor for Repair #2 (open repair for Event 1)
    {
      labor_id: 2,
      repair_id: 2,
      labor_seq: 1,
      asset_id: 1,
      action_taken: 'I', // Inspect
      how_mal: 'PMI', // Periodic Maintenance
      when_disc: 'PMI', // PMI
      type_maint: 'S', // Scheduled
      cat_labor: 'I', // Inspection
      start_date: addDays(-3),
      stop_date: null,
      hours: 2.0,
      crew_chief: 'Bob Field',
      crew_size: 1,
      corrective: 'Initial inspection complete. Pending additional diagnostics.',
      discrepancy: 'Visual inspection revealed minor wear on sensor housing.',
      remarks: null,
      corrected_by: null,
      inspected_by: 'Bob Field',
      bit_log: 'BIT passed all tests',
      sent_imds: false,
      valid: true,
      created_by: 3,
      created_by_name: 'Bob Field',
      created_at: addDays(-3),
    },
  ];
  laborNextId = 3;
}

// Initialize labor records on server start
initializeLaborRecords();

// Attachment interface for maintenance event attachments
interface Attachment {
  attachment_id: number;
  event_id: number;
  filename: string;
  original_filename: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_by: number;
  uploaded_by_name: string;
  uploaded_at: string;
  description: string | null;
}

// Persistent storage for attachments
let attachments: Attachment[] = [];
let attachmentNextId = 1;

// Helper function to generate location prefix from location name
function getLocationPrefix(location: string): string {
  // Create a short prefix from the location name
  // e.g., "Depot Alpha" -> "DA", "Field Site Bravo" -> "FSB"
  const words = location.trim().split(/\s+/);
  if (words.length === 1) {
    // Single word: use first 3 characters
    return words[0].substring(0, 3).toUpperCase();
  }
  // Multiple words: use first letter of each word
  return words.map(w => w.charAt(0).toUpperCase()).join('');
}

// Helper function to generate job number unique per location
/**
 * Generate job number matching legacy ColdFusion format: yyyymmddSEQ
 * - yyyymmdd = current date
 * - SEQ = 3-digit zero-padded sequence, resets daily per location
 * - Persisted in adm_variable table as RIMSS_SEQ_{locId}
 * - Thread-safe via Prisma upsert (DB-level atomicity)
 */
async function generateJobNumber(locId: number | null): Promise<string> {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const jobDate = `${yyyy}${mm}${dd}`;

  // Use location ID for sequence tracking, default to 0 for unknown
  const effectiveLocId = locId ?? 0;
  const varName = `RIMSS_SEQ_${effectiveLocId}`;

  try {
    // Get or create the sequence variable
    let admVar = await prisma.admVariable.findUnique({ where: { var_name: varName } });

    let nextSeq = 1;

    if (admVar) {
      // Check if date has changed (reset sequence daily)
      const lastDate = admVar.chg_date ? new Date(admVar.chg_date) : null;
      const isNewDay = !lastDate ||
        lastDate.getFullYear() !== now.getFullYear() ||
        lastDate.getMonth() !== now.getMonth() ||
        lastDate.getDate() !== now.getDate();

      if (isNewDay) {
        nextSeq = 1;
      } else {
        nextSeq = (parseInt(admVar.var_value || '0', 10) || 0) + 1;
      }

      // Update the sequence
      await prisma.admVariable.update({
        where: { var_name: varName },
        data: {
          var_value: String(nextSeq),
          chg_date: now,
          chg_by: 'system',
        },
      });
    } else {
      // Create new sequence variable for this location
      await prisma.admVariable.create({
        data: {
          var_name: varName,
          var_value: '1',
          var_desc: `Job number sequence for location ${effectiveLocId}`,
          active: true,
          ins_by: 'system',
          chg_date: now,
          chg_by: 'system',
        },
      });
    }

    const seq = String(nextSeq).padStart(3, '0');
    return `${jobDate}${seq}`;
  } catch (error) {
    console.error('[JOB_NO] Failed to generate from DB, using fallback:', error);
    // Fallback: use in-memory counter if DB fails
    const fallbackSeq = (locationJobSeqMap.get(String(effectiveLocId)) || 0) + 1;
    locationJobSeqMap.set(String(effectiveLocId), fallbackSeq);
    const seq = String(fallbackSeq).padStart(3, '0');
    return `${jobDate}${seq}`;
  }
}

// Dashboard: Get open maintenance jobs (requires authentication)
app.get('/api/dashboard/open-maintenance-jobs', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get program filter from query string (optional)
  const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // Get user's location IDs for authorization check
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get location filter from query string (optional)
  let locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;

  // If location specified, verify user has access to it
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' });
  }

  // Use persistent maintenance events array
  const allEvents = maintenanceEvents;

  // Filter by user's accessible programs and open status
  let filteredEvents = allEvents.filter(
    event => event.status === 'open' && userProgramIds.includes(event.pgm_id)
  );

  // Apply program filter if specified
  if (programIdFilter && userProgramIds.includes(programIdFilter)) {
    filteredEvents = filteredEvents.filter(event => event.pgm_id === programIdFilter);
  }

  // SECURITY: Filter by location - join with assets to check loc_ida/loc_idc
  if (locationIdFilter || userLocationIds.length > 0) {
    filteredEvents = filteredEvents.filter(event => {
      const asset = detailedAssets.find(a => a.asset_id === event.asset_id);
      if (!asset) return false; // Event without asset shouldn't happen, but be defensive

      if (locationIdFilter) {
        // Filter by specific location
        const matchesAssignedBase = asset.loc_ida === locationIdFilter;
        const matchesCurrentBase = asset.loc_idc === locationIdFilter;
        return matchesAssignedBase || matchesCurrentBase;
      } else if (userLocationIds.length > 0) {
        // Filter by all user's locations
        const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida);
        const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc);
        return matchesAssignedBase || matchesCurrentBase;
      }
      return true;
    });
  }

  // Sort by priority (Critical first, then Urgent, then Routine)
  const priorityOrder: Record<string, number> = { Critical: 0, Urgent: 1, Routine: 2 };
  filteredEvents.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // Calculate summary counts
  const summary = {
    critical: filteredEvents.filter(e => e.priority === 'Critical').length,
    urgent: filteredEvents.filter(e => e.priority === 'Urgent').length,
    routine: filteredEvents.filter(e => e.priority === 'Routine').length,
    total: filteredEvents.length,
  };

  console.log(`[MAINTENANCE] Open jobs request by ${user.username} - Total: ${summary.total}, Critical: ${summary.critical}, Urgent: ${summary.urgent}, Routine: ${summary.routine}`);

  res.json({
    events: filteredEvents,
    summary,
  });
});

// List all maintenance events (requires authentication)
app.get('/api/events', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    // Load code cache for lookups
    const codes = await loadCodeCache();

    // Get user's program IDs
    const userProgramIds = user.programs.map(p => p.pgm_id);

    // Get user's location IDs
    const userLocationIds = user.locations?.map(l => l.loc_id) || [];

    // Get query parameters
    const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;
    const locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;
    const statusFilter = req.query.status as string | undefined; // 'open', 'closed', or undefined for all
    const eventTypeFilter = req.query.event_type as string | undefined; // 'Standard', 'PMI', 'TCTO', 'BIT/PC', or undefined for all
    const pqdrFilter = req.query.pqdr as string | undefined; // 'true' to filter only PQDR flagged events
    const sortieIdFilter = req.query.sortie_id ? parseInt(req.query.sortie_id as string, 10) : null; // Filter by linked sortie
    const searchQuery = req.query.search as string | undefined;
    const dateFrom = req.query.date_from as string | undefined; // Filter events starting from this date (YYYY-MM-DD)
    const dateTo = req.query.date_to as string | undefined; // Filter events up to this date (YYYY-MM-DD)
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 10;

    // Build where clause for Prisma query
    const whereClause: Prisma.EventWhereInput = {};

    // Filter by user's accessible programs
    whereClause.asset = {
      part: {
        pgm_id: { in: userProgramIds }
      }
    };

    // SECURITY: Filter by location - maintenance events must be at locations the user has access to
    // ADMIN users are exempt from location filtering and can see all events
    // If a specific location is requested, filter by that location
    // If no location specified and user has location restrictions, show events from all their locations
    if (locationIdFilter) {
      // Filter by the specific requested location (only if user has access to it)
      if (user.role !== 'ADMIN' && !userLocationIds.includes(locationIdFilter)) {
        // User doesn't have access to this location - return empty results
        whereClause.loc_id = -1; // Impossible ID to return no results
      } else {
        // ADMIN users can access any location, or non-ADMIN users with access to this location
        whereClause.loc_id = locationIdFilter;
      }
    } else if (user.role !== 'ADMIN' && userLocationIds.length > 0) {
      // No specific location requested - filter by all user's locations (unless ADMIN)
      whereClause.loc_id = { in: userLocationIds };
    }
    // If user is ADMIN or has no location restrictions, don't filter by location

    // Apply program filter if specified
    if (programIdFilter && userProgramIds.includes(programIdFilter)) {
      if (whereClause.asset && typeof whereClause.asset === 'object') {
        (whereClause.asset as Prisma.AssetWhereInput).part = {
          ...(whereClause.asset as any).part,
          pgm_id: programIdFilter
        };
      }
    }

    // Apply status filter if specified
    if (statusFilter === 'open' || statusFilter === 'closed') {
      // For events, we need to check if stop_job is null (open) or not null (closed)
      if (statusFilter === 'open') {
        whereClause.stop_job = null;
      } else {
        whereClause.stop_job = { not: null };
      }
    }

    // Apply event type filter if specified
    const validEventTypes = ['Standard', 'PMI', 'TCTO', 'BIT/PC'];
    if (eventTypeFilter && validEventTypes.includes(eventTypeFilter)) {
      whereClause.event_type = eventTypeFilter;
    }

    // Apply sortie filter if specified
    if (sortieIdFilter) {
      whereClause.sortie_id = sortieIdFilter;
    }

    // Apply date range filter if specified (based on start_job date)
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      fromDate.setHours(0, 0, 0, 0); // Start of day
      if (whereClause.start_job && typeof whereClause.start_job === 'object') {
        (whereClause.start_job as any).gte = fromDate;
      } else {
        whereClause.start_job = { gte: fromDate };
      }
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999); // End of day
      if (whereClause.start_job && typeof whereClause.start_job === 'object') {
        (whereClause.start_job as any).lte = toDate;
      } else {
        whereClause.start_job = { lte: toDate };
      }
    }

    // Query events from database with relations
    const dbEvents = await prisma.event.findMany({
      where: whereClause,
      include: {
        asset: {
          select: {
            asset_id: true,
            serno: true,
            part: {
              select: {
                partno: true,
                noun: true,
                pgm_id: true,
                program: {
                  select: { pgm_cd: true, pgm_name: true }
                }
              }
            }
          }
        },
        location: {
          select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true }
        },
        repairs: {
          select: { repair_id: true, shop_status: true }
        }
      },
      orderBy: [
        { priority: 'asc' },
        { start_job: 'desc' }
      ],
      skip: (page - 1) * limit,
      take: limit,
    });

    // Get total count for pagination (apply same filters but without pagination)
    const total = await prisma.event.count({ where: whereClause });

    // Transform database results to match frontend expected format
    let allEvents = dbEvents.map(dbEvent => {
      // Build location display string - resolve code IDs to actual codes
      const formatLocation = (loc: { display_name: string; majcom_cd?: string | null; site_cd?: string | null; unit_cd?: string | null } | null) => {
        if (!loc) return 'Unknown';

        // Resolve the majcom, site, unit IDs to actual codes
        const majcom = resolveCodeId(loc.majcom_cd || null, codes);
        const site = resolveCodeId(loc.site_cd || null, codes);
        const unit = resolveCodeId(loc.unit_cd || null, codes);

        // Build from resolved hierarchy components
        const parts = [majcom, site, unit].filter(Boolean);
        if (parts.length > 0) {
          return parts.join('/');
        }

        // Fallback to display_name if available and not just IDs
        if (loc.display_name && !loc.display_name.match(/^\d+\/\d+\/\d+$/)) {
          return loc.display_name;
        }

        return 'Unknown';
      };

      const asset = dbEvent.asset;
      const pgmId = asset?.part?.pgm_id || 1;

      return {
        event_id: dbEvent.event_id,
        asset_id: dbEvent.asset_id,
        asset_sn: asset?.serno || 'Unknown',
        asset_name: asset?.part?.noun || 'Unknown',
        job_no: dbEvent.job_no || `JOB-${dbEvent.event_id}`,
        discrepancy: dbEvent.discrepancy || 'No discrepancy description',
        start_job: dbEvent.start_job?.toISOString() || new Date().toISOString(),
        stop_job: dbEvent.stop_job?.toISOString() || null,
        etic: dbEvent.etic_date?.toISOString().split('T')[0] || null,
        status: dbEvent.stop_job ? 'closed' : 'open',
        priority: dbEvent.priority || 'Routine',
        symbol: dbEvent.symbol || null,
        event_type: dbEvent.event_type || 'Standard',
        pgm_id: pgmId,
        loc_id: dbEvent.loc_id || 0,
        location: formatLocation(dbEvent.location) || 'Unknown',
        sortie_id: dbEvent.sortie_id || null,
        when_discovered: dbEvent.when_disc || null,
        how_malfunction: dbEvent.how_mal || null,
        wuc_cd: dbEvent.wuc_cd || null,
        source: dbEvent.source || null,
        pqdr: false, // Default to false since PQDR field doesn't exist in database yet
        total_repairs: 0,
        closed_repairs: 0,
        progress_percentage: 0,
      };
    });

    // Apply search filter if specified (done in-memory since it searches multiple fields)
    if (searchQuery) {
      const query = searchQuery.toLowerCase().trim();
      if (query) {
        allEvents = allEvents.filter(event =>
          event.job_no.toLowerCase().includes(query) ||
          event.asset_sn.toLowerCase().includes(query) ||
          event.asset_name.toLowerCase().includes(query) ||
          event.discrepancy.toLowerCase().includes(query) ||
          event.location.toLowerCase().includes(query)
        );
      }
    }

    // Apply PQDR filter if specified (no PQDR field in database, so this will be empty)
    if (pqdrFilter === 'true') {
      allEvents = allEvents.filter(event => event.pqdr === true);
    }

    // Sort by priority (Critical first, then Urgent, then Routine), then by start date (newest first)
    const priorityOrder: Record<string, number> = { Critical: 0, Urgent: 1, Routine: 2 };
    allEvents.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.start_job).getTime() - new Date(a.start_job).getTime();
    });

    // Calculate pagination for filtered events
    const filteredTotal = allEvents.length;
    const totalPages = Math.ceil(filteredTotal / limit);
    const offset = (page - 1) * limit;
    const paginatedEvents = allEvents.slice(offset, offset + limit);

    // Calculate progress for each event based on repairs from database
    const eventsWithProgress = paginatedEvents.map(event => {
      const eventRepairs = dbEvents.find(db => db.event_id === event.event_id)?.repairs || [];
      const totalRepairs = eventRepairs.length;
      const closedRepairs = eventRepairs.filter(r => r.shop_status === 'closed').length;
      const progressPercentage = totalRepairs > 0 ? Math.round((closedRepairs / totalRepairs) * 100) : 0;

      return {
        ...event,
        total_repairs: totalRepairs,
        closed_repairs: closedRepairs,
        progress_percentage: progressPercentage,
      };
    });

    // Calculate summary counts - query ALL events for this program/location (ignoring status filter)
    // This ensures the header shows total open/closed/critical/urgent/routine regardless of which tab is active
    const summaryWhereClause: Prisma.EventWhereInput = {
      asset: {
        part: {
          pgm_id: programIdFilter || { in: userProgramIds }
        }
      }
    };
    // Apply same location filter as main query (but NOT status filter)
    if (locationIdFilter) {
      if (user.role !== 'ADMIN' && !userLocationIds.includes(locationIdFilter)) {
        summaryWhereClause.loc_id = -1;
      } else {
        summaryWhereClause.loc_id = locationIdFilter;
      }
    } else if (user.role !== 'ADMIN' && userLocationIds.length > 0) {
      summaryWhereClause.loc_id = { in: userLocationIds };
    }

    const [openCount, closedCount, criticalCount, urgentCount, routineCount] = await Promise.all([
      prisma.event.count({ where: { ...summaryWhereClause, stop_job: null } }),
      prisma.event.count({ where: { ...summaryWhereClause, stop_job: { not: null } } }),
      prisma.event.count({ where: { ...summaryWhereClause, stop_job: null, priority: 'Critical' } }),
      prisma.event.count({ where: { ...summaryWhereClause, stop_job: null, priority: 'Urgent' } }),
      prisma.event.count({ where: { ...summaryWhereClause, stop_job: null, priority: 'Routine' } }),
    ]);

    const summary = {
      open: openCount,
      closed: closedCount,
      critical: criticalCount,
      urgent: urgentCount,
      routine: routineCount,
      pqdr: 0,
      total: openCount + closedCount,
    };

    // Get program info
    const currentProgramId = programIdFilter || user.programs.find(p => p.is_default)?.pgm_id || user.programs[0]?.pgm_id;
    const programInfo = user.programs.find(p => p.pgm_id === currentProgramId);

    console.log(`[EVENTS-DB] List request by ${user.username} - Total: ${total}, Open: ${summary.open}, Closed: ${summary.closed}`);

    res.json({
      events: eventsWithProgress,
      pagination: {
        page,
        limit,
        total: filteredTotal,
        total_pages: totalPages,
      },
      summary,
      program: programInfo,
    });
  } catch (error) {
    console.error('[EVENTS-DB] Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events from database' });
  }
});

// Get single maintenance event by ID
app.get('/api/events/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await maintenanceData.getEventById(eventId);

    if (!event) {
      return res.status(404).json({ error: 'Maintenance event not found' });
    }

    // Check if user has access to this event's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(event.pgm_id)) {
      return res.status(403).json({ error: 'Access denied to this maintenance event' });
    }

    // Check location access (non-ADMIN users)
    const userLocationIds = user.locations?.map(l => l.loc_id) || [];
    if (user.role !== 'ADMIN' && event.loc_id && userLocationIds.length > 0 && !userLocationIds.includes(event.loc_id)) {
      return res.status(403).json({ error: 'Access denied to this maintenance event - location not authorized' });
    }

    res.json({ event });
  } catch (error) {
    console.error('[EVENTS] Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// Create new maintenance event (requires authentication)
// Roles: ADMIN, DEPOT_MANAGER, FIELD_TECHNICIAN can create events
app.post('/api/events', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can create events
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to create maintenance events.' });
  }

  // Extract and validate request body
  const {
    asset_id,
    discrepancy,
    event_type,
    priority,
    start_job,
    etic,
    location,
    sortie_id,
  } = req.body;

  // Validate required fields
  if (!asset_id) {
    return res.status(400).json({ error: 'Asset is required' });
  }
  if (!discrepancy || discrepancy.trim() === '') {
    return res.status(400).json({ error: 'Discrepancy description is required' });
  }
  if (discrepancy.trim().length < 10) {
    return res.status(400).json({ error: 'Discrepancy description must be at least 10 characters' });
  }
  if (discrepancy.trim().length > 500) {
    return res.status(400).json({ error: 'Discrepancy description must not exceed 500 characters' });
  }
  if (!event_type || !['Standard', 'PMI', 'TCTO', 'BIT/PC'].includes(event_type)) {
    return res.status(400).json({ error: 'Valid event type is required (Standard, PMI, TCTO, BIT/PC)' });
  }
  if (!start_job) {
    return res.status(400).json({ error: 'Date in is required' });
  }

  // Find the asset from DATABASE (not mockAssets array)
  const asset = await prisma.asset.findUnique({
    where: { asset_id: parseInt(asset_id, 10) },
    include: {
      part: {
        select: {
          pgm_id: true
        }
      }
    }
  });

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check user has access to the asset's program
  const assetProgramId = asset.part?.pgm_id || asset.pgm_id;
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(assetProgramId)) {
    return res.status(403).json({ error: 'Access denied to this asset\'s program' });
  }

  // Determine the location for this event
  const eventLocation = location || asset.admin_loc || 'Unknown';

  // Determine location ID from location string (use asset's loc_ida if available, otherwise try to map)
  let eventLocationId = asset.loc_ida || maintenanceLocationNameToId[eventLocation] || 154; // Default to DEPOT-A

  // Generate new event ID and job number (unique per location)
  const newEventId = maintenanceEventNextId++;
  const newJobNo = await generateJobNumber(eventLocationId || null);

  // Validate sortie_id if provided
  let validSortieId: number | null = null;
  if (sortie_id) {
    const sortie = sorties.find(s => s.sortie_id === parseInt(sortie_id, 10));
    if (!sortie) {
      return res.status(400).json({ error: 'Selected sortie not found' });
    }
    // Verify sortie belongs to same program as asset
    if (sortie.pgm_id !== assetProgramId) {
      return res.status(400).json({ error: 'Sortie must belong to the same program as the asset' });
    }
    validSortieId = sortie.sortie_id;
  }

  // Get asset name from part.noun if available, otherwise use serno
  const assetName = asset.part?.noun || asset.serno || 'Unknown';

  // Create the new maintenance event
  const newEvent: MaintenanceEvent = {
    event_id: newEventId,
    asset_id: asset.asset_id,
    asset_sn: asset.serno,
    asset_name: assetName,
    job_no: newJobNo,
    discrepancy: discrepancy.trim(),
    start_job: start_job,
    stop_job: null,
    event_type: event_type,
    priority: priority || 'Routine',
    status: 'open',
    pgm_id: assetProgramId,
    location: eventLocation,
    loc_id: eventLocationId,
    etic: etic || null,
    sortie_id: validSortieId,
    created_by_id: user.user_id,
    created_by_name: `${user.first_name} ${user.last_name}`,
    created_at: new Date().toISOString(),
  };

  // Add to the persistent array
  maintenanceEvents.push(newEvent);
    // Also persist to DB
    await prisma.event.create({
      data: {
        asset_id: newEvent.asset_id,
        loc_id: newEvent.loc_id || null,
        job_no: newEvent.job_no,
        discrepancy: newEvent.discrepancy,
        start_job: newEvent.start_job ? new Date(newEvent.start_job) : new Date(),
        stop_job: newEvent.stop_job ? new Date(newEvent.stop_job) : null,
        event_type: newEvent.event_type === 'PMI' ? 'PM' : newEvent.event_type === 'Standard' ? 'CM' : 'CM',
        priority: newEvent.priority,
        ins_by: newEvent.created_by_name || 'system',
      },
    }).catch(e => console.error('[EVENT] DB create failed:', e));

  console.log(`[EVENTS] Created maintenance event ${newJobNo} by ${user.username} for asset ${asset.serno}`);

  res.status(201).json({
    message: 'Maintenance event created successfully',
    event: newEvent,
  });
});

// Update maintenance event (requires authentication)
// Roles: ADMIN, DEPOT_MANAGER, FIELD_TECHNICIAN can edit events
app.put('/api/events/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can edit events
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to edit maintenance events.' });
  }

  const eventId = parseInt(req.params.id, 10);
  const eventIndex = maintenanceEvents.findIndex(e => e.event_id === eventId);

  if (eventIndex === -1) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  const event = maintenanceEvents[eventIndex];

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this maintenance event' });
  }

  // Extract fields that can be updated
  const {
    discrepancy,
    event_type,
    priority,
    etic,
    location,
    status,
    stop_job,
    sortie_id,
    pqdr,
  } = req.body;

  // Update allowed fields
  if (discrepancy !== undefined && discrepancy.trim() !== '') {
    maintenanceEvents[eventIndex].discrepancy = discrepancy.trim();
  }

  if (event_type !== undefined && ['Standard', 'PMI', 'TCTO', 'BIT/PC'].includes(event_type)) {
    maintenanceEvents[eventIndex].event_type = event_type;
  }

  if (priority !== undefined && ['Routine', 'Urgent', 'Critical'].includes(priority)) {
    maintenanceEvents[eventIndex].priority = priority;
  }

  if (etic !== undefined) {
    maintenanceEvents[eventIndex].etic = etic || null;
  }

  if (location !== undefined) {
    maintenanceEvents[eventIndex].location = location;
  }

  // Handle sortie_id update
  if (sortie_id !== undefined) {
    if (sortie_id === null || sortie_id === '') {
      maintenanceEvents[eventIndex].sortie_id = null;
    } else {
      const sortie = sorties.find(s => s.sortie_id === parseInt(sortie_id, 10));
      if (!sortie) {
        return res.status(400).json({ error: 'Selected sortie not found' });
      }
      // Verify sortie belongs to same program as event
      if (sortie.pgm_id !== event.pgm_id) {
        return res.status(400).json({ error: 'Sortie must belong to the same program as the event' });
      }
      maintenanceEvents[eventIndex].sortie_id = sortie.sortie_id;
    }
  }

  // Handle status change to closed
  if (status !== undefined && ['open', 'closed'].includes(status)) {
    maintenanceEvents[eventIndex].status = status;
    if (status === 'closed' && !maintenanceEvents[eventIndex].stop_job) {
      maintenanceEvents[eventIndex].stop_job = new Date().toISOString().split('T')[0];
    }
    if (status === 'open') {
      maintenanceEvents[eventIndex].stop_job = null;
    }
  }

  // Allow explicit stop_job setting
  if (stop_job !== undefined) {
    maintenanceEvents[eventIndex].stop_job = stop_job || null;
  }

  // Handle PQDR flag update
  if (pqdr !== undefined) {
    maintenanceEvents[eventIndex].pqdr = Boolean(pqdr);
    console.log(`[EVENTS] PQDR flag ${pqdr ? 'enabled' : 'disabled'} for event ${event.job_no}`);
  }

  console.log(`[EVENTS] Updated maintenance event ${event.job_no} by ${user.username}`);

  res.json({
    message: 'Maintenance event updated successfully',
    event: maintenanceEvents[eventIndex],
  });
});
// Get repairs for a maintenance event
app.get('/api/events/:eventId/repairs', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const eventId = parseInt(req.params.eventId, 10);
    
    // Get event from database
    const event = await maintenanceData.getEventById(eventId);

    if (!event) {
      return res.status(404).json({ error: 'Maintenance event not found' });
    }

    // Check if user has access to this event's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(event.pgm_id)) {
      return res.status(403).json({ error: 'Access denied to this maintenance event' });
    }

    // SECURITY: Check if user has access to this event's location (unless ADMIN)
    const userLocationIds = user.locations.map(l => l.loc_id);
    if (user.role !== 'ADMIN' && event.loc_id && userLocationIds.length > 0 && !userLocationIds.includes(event.loc_id)) {
      return res.status(403).json({ error: 'Access denied to this maintenance event - location not authorized' });
    }

    // Get repairs from database
    const eventRepairs = await maintenanceData.getRepairsForEvent(eventId);

    // Build reverse lookup for TCTO links to repairs
    // For each repair, find if any TCTO completion is linked to it
    const repairsWithTCTO = eventRepairs.map(repair => {
      let linkedTCTO = null;

      // Search through all TCTO completion data for any that link to this repair
      for (const [tctoId, completionDataArray] of tctoAssetCompletionData.entries()) {
        const linkedCompletion = completionDataArray.find(c => c.linked_repair_id === repair.repair_id);
        if (linkedCompletion) {
          // Found a TCTO linked to this repair
          const tcto = tctoRecords.find(t => t.tcto_id === tctoId);
          if (tcto) {
            linkedTCTO = {
              tcto_id: tcto.tcto_id,
              tcto_no: tcto.tcto_no,
              title: tcto.title,
              status: tcto.status,
              priority: tcto.priority,
              completion_date: linkedCompletion.completion_date,
            };
            break; // Only one TCTO can be linked per repair
          }
        }
      }

      return {
        ...repair,
        linked_tcto: linkedTCTO,
      };
    });

    // Calculate summary
    const summary = {
      total: eventRepairs.length,
      open: eventRepairs.filter(r => r.shop_status === 'open').length,
      closed: eventRepairs.filter(r => r.shop_status === 'closed').length,
    };

    console.log(`[REPAIRS-DB] Fetched ${eventRepairs.length} repairs for event ${event.job_no} by ${user.username}`);

    res.json({
      repairs: repairsWithTCTO,
      summary,
    });
  } catch (error) {
    console.error('[REPAIRS] Error fetching repairs:', error);
    res.status(500).json({ error: 'Failed to fetch repairs' });
  }
});
// Get single repair by ID
app.get('/api/repairs/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const repairId = parseInt(req.params.id, 10);
    const repair = await maintenanceData.getRepairById(repairId);

    if (!repair) {
      return res.status(404).json({ error: 'Repair not found' });
    }

    // Get associated event to check program and location access
    const event = await maintenanceData.getEventById(repair.event_id);
    if (!event) {
      return res.status(404).json({ error: 'Associated maintenance event not found' });
    }

    // Check if user has access to this event's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(event.pgm_id)) {
      return res.status(403).json({ error: 'Access denied to this repair' });
    }

    // SECURITY: Check if user has access to this event's location (unless ADMIN)
    const userLocationIds = user.locations.map(l => l.loc_id);
    if (user.role !== 'ADMIN' && event.loc_id && userLocationIds.length > 0 && !userLocationIds.includes(event.loc_id)) {
      return res.status(403).json({ error: 'Access denied to this repair - location not authorized' });
    }

    res.json({ repair });
  } catch (error) {
    console.error('[REPAIRS] Error fetching repair:', error);
    res.status(500).json({ error: 'Failed to fetch repair' });
  }
});
// Create a new repair for an event
app.post('/api/events/:eventId/repairs', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can create repairs
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to create repairs.' });
  }

  try {
    const eventId = parseInt(req.params.eventId, 10);
    const event = await maintenanceData.getEventById(eventId);

    if (!event) {
      return res.status(404).json({ error: 'Maintenance event not found' });
    }

    // Check if user has access to this event's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(event.pgm_id)) {
      return res.status(403).json({ error: 'Access denied to this maintenance event' });
    }

    // Cannot add repairs to closed events
    if (event.status === 'closed') {
      return res.status(400).json({ error: 'Cannot add repairs to a closed maintenance event' });
    }

    const { start_date, type_maint, how_mal, when_disc, action_taken, narrative, tag_no, doc_no, micap, chief_review, super_review, repeat_recur, donor_asset_id, eti_in } = req.body;

    // Validate required fields
    if (!type_maint || !narrative) {
      return res.status(400).json({ error: 'Maintenance type and narrative are required' });
    }

    // If action_taken is 'T' (cannibalization), donor_asset_id is required
    if (action_taken === 'T' && !donor_asset_id) {
      return res.status(400).json({ error: 'Donor asset is required for cannibalization (Action T)' });
    }

    // Handle cannibalization - update donor asset status in database
    if (action_taken === 'T' && donor_asset_id) {
      await prisma.asset.update({
        where: { asset_id: parseInt(donor_asset_id, 10) },
        data: { status_cd: 'NMCS' }
      });
      console.log(`[CANNIBALIZATION] Donor asset ${donor_asset_id} status changed to NMCS`);
    }

    // Create repair in database
    const newRepair = await maintenanceData.createRepair({
      event_id: eventId,
      asset_id: event.asset_id,
      start_date: start_date || new Date().toISOString().split('T')[0],
      type_maint,
      how_mal: how_mal || null,
      when_disc: when_disc || null,
      narrative,
      tag_no: tag_no || null,
      doc_no: doc_no || null,
      micap: micap === true,
      chief_review: chief_review === true,
      super_review: super_review === true,
      repeat_recur: repeat_recur === true,
      eti_in: eti_in !== undefined && eti_in !== null && eti_in !== '' ? parseFloat(eti_in) : null,
      ins_by: user.username,
    });

    // Update asset's ETI hours if eti_in is provided
    if (newRepair.eti_in !== null) {
      await prisma.asset.update({
        where: { asset_id: event.asset_id },
        data: { eti: newRepair.eti_in }
      });
      console.log(`[REPAIRS-DB] Asset ${event.asset_id} ETI updated to ${newRepair.eti_in} hours`);
    }

    console.log(`[REPAIRS-DB] Created repair ${newRepair.repair_id} for event ${event.job_no} by ${user.username}`);

    res.status(201).json({
      message: 'Repair created successfully',
      repair: newRepair,
    });
  } catch (error) {
    console.error('[REPAIRS] Error creating repair:', error);
    res.status(500).json({ error: 'Failed to create repair' });
  }
});

// Update a repair
app.put('/api/repairs/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to update repairs.' });
  }

  const repairId = parseInt(req.params.id, 10);
  const repairIndex = repairs.findIndex(r => r.repair_id === repairId);

  if (repairIndex === -1) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  const repair = repairs[repairIndex];

  // Get associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this repair' });
  }

  const { type_maint, how_mal, when_disc, action_taken, narrative, tag_no, doc_no, shop_status, stop_date, micap, chief_review, super_review, repeat_recur, donor_asset_id, eti_in, eti_out, meter_changed } = req.body;

  // Update fields
  if (type_maint !== undefined) {
    repairs[repairIndex].type_maint = type_maint;
  }
  if (how_mal !== undefined) {
    repairs[repairIndex].how_mal = how_mal || null;
  }
  if (when_disc !== undefined) {
    repairs[repairIndex].when_disc = when_disc || null;
  }
  if (narrative !== undefined) {
    repairs[repairIndex].narrative = narrative;
  }
  if (tag_no !== undefined) {
    repairs[repairIndex].tag_no = tag_no || null;
  }
  if (doc_no !== undefined) {
    repairs[repairIndex].doc_no = doc_no || null;
  }

  // Handle action_taken update and cannibalization workflow
  if (action_taken !== undefined) {
    const previousActionTaken = repairs[repairIndex].action_taken;
    repairs[repairIndex].action_taken = action_taken || null;

    // If changing to cannibalization (T), require donor asset
    if (action_taken === 'T') {
      if (!donor_asset_id && !repairs[repairIndex].donor_asset_id) {
        return res.status(400).json({ error: 'Donor asset is required for cannibalization (Action T)' });
      }
    }

    // If changing away from cannibalization, clear donor asset fields
    if (previousActionTaken === 'T' && action_taken !== 'T') {
      // Optionally restore donor asset status if needed
      repairs[repairIndex].donor_asset_id = null;
      repairs[repairIndex].donor_asset_sn = null;
      repairs[repairIndex].donor_asset_pn = null;
      repairs[repairIndex].donor_asset_name = null;
    }
  }

  // Handle donor asset update for cannibalization
  if (donor_asset_id !== undefined) {
    const currentActionTaken = action_taken !== undefined ? action_taken : repairs[repairIndex].action_taken;

    if (currentActionTaken === 'T' && donor_asset_id) {
      const donorAsset = mockAssets.find(a => a.asset_id === donor_asset_id);
      if (donorAsset) {
        repairs[repairIndex].donor_asset_id = donor_asset_id;
        repairs[repairIndex].donor_asset_sn = donorAsset.serno;
        repairs[repairIndex].donor_asset_pn = donorAsset.partno;
        repairs[repairIndex].donor_asset_name = donorAsset.name;

        // Update donor asset status to NMCS - DB + cache
        const donorAssetIndex = mockAssets.findIndex(a => a.asset_id === donor_asset_id);
        if (donorAssetIndex !== -1) {
          mockAssets[donorAssetIndex].status_cd = 'NMCS';
          await prisma.asset.update({ where: { asset_id: donor_asset_id }, data: { status_cd: 'NMCS', chg_by: user.username, chg_date: new Date() } }).catch(e => console.error('[CANNIBALIZATION] DB update failed:', e));
          await refreshAssetInMemory(donor_asset_id).catch(() => {});
          console.log(`[CANNIBALIZATION] Donor asset ${donorAsset.serno} status changed to NMCS`);
        }
      } else {
        return res.status(400).json({ error: 'Donor asset not found' });
      }
    } else if (!currentActionTaken || currentActionTaken !== 'T') {
      // Clear donor asset fields if not cannibalization
      repairs[repairIndex].donor_asset_id = null;
      repairs[repairIndex].donor_asset_sn = null;
      repairs[repairIndex].donor_asset_pn = null;
      repairs[repairIndex].donor_asset_name = null;
    }
  }

  // Handle MICAP flag toggle
  if (micap !== undefined) {
    const previousMicap = repairs[repairIndex].micap;
    repairs[repairIndex].micap = micap === true;
    // Track who set the MICAP flag (only update if changing to true)
    if (micap === true && !previousMicap) {
      repairs[repairIndex].micap_login = user.username;
    }
    // Clear micap_login when turning off MICAP
    if (micap === false) {
      repairs[repairIndex].micap_login = null;
    }
    console.log(`[REPAIRS] MICAP flag ${micap ? 'enabled' : 'disabled'} on repair ${repairId} by ${user.username}`);
  }

  // Handle Chief Review flag toggle
  if (chief_review !== undefined) {
    const previousChiefReview = repairs[repairIndex].chief_review;
    repairs[repairIndex].chief_review = chief_review === true;
    // Track who set the Chief Review flag (only update if changing to true)
    if (chief_review === true && !previousChiefReview) {
      repairs[repairIndex].chief_review_by = user.username;
    }
    // Clear chief_review_by when turning off Chief Review
    if (chief_review === false) {
      repairs[repairIndex].chief_review_by = null;
    }
    console.log(`[REPAIRS] Chief Review flag ${chief_review ? 'enabled' : 'disabled'} on repair ${repairId} by ${user.username}`);
  }

  // Handle supervisor review flag update
  if (super_review !== undefined) {
    const previousSuperReview = repairs[repairIndex].super_review;
    repairs[repairIndex].super_review = super_review === true;
    // Track who set the Supervisor Review flag (only update if changing to true)
    if (super_review === true && !previousSuperReview) {
      repairs[repairIndex].super_review_by = user.username;
    }
    // Clear super_review_by when turning off Supervisor Review
    if (super_review === false) {
      repairs[repairIndex].super_review_by = null;
    }
    console.log(`[REPAIRS] Supervisor Review flag ${super_review ? 'enabled' : 'disabled'} on repair ${repairId} by ${user.username}`);
  }

  // Handle Repeat/Recur flag toggle
  if (repeat_recur !== undefined) {
    const previousRepeatRecur = repairs[repairIndex].repeat_recur;
    repairs[repairIndex].repeat_recur = repeat_recur === true;
    // Track who set the Repeat/Recur flag (only update if changing to true)
    if (repeat_recur === true && !previousRepeatRecur) {
      repairs[repairIndex].repeat_recur_by = user.username;
    }
    // Clear repeat_recur_by when turning off Repeat/Recur
    if (repeat_recur === false) {
      repairs[repairIndex].repeat_recur_by = null;
    }
    console.log(`[REPAIRS] Repeat/Recur flag ${repeat_recur ? 'enabled' : 'disabled'} on repair ${repairId} by ${user.username}`);
  }

  // Handle status change to closed
  if (shop_status !== undefined && ['open', 'closed'].includes(shop_status)) {
    repairs[repairIndex].shop_status = shop_status;
    if (shop_status === 'closed' && !repairs[repairIndex].stop_date) {
      repairs[repairIndex].stop_date = new Date().toISOString().split('T')[0];
    }
    if (shop_status === 'open') {
      repairs[repairIndex].stop_date = null;
    }
  }

  // Allow explicit stop_date setting with validation
  if (stop_date !== undefined) {
    if (stop_date) {
      // Validate stop_date >= start_date
      const startDate = new Date(repairs[repairIndex].start_date);
      const endDate = new Date(stop_date);
      if (endDate < startDate) {
        return res.status(400).json({ error: 'Stop date cannot be before the start date' });
      }
    }
    repairs[repairIndex].stop_date = stop_date || null;
    // Automatically set shop_status to closed when stop_date is set
    if (stop_date) {
      repairs[repairIndex].shop_status = 'closed';
    }
  }

  // Handle ETI In update (can be updated while repair is open)
  if (eti_in !== undefined) {
    repairs[repairIndex].eti_in = eti_in !== null && eti_in !== '' ? parseFloat(eti_in) : null;
  }

  // Handle meter_changed flag update
  if (meter_changed !== undefined) {
    repairs[repairIndex].meter_changed = meter_changed === true;
    console.log(`[REPAIRS] Meter changed flag ${meter_changed ? 'enabled' : 'disabled'} on repair ${repairId}`);
  }

  // Handle ETI Out update (typically set when closing repair)
  if (eti_out !== undefined) {
    const parsedEtiOut = eti_out !== null && eti_out !== '' ? parseFloat(eti_out) : null;

    // Validate eti_out >= eti_in unless meter_changed is true
    if (parsedEtiOut !== null && repairs[repairIndex].eti_in !== null && !repairs[repairIndex].meter_changed) {
      if (parsedEtiOut < repairs[repairIndex].eti_in) {
        return res.status(400).json({
          error: `ETI Out (${parsedEtiOut}) cannot be less than ETI In (${repairs[repairIndex].eti_in}) unless the meter was replaced. Check the "Meter Changed" checkbox if the physical meter was replaced.`
        });
      }
    }

    repairs[repairIndex].eti_out = parsedEtiOut;

    // Calculate ETI delta when eti_out is set and eti_in exists
    if (parsedEtiOut !== null && repairs[repairIndex].eti_in !== null) {
      const delta = parsedEtiOut - repairs[repairIndex].eti_in;
      repairs[repairIndex].eti_delta = Math.round(delta * 100) / 100; // Round to 2 decimal places
      console.log(`[REPAIRS] ETI delta calculated: ${repairs[repairIndex].eti_delta} (in: ${repairs[repairIndex].eti_in}, out: ${parsedEtiOut})`);

      // Update the asset's ETI hours if we have a valid delta
      const assetIndex = detailedAssets.findIndex(a => a.asset_id === repairs[repairIndex].asset_id);
      if (assetIndex !== -1 && detailedAssets[assetIndex].eti_hours !== null) {
        // Update ETI in cache and DB
        detailedAssets[assetIndex].eti_hours = parsedEtiOut;
        await prisma.asset.update({ where: { asset_id: repairs[repairIndex].asset_id }, data: { eti: parsedEtiOut } }).catch(e => console.error('[ETI] DB update failed:', e));
        console.log(`[REPAIRS] Asset ${repairs[repairIndex].asset_id} ETI updated to ${parsedEtiOut} hours`);
      }
    } else if (parsedEtiOut === null) {
      repairs[repairIndex].eti_delta = null;
    }
  }

  console.log(`[REPAIRS] Updated repair ${repairId} by ${user.username}`);

  res.json({
    message: 'Repair updated successfully',
    repair: repairs[repairIndex],
  });
});

// Delete a repair
app.delete('/api/repairs/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN and DEPOT_MANAGER can delete repairs
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. Only administrators and depot managers can delete repairs.' });
  }

  const repairId = parseInt(req.params.id, 10);
  const repairIndex = repairs.findIndex(r => r.repair_id === repairId);

  if (repairIndex === -1) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  const repair = repairs[repairIndex];

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this repair' });
  }

  // Cannot delete repairs from closed events
  if (event.status === 'closed') {
    return res.status(400).json({ error: 'Cannot delete repairs from a closed maintenance event' });
  }

  // Store repair info for response before deletion
  const deletedRepairInfo = {
    repair_id: repair.repair_id,
    repair_seq: repair.repair_seq,
    event_id: repair.event_id,
    job_no: event.job_no,
  };

  // Remove the repair
  repairs.splice(repairIndex, 1);

  console.log(`[REPAIRS] Deleted repair ${repair.repair_id} (seq ${repair.repair_seq}) from event ${event.job_no} by ${user.username}`);

  res.json({
    message: 'Repair deleted successfully',
    repair: deletedRepairInfo,
  });
});

// ============================================
// INSTALLED PARTS ENDPOINTS
// ============================================

// Get installed parts for a repair
app.get('/api/repairs/:repairId/installed-parts', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const repairId = parseInt(req.params.repairId, 10);
  const repair = repairs.find(r => r.repair_id === repairId);

  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this repair' });
  }

  // Get installed parts for this repair
  const repairInstalledParts = installedParts.filter(ip => ip.repair_id === repairId);

  console.log(`[INSTALLED_PARTS] Fetched ${repairInstalledParts.length} installed parts for repair ${repairId} by ${user.username}`);

  res.json({
    installed_parts: repairInstalledParts,
    total: repairInstalledParts.length,
  });
});

// Add an installed part to a repair
app.post('/api/repairs/:repairId/installed-parts', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can add installed parts
  if (!['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'].includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to add installed parts.' });
  }

  const repairId = parseInt(req.params.repairId, 10);
  const repair = repairs.find(r => r.repair_id === repairId);

  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this repair' });
  }

  // Cannot add installed parts to closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot add installed parts to a closed repair' });
  }

  // Cannot add installed parts to closed events
  if (event.status === 'closed') {
    return res.status(400).json({ error: 'Cannot add installed parts to a closed maintenance event' });
  }

  const { asset_id, installation_date, installation_notes } = req.body;

  // Validate required fields
  if (!asset_id) {
    return res.status(400).json({ error: 'Asset ID is required' });
  }

  // Find the asset to get its details
  const asset = mockAssets.find(a => a.asset_id === asset_id);
  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if asset belongs to the same program
  if (asset.pgm_id !== event.pgm_id) {
    return res.status(400).json({ error: 'Asset must belong to the same program as the maintenance event' });
  }

  // Check if asset is already installed in this repair
  const existingInstall = installedParts.find(ip => ip.repair_id === repairId && ip.asset_id === asset_id);
  if (existingInstall) {
    return res.status(400).json({ error: 'This asset is already recorded as installed in this repair' });
  }

  // Store previous location before updating
  const previousLocation = asset.location || null;

  // Create the installed part record
  const newInstalledPart: InstalledPart = {
    installed_part_id: installedPartNextId++,
    repair_id: repairId,
    event_id: event.event_id,
    asset_id: asset.asset_id,
    asset_sn: asset.serno,
    asset_pn: asset.partno,
    asset_name: asset.nomen || asset.partno,
    installation_date: installation_date || new Date().toISOString().split('T')[0],
    installation_notes: installation_notes || null,
    previous_location: previousLocation,
    installed_by: user.user_id,
    installed_by_name: user.full_name,
    created_at: new Date().toISOString(),
  };

  installedParts.push(newInstalledPart);

  // Update the asset's location to indicate it's now installed in the maintenance event's asset
  const targetAsset = mockAssets.find(a => a.asset_id === event.asset_id);
  if (targetAsset) {
    asset.location = `Installed in ${targetAsset.serno}`;

    // Also update detailedAssets since that's what the assets API uses
    const detailedAsset = detailedAssets.find(a => a.asset_id === asset.asset_id);
    if (detailedAsset) {
      detailedAsset.location = `Installed in ${targetAsset.serno}`;
    }
  }

  console.log(`[INSTALLED_PARTS] Added installed part (asset ${asset.serno}) to repair ${repairId} by ${user.username}. Previous location: ${previousLocation}`);

  res.status(201).json({
    message: 'Installed part recorded successfully',
    installed_part: newInstalledPart,
  });
});

// Remove an installed part from a repair
app.delete('/api/installed-parts/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN and DEPOT_MANAGER can remove installed parts
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. Only administrators and depot managers can remove installed parts.' });
  }

  const installedPartId = parseInt(req.params.id, 10);
  const installedPartIndex = installedParts.findIndex(ip => ip.installed_part_id === installedPartId);

  if (installedPartIndex === -1) {
    return res.status(404).json({ error: 'Installed part record not found' });
  }

  const installedPart = installedParts[installedPartIndex];

  // Get the repair to check access
  const repair = repairs.find(r => r.repair_id === installedPart.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Associated repair not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === installedPart.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this installed part record' });
  }

  // Cannot remove installed parts from closed events
  if (event.status === 'closed') {
    return res.status(400).json({ error: 'Cannot remove installed parts from a closed maintenance event' });
  }

  // Restore the asset's previous location
  const asset = mockAssets.find(a => a.asset_id === installedPart.asset_id);
  if (asset && installedPart.previous_location) {
    asset.location = installedPart.previous_location;

    // Also update detailedAssets since that's what the assets API uses
    const detailedAsset = detailedAssets.find(a => a.asset_id === installedPart.asset_id);
    if (detailedAsset) {
      detailedAsset.location = installedPart.previous_location;
    }

    console.log(`[INSTALLED_PARTS] Restored asset ${asset.serno} location to: ${installedPart.previous_location}`);
  }

  // Store info for response before deletion
  const deletedInfo = {
    installed_part_id: installedPart.installed_part_id,
    asset_sn: installedPart.asset_sn,
    repair_id: installedPart.repair_id,
  };

  // Remove the installed part record
  installedParts.splice(installedPartIndex, 1);

  console.log(`[INSTALLED_PARTS] Removed installed part ${installedPartId} (asset ${installedPart.asset_sn}) from repair ${installedPart.repair_id} by ${user.username}`);

  res.json({
    message: 'Installed part record removed successfully',
    installed_part: deletedInfo,
  });
});

// Search assets for installation (within the same program)
app.get('/api/events/:eventId/available-assets', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const eventId = parseInt(req.params.eventId, 10);
  const event = maintenanceEvents.find(e => e.event_id === eventId);

  if (!event) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this maintenance event' });
  }

  const searchQuery = (req.query.search as string || '').toLowerCase().trim() || null;

  // Get assets from the same program that are not the event's primary asset
  let availableAssets = mockAssets.filter(a =>
    a.pgm_id === event.pgm_id &&
    a.asset_id !== event.asset_id
  );

  // Apply search filter if provided
  if (searchQuery) {
    availableAssets = availableAssets.filter(a =>
      a.serno.toLowerCase().includes(searchQuery) ||
      a.partno.toLowerCase().includes(searchQuery) ||
      (a.nomen && a.nomen.toLowerCase().includes(searchQuery))
    );
  }

  // Limit results
  const limit = parseInt(req.query.limit as string, 10) || 20;
  availableAssets = availableAssets.slice(0, limit);

  console.log(`[INSTALLED_PARTS] Asset search for event ${event.job_no} by ${user.username} - found ${availableAssets.length} results`);

  res.json({
    assets: availableAssets.map(a => ({
      asset_id: a.asset_id,
      serno: a.serno,
      partno: a.partno,
      nomen: a.nomen,
      status: a.status,
      location: a.location,
    })),
    total: availableAssets.length,
  });
});

// ============================================
// REMOVED PARTS ENDPOINTS
// ============================================

// Get removed parts for a repair
app.get('/api/repairs/:repairId/removed-parts', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const repairId = parseInt(req.params.repairId, 10);
  const repair = repairs.find(r => r.repair_id === repairId);

  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this repair' });
  }

  // Get removed parts for this repair
  const repairRemovedParts = removedParts.filter(rp => rp.repair_id === repairId);

  console.log(`[REMOVED_PARTS] Fetched ${repairRemovedParts.length} removed parts for repair ${repairId} by ${user.username}`);

  res.json({
    removed_parts: repairRemovedParts,
    total: repairRemovedParts.length,
  });
});

// Add a removed part to a repair
app.post('/api/repairs/:repairId/removed-parts', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can add removed parts
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to add removed parts.' });
  }

  const repairId = parseInt(req.params.repairId, 10);
  const repair = repairs.find(r => r.repair_id === repairId);

  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this repair' });
  }

  // Cannot add removed parts to repairs in closed events
  if (event.status === 'closed') {
    return res.status(400).json({ error: 'Cannot add removed parts to repairs in closed maintenance events' });
  }

  // Cannot add removed parts to closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot add removed parts to closed repairs' });
  }

  const { asset_id, removal_date, removal_reason, removal_notes, new_status } = req.body;

  // Validate required fields
  if (!asset_id) {
    return res.status(400).json({ error: 'Asset ID is required' });
  }

  // Find the asset being removed
  const asset = mockAssets.find(a => a.asset_id === asset_id);
  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check that asset belongs to the same program
  if (asset.pgm_id !== event.pgm_id) {
    return res.status(400).json({ error: 'Asset must belong to the same program as the maintenance event' });
  }

  // Check if this asset is already removed in this repair
  const existingRemoval = removedParts.find(rp => rp.repair_id === repairId && rp.asset_id === asset_id);
  if (existingRemoval) {
    return res.status(400).json({ error: 'This asset is already listed as removed in this repair' });
  }

  // Use provided removal_date or default to today
  const removalDate = removal_date || new Date().toISOString().split('T')[0];

  const newRemovedPart: RemovedPart = {
    removed_part_id: removedPartNextId++,
    repair_id: repairId,
    event_id: repair.event_id,
    asset_id: asset.asset_id,
    asset_sn: asset.serno,
    asset_pn: asset.partno,
    asset_name: asset.name,
    removal_date: removalDate,
    removal_reason: removal_reason || null,
    removal_notes: removal_notes || null,
    new_status: new_status || null,
    removed_by: user.user_id,
    removed_by_name: `${user.first_name} ${user.last_name}`,
    created_at: new Date().toISOString(),
  };

  removedParts.push(newRemovedPart);

  // Optionally update the removed part's asset status if new_status is provided
  if (new_status) {
    const assetIndex = mockAssets.findIndex(a => a.asset_id === asset_id);
    if (assetIndex !== -1) {
      const oldStatus = mockAssets[assetIndex].status_cd;
      mockAssets[assetIndex].status_cd = new_status;
      await prisma.asset.update({ where: { asset_id: asset_id }, data: { status_cd: new_status, chg_by: user.username, chg_date: new Date() } }).catch(e => console.error('[REMOVED_PARTS] DB update failed:', e));
      await refreshAssetInMemory(asset_id).catch(() => {});
      console.log(`[REMOVED_PARTS] Updated removed asset ${asset.serno} status from ${oldStatus} to ${new_status}`);
    }
  }

  // AUTO-STATUS UPDATE: When a part is removed from a repair, check if the parent asset
  // (the one being repaired) should have its status changed to NMCM
  // This implements the business rule: "Removing parts triggers status update to NMCM"
  const parentAsset = mockAssets.find(a => a.asset_id === event.asset_id);
  const parentDetailedAsset = detailedAssets.find(a => a.asset_id === event.asset_id);
  let statusChanged = false;
  let oldParentStatus = '';

  // Check status from detailedAssets (primary source) or mockAssets (fallback)
  const currentStatus = parentDetailedAsset?.status_cd || parentAsset?.status_cd;

  if (currentStatus === 'FMC') {
    // Parent asset is FMC - removing a part means it's now in maintenance
    oldParentStatus = 'FMC';

    // Update both mockAssets and detailedAssets to ensure consistency
    if (parentAsset) {
      parentAsset.status_cd = 'NMCM';
    }
    if (parentDetailedAsset) {
      parentDetailedAsset.status_cd = 'NMCM';
    }
    statusChanged = true;

    const assetSerno = parentDetailedAsset?.serno || parentAsset?.serno || 'Unknown';
    const assetId = parentDetailedAsset?.asset_id || parentAsset?.asset_id || event.asset_id;
    const pgmId = parentDetailedAsset?.pgm_id || parentAsset?.pgm_id || event.pgm_id;

    console.log(`[REMOVED_PARTS] AUTO-STATUS: Parent asset ${assetSerno} status changed from FMC to NMCM due to part removal`);

    // Add to activity log (audit trail) for the automatic status change
    const now = new Date();
    const statusChangeActivity: ActivityLogEntry = {
      activity_id: 1000 + dynamicActivityLog.length + 1,
      timestamp: now.toISOString(),
      user_id: user.user_id,
      username: user.username,
      user_full_name: `${user.first_name} ${user.last_name}`,
      action_type: 'status_change',
      entity_type: 'asset',
      entity_id: assetId,
      entity_name: assetSerno,
      description: `Auto-status change: ${assetSerno} changed from FMC to NMCM due to part removal (${asset.serno}) in repair #${repairId}`,
      pgm_id: pgmId,
    };
    dynamicActivityLog.push(statusChangeActivity);
  }

  console.log(`[REMOVED_PARTS] Added removed part ${newRemovedPart.removed_part_id} (asset ${asset.serno}) to repair ${repairId} by ${user.username}`);

  // Build response with optional status change info
  const response: any = {
    message: 'Removed part recorded successfully',
    removed_part: newRemovedPart,
  };

  // Include status change info if the parent asset status was updated
  if (statusChanged) {
    const assetSerno = parentDetailedAsset?.serno || parentAsset?.serno || 'Unknown';
    const assetIdForResponse = parentDetailedAsset?.asset_id || parentAsset?.asset_id || event.asset_id;
    response.status_change = {
      asset_id: assetIdForResponse,
      asset_sn: assetSerno,
      old_status: oldParentStatus,
      new_status: 'NMCM',
      message: `Asset ${assetSerno} status automatically changed from ${oldParentStatus} to NMCM due to part removal`,
    };
  }

  res.status(201).json(response);
});

// Delete a removed part record
app.delete('/api/removed-parts/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can delete
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to delete removed parts.' });
  }

  const removedPartId = parseInt(req.params.id, 10);
  const removedPartIndex = removedParts.findIndex(rp => rp.removed_part_id === removedPartId);

  if (removedPartIndex === -1) {
    return res.status(404).json({ error: 'Removed part record not found' });
  }

  const removedPart = removedParts[removedPartIndex];

  // Get the associated repair
  const repair = repairs.find(r => r.repair_id === removedPart.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Associated repair not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this removed part' });
  }

  // Cannot delete removed parts from repairs in closed events
  if (event.status === 'closed') {
    return res.status(400).json({ error: 'Cannot delete removed parts from repairs in closed maintenance events' });
  }

  // Cannot delete removed parts from closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot delete removed parts from closed repairs' });
  }

  const deletedInfo = {
    removed_part_id: removedPart.removed_part_id,
    asset_sn: removedPart.asset_sn,
    repair_id: removedPart.repair_id,
  };

  // Remove the removed part record
  removedParts.splice(removedPartIndex, 1);

  console.log(`[REMOVED_PARTS] Deleted removed part ${removedPartId} (asset ${removedPart.asset_sn}) from repair ${removedPart.repair_id} by ${user.username}`);

  res.json({
    message: 'Removed part record deleted successfully',
    removed_part: deletedInfo,
  });
});

// Search assets for removal (within the same program)
app.get('/api/events/:eventId/removable-assets', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const eventId = parseInt(req.params.eventId, 10);
  const event = maintenanceEvents.find(e => e.event_id === eventId);

  if (!event) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this maintenance event' });
  }

  const searchQuery = (req.query.search as string || '').toLowerCase().trim() || null;

  // Get all assets from the same program (including the event's primary asset - it could be a subcomponent)
  let removableAssets = mockAssets.filter(a => a.pgm_id === event.pgm_id && a.active);

  // Apply search filter if provided
  if (searchQuery) {
    removableAssets = removableAssets.filter(a =>
      a.serno.toLowerCase().includes(searchQuery) ||
      a.partno.toLowerCase().includes(searchQuery) ||
      a.name.toLowerCase().includes(searchQuery)
    );
  }

  // Limit results
  const limit = parseInt(req.query.limit as string, 10) || 20;
  removableAssets = removableAssets.slice(0, limit);

  console.log(`[REMOVED_PARTS] Asset search for event ${event.job_no} by ${user.username} - found ${removableAssets.length} results`);

  res.json({
    assets: removableAssets.map(a => ({
      asset_id: a.asset_id,
      serno: a.serno,
      partno: a.partno,
      name: a.name,
      status_cd: a.status_cd,
      admin_loc: a.admin_loc,
    })),
    total: removableAssets.length,
  });
});

// ============================================
// LABOR RECORD ENDPOINTS
// ============================================
// Get labor records for a repair
app.get('/api/repairs/:repairId/labor', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const repairId = parseInt(req.params.repairId, 10);
    const repair = await maintenanceData.getRepairById(repairId);

    if (!repair) {
      return res.status(404).json({ error: 'Repair not found' });
    }

    // Get associated event for program access check
    const event = await maintenanceData.getEventById(repair.event_id);
    if (!event) {
      return res.status(404).json({ error: 'Associated maintenance event not found' });
    }

    // Check if user has access to this event's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(event.pgm_id)) {
      return res.status(403).json({ error: 'Access denied to this repair' });
    }

    // Check if user has access to this event's location (unless ADMIN)
    const userLocationIds = user.locations.map(l => l.loc_id);
    if (user.role !== 'ADMIN' && event.loc_id && userLocationIds.length > 0 && !userLocationIds.includes(event.loc_id)) {
      return res.status(403).json({ error: 'Access denied to labor at this location' });
    }

    // Get labor records from database
    const repairLabor = await maintenanceData.getLaborForRepair(repairId);

    // Calculate summary
    const summary = {
      total: repairLabor.length,
      total_hours: repairLabor.reduce((sum, l) => sum + (l.hours || 0), 0),
    };

    console.log(`[LABOR-DB] Fetched ${repairLabor.length} labor records for repair ${repairId} by ${user.username}`);

    res.json({
      labor: repairLabor,
      summary,
    });
  } catch (error) {
    console.error('[LABOR] Error fetching labor records:', error);
    res.status(500).json({ error: 'Failed to fetch labor records' });
  }
});

// Get single labor record by ID
app.get('/api/labor/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const laborId = parseInt(req.params.id, 10);
  const labor = laborRecords.find(l => l.labor_id === laborId);

  if (!labor) {
    return res.status(404).json({ error: 'Labor record not found' });
  }

  // Get associated repair and event for program access check
  const repair = repairs.find(r => r.repair_id === labor.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Associated repair not found' });
  }

  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this labor record' });
  }

  // Check if user has access to this event's location
  const userLocationIds = user.locations.map(l => l.loc_id);
  if (!userLocationIds.includes(event.loc_id)) {
    return res.status(403).json({ error: 'Access denied to labor at this location' });
  }

  res.json(labor);
});
// Create a new labor record for a repair
app.post('/api/repairs/:repairId/labor', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can create labor
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to create labor records.' });
  }

  try {
    const repairId = parseInt(req.params.repairId, 10);
    const repair = await maintenanceData.getRepairById(repairId);

    if (!repair) {
      return res.status(404).json({ error: 'Repair not found' });
    }

    // Get associated event for program access check
    const event = await maintenanceData.getEventById(repair.event_id);
    if (!event) {
      return res.status(404).json({ error: 'Associated maintenance event not found' });
    }

    // Check if user has access to this event's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(event.pgm_id)) {
      return res.status(403).json({ error: 'Access denied to this repair' });
    }

    // Cannot add labor to closed repairs
    if (repair.shop_status === 'closed') {
      return res.status(400).json({ error: 'Cannot add labor records to a closed repair' });
    }

    const {
      action_taken,
      how_mal,
      when_disc,
      type_maint,
      cat_labor,
      start_date,
      stop_date,
      hours,
      crew_chief,
      crew_size,
      corrective,
      discrepancy,
      remarks,
      corrected_by,
      inspected_by,
      bit_log,
    } = req.body;

    // Validate required fields
    if (!crew_chief) {
      return res.status(400).json({ error: 'Crew chief name is required' });
    }

    // Corrective action narrative is required
    if (!corrective || !corrective.trim()) {
      return res.status(400).json({ error: 'Corrective action narrative is required' });
    }

    // Validate stop_date if provided
    const laborStartDate = start_date || new Date().toISOString().split('T')[0];
    if (stop_date) {
      const startDateObj = new Date(laborStartDate);
      const stopDateObj = new Date(stop_date);
      if (stopDateObj < startDateObj) {
        return res.status(400).json({ error: 'Stop time cannot be before start time' });
      }
    }

    // Create labor record in database
    const newLabor = await maintenanceData.createLabor({
      repair_id: repairId,
      asset_id: repair.asset_id,
      action_taken: action_taken || null,
      how_mal: how_mal || null,
      when_disc: when_disc || null,
      type_maint: type_maint || null,
      cat_labor: cat_labor || null,
      start_date: laborStartDate,
      crew_chief: crew_chief,
      crew_size: crew_size !== undefined && crew_size !== null && crew_size !== '' ? parseInt(crew_size, 10) : null,
      corrective: corrective || null,
      discrepancy: discrepancy || null,
      remarks: remarks || null,
      ins_by: user.username,
    });

    // Update stop_date and hours if provided (separate update since createLabor doesn't handle these)
    if (stop_date || hours !== undefined) {
      await maintenanceData.updateLabor(newLabor.labor_id, {
        stop_date: stop_date || null,
        hours: hours !== undefined && hours !== null && hours !== '' ? parseFloat(hours) : null,
        corrected_by: corrected_by || null,
        inspected_by: inspected_by || null,
        bit_log: bit_log || null,
        chg_by: user.username,
      });
    }

    // Fetch the final labor record
    const finalLabor = await maintenanceData.getLaborById(newLabor.labor_id);

    console.log(`[LABOR-DB] Created labor ${newLabor.labor_id} for repair ${repairId} by ${user.username}`);

    res.status(201).json({
      message: 'Labor record created successfully',
      labor: finalLabor,
    });
  } catch (error) {
    console.error('[LABOR] Error creating labor record:', error);
    res.status(500).json({ error: 'Failed to create labor record' });
  }
});

// Update a labor record
app.put('/api/labor/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to update labor records.' });
  }

  const laborId = parseInt(req.params.id, 10);
  const laborIndex = laborRecords.findIndex(l => l.labor_id === laborId);

  if (laborIndex === -1) {
    return res.status(404).json({ error: 'Labor record not found' });
  }

  const labor = laborRecords[laborIndex];

  // Get associated repair for access check
  const repair = repairs.find(r => r.repair_id === labor.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Associated repair not found' });
  }

  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this labor record' });
  }

  // Cannot update labor on closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot update labor records on a closed repair' });
  }

  const {
    action_taken,
    how_mal,
    when_disc,
    type_maint,
    cat_labor,
    start_date,
    stop_date,
    hours,
    crew_chief,
    crew_size,
    corrective,
    discrepancy,
    remarks,
    corrected_by,
    inspected_by,
    bit_log,
  } = req.body;

  // Validate corrective action is provided if it's being updated or if the record doesn't have one
  if (corrective !== undefined && (!corrective || !corrective.trim())) {
    return res.status(400).json({ error: 'Corrective action narrative is required' });
  }

  // Update fields if provided
  if (action_taken !== undefined) laborRecords[laborIndex].action_taken = action_taken || null;
  if (how_mal !== undefined) laborRecords[laborIndex].how_mal = how_mal || null;
  if (when_disc !== undefined) laborRecords[laborIndex].when_disc = when_disc || null;
  if (type_maint !== undefined) laborRecords[laborIndex].type_maint = type_maint || null;
  if (cat_labor !== undefined) laborRecords[laborIndex].cat_labor = cat_labor || null;
  if (start_date !== undefined) laborRecords[laborIndex].start_date = start_date;
  if (stop_date !== undefined) laborRecords[laborIndex].stop_date = stop_date || null;
  if (hours !== undefined) laborRecords[laborIndex].hours = hours !== null && hours !== '' ? parseFloat(hours) : null;
  if (crew_chief !== undefined) laborRecords[laborIndex].crew_chief = crew_chief || null;
  if (crew_size !== undefined) laborRecords[laborIndex].crew_size = crew_size !== null && crew_size !== '' ? parseInt(crew_size, 10) : null;
  if (corrective !== undefined) laborRecords[laborIndex].corrective = corrective || null;
  if (discrepancy !== undefined) laborRecords[laborIndex].discrepancy = discrepancy || null;
  if (remarks !== undefined) laborRecords[laborIndex].remarks = remarks || null;
  if (corrected_by !== undefined) laborRecords[laborIndex].corrected_by = corrected_by || null;
  if (inspected_by !== undefined) laborRecords[laborIndex].inspected_by = inspected_by || null;
  if (bit_log !== undefined) laborRecords[laborIndex].bit_log = bit_log || null;

  // Validate stop_date if provided
  if (stop_date && laborRecords[laborIndex].start_date) {
    const startDateObj = new Date(laborRecords[laborIndex].start_date);
    const stopDateObj = new Date(stop_date);
    if (stopDateObj < startDateObj) {
      return res.status(400).json({ error: 'Stop time cannot be before start time' });
    }
  }

  console.log(`[LABOR] Updated labor ${laborId} by ${user.username}`);

  res.json({
    message: 'Labor record updated successfully',
    labor: laborRecords[laborIndex],
  });
});

// Delete a labor record
app.delete('/api/labor/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN and DEPOT_MANAGER can delete labor records
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. Only administrators and depot managers can delete labor records.' });
  }

  const laborId = parseInt(req.params.id, 10);
  const laborIndex = laborRecords.findIndex(l => l.labor_id === laborId);

  if (laborIndex === -1) {
    return res.status(404).json({ error: 'Labor record not found' });
  }

  const labor = laborRecords[laborIndex];

  // Get the associated repair for access check
  const repair = repairs.find(r => r.repair_id === labor.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Associated repair not found' });
  }

  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this labor record' });
  }

  // Cannot delete labor from closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot delete labor records from a closed repair' });
  }

  const deletedInfo = {
    labor_id: labor.labor_id,
    labor_seq: labor.labor_seq,
    repair_id: labor.repair_id,
  };

  // Remove the labor record
  laborRecords.splice(laborIndex, 1);

  console.log(`[LABOR] Deleted labor ${laborId} (seq ${labor.labor_seq}) from repair ${labor.repair_id} by ${user.username}`);

  res.json({
    message: 'Labor record deleted successfully',
    labor: deletedInfo,
  });
});

// ============================================
// LABOR PARTS ENDPOINTS
// ============================================

// LaborPart interface for tracking parts worked on, removed, installed within labor
interface LaborPart {
  labor_part_id: number;
  labor_id: number;
  asset_id: number | null;
  partno_id: number | null;
  partno: string | null;
  part_name: string | null;
  serial_number: string | null;
  part_action: 'WORKED' | 'REMOVED' | 'INSTALLED';
  qty: number;
  created_by: number;
  created_by_name: string;
  created_at: string;
}

// Persistent storage for labor parts
let laborParts: LaborPart[] = [];
let laborPartNextId = 1;

// Initialize labor parts with sample data
function initializeLaborParts(): void {
  laborParts = [
    {
      labor_part_id: 1,
      labor_id: 1,
      asset_id: null,
      partno_id: 9,
      partno: 'PN-POWER-MOD',
      part_name: 'Power Module',
      serial_number: null,
      part_action: 'WORKED',
      qty: 1,
      created_by: 3,
      created_by_name: 'Bob Field',
      created_at: new Date().toISOString().split('T')[0],
    },
    {
      labor_part_id: 2,
      labor_id: 1,
      asset_id: null,
      partno_id: 8,
      partno: 'PN-COMM-SYS',
      part_name: 'Communication System',
      serial_number: 'SN-CONN-001',
      part_action: 'REMOVED',
      qty: 1,
      created_by: 3,
      created_by_name: 'Bob Field',
      created_at: new Date().toISOString().split('T')[0],
    },
    {
      labor_part_id: 3,
      labor_id: 1,
      asset_id: null,
      partno_id: 8,
      partno: 'PN-COMM-SYS',
      part_name: 'Communication System',
      serial_number: 'SN-CONN-002',
      part_action: 'INSTALLED',
      qty: 1,
      created_by: 3,
      created_by_name: 'Bob Field',
      created_at: new Date().toISOString().split('T')[0],
    },
  ];
  laborPartNextId = 4;
}

// Initialize labor parts on server start
initializeLaborParts();

// Get labor parts for a specific labor record
app.get('/api/labor/:laborId/parts', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const laborId = parseInt(req.params.laborId, 10);
  const labor = laborRecords.find(l => l.labor_id === laborId);

  if (!labor) {
    return res.status(404).json({ error: 'Labor record not found' });
  }

  // Find the repair and event to check program access
  const repair = repairs.find(r => r.repair_id === labor.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this labor record' });
  }

  // Get labor parts for this labor record
  const parts = laborParts.filter(lp => lp.labor_id === laborId);

  // Categorize by action
  const worked = parts.filter(p => p.part_action === 'WORKED');
  const removed = parts.filter(p => p.part_action === 'REMOVED');
  const installed = parts.filter(p => p.part_action === 'INSTALLED');

  console.log(`[LABOR_PARTS] Fetched ${parts.length} parts for labor ${laborId} by ${user.username}`);

  res.json({
    parts,
    summary: {
      worked: worked.length,
      removed: removed.length,
      installed: installed.length,
      total: parts.length,
    },
  });
});

// Add a part to a labor record
app.post('/api/labor/:laborId/parts', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to add parts to labor records.' });
  }

  const laborId = parseInt(req.params.laborId, 10);
  const labor = laborRecords.find(l => l.labor_id === laborId);

  if (!labor) {
    return res.status(404).json({ error: 'Labor record not found' });
  }

  // Find the repair and event to check program access and status
  const repair = repairs.find(r => r.repair_id === labor.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this labor record' });
  }

  // Cannot add parts to closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot add parts to a closed repair' });
  }

  const { part_action, partno, part_name, serial_number, qty, partno_id, asset_id } = req.body;

  // Validate part_action
  const validActions = ['WORKED', 'REMOVED', 'INSTALLED'];
  if (!part_action || !validActions.includes(part_action)) {
    return res.status(400).json({ error: 'Invalid part action. Must be WORKED, REMOVED, or INSTALLED.' });
  }

  // Validate required fields
  if (!partno && !part_name) {
    return res.status(400).json({ error: 'Part number or part name is required.' });
  }

  const newLaborPart: LaborPart = {
    labor_part_id: laborPartNextId++,
    labor_id: laborId,
    asset_id: asset_id || null,
    partno_id: partno_id || null,
    partno: partno || null,
    part_name: part_name || null,
    serial_number: serial_number || null,
    part_action,
    qty: qty || 1,
    created_by: user.user_id,
    created_by_name: `${user.first_name} ${user.last_name}`,
    created_at: new Date().toISOString().split('T')[0],
  };

  laborParts.push(newLaborPart);

  console.log(`[LABOR_PARTS] Added ${part_action} part "${partno || part_name}" to labor ${laborId} by ${user.username}`);

  // Auto-PMI creation for ECU part actions
  let autoPMICreated: PMIRecord | null = null;
  const partNameLower = (part_name || '').toLowerCase();
  const partnoLower = (partno || '').toLowerCase();
  const isECUPart = partNameLower.includes('ecu') || partnoLower.includes('ecu');

  if (isECUPart) {
    // Get the asset from the maintenance event to create the PMI for
    const eventAsset = detailedAssets.find(a => a.asset_id === event.asset_id);

    if (eventAsset) {
      // Calculate due date (30 days from today for ECU inspection)
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);
      const dueDateStr = dueDate.toISOString().split('T')[0];
      const daysUntilDue = 30;

      // Create auto-PMI for ECU part action
      const autoPMI: PMIRecord = {
        pmi_id: nextCustomPMIId++,
        asset_id: eventAsset.asset_id,
        asset_sn: eventAsset.serno,
        asset_name: eventAsset.part_name || eventAsset.partno || 'Unknown',
        pmi_type: `ECU Post-Action Inspection (${part_action})`,
        wuc_cd: eventAsset.partno?.substring(0, 5) || '',
        next_due_date: dueDateStr,
        days_until_due: daysUntilDue,
        completed_date: null,
        pgm_id: eventAsset.pgm_id,
        status: 'upcoming',
        interval_days: 30,
      };

      customPMIRecords.push(autoPMI);
      autoPMICreated = autoPMI;

      console.log(`[PMI] Auto-created PMI #${autoPMI.pmi_id} for ECU part action - Asset: ${eventAsset.serno}, Due: ${dueDateStr}`);
    }
  }

  res.status(201).json({
    message: `Part ${part_action.toLowerCase()} added successfully${autoPMICreated ? '. Auto-PMI created for ECU part action.' : ''}`,
    part: newLaborPart,
    auto_pmi: autoPMICreated,
  });
});

// Update a labor part
app.put('/api/labor-parts/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to update labor parts.' });
  }

  const partId = parseInt(req.params.id, 10);
  const partIndex = laborParts.findIndex(lp => lp.labor_part_id === partId);

  if (partIndex === -1) {
    return res.status(404).json({ error: 'Labor part not found' });
  }

  const laborPart = laborParts[partIndex];
  const labor = laborRecords.find(l => l.labor_id === laborPart.labor_id);

  if (!labor) {
    return res.status(404).json({ error: 'Labor record not found' });
  }

  // Find the repair and event to check program access and status
  const repair = repairs.find(r => r.repair_id === labor.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this labor part' });
  }

  // Cannot update parts on closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot update parts on a closed repair' });
  }

  const { part_action, partno, part_name, serial_number, qty, partno_id, asset_id } = req.body;

  // Update fields
  if (part_action !== undefined) {
    const validActions = ['WORKED', 'REMOVED', 'INSTALLED'];
    if (!validActions.includes(part_action)) {
      return res.status(400).json({ error: 'Invalid part action. Must be WORKED, REMOVED, or INSTALLED.' });
    }
    laborParts[partIndex].part_action = part_action;
  }
  if (partno !== undefined) laborParts[partIndex].partno = partno || null;
  if (part_name !== undefined) laborParts[partIndex].part_name = part_name || null;
  if (serial_number !== undefined) laborParts[partIndex].serial_number = serial_number || null;
  if (qty !== undefined) laborParts[partIndex].qty = qty || 1;
  if (partno_id !== undefined) laborParts[partIndex].partno_id = partno_id || null;
  if (asset_id !== undefined) laborParts[partIndex].asset_id = asset_id || null;

  console.log(`[LABOR_PARTS] Updated part ${partId} on labor ${laborPart.labor_id} by ${user.username}`);

  res.json({
    message: 'Labor part updated successfully',
    part: laborParts[partIndex],
  });
});

// Delete a labor part
app.delete('/api/labor-parts/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN and DEPOT_MANAGER can delete
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. Only administrators and depot managers can delete labor parts.' });
  }

  const partId = parseInt(req.params.id, 10);
  const partIndex = laborParts.findIndex(lp => lp.labor_part_id === partId);

  if (partIndex === -1) {
    return res.status(404).json({ error: 'Labor part not found' });
  }

  const laborPart = laborParts[partIndex];
  const labor = laborRecords.find(l => l.labor_id === laborPart.labor_id);

  if (!labor) {
    return res.status(404).json({ error: 'Labor record not found' });
  }

  // Find the repair and event to check program access and status
  const repair = repairs.find(r => r.repair_id === labor.repair_id);
  if (!repair) {
    return res.status(404).json({ error: 'Repair not found' });
  }

  const event = maintenanceEvents.find(e => e.event_id === repair.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this labor part' });
  }

  // Cannot delete parts from closed repairs
  if (repair.shop_status === 'closed') {
    return res.status(400).json({ error: 'Cannot delete parts from a closed repair' });
  }

  const deletedPart = laborParts[partIndex];
  laborParts.splice(partIndex, 1);

  console.log(`[LABOR_PARTS] Deleted ${deletedPart.part_action} part "${deletedPart.partno || deletedPart.part_name}" from labor ${laborPart.labor_id} by ${user.username}`);

  res.json({
    message: 'Labor part deleted successfully',
    part: deletedPart,
  });
});

// ============================================
// ATTACHMENT ENDPOINTS
// ============================================

// Get attachments for a maintenance event
app.get('/api/events/:eventId/attachments', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const eventId = parseInt(req.params.eventId, 10);
  const event = maintenanceEvents.find(e => e.event_id === eventId);

  if (!event) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this maintenance event' });
  }

  // Get attachments for this event
  const eventAttachments = attachments.filter(a => a.event_id === eventId);

  console.log(`[ATTACHMENTS] Fetched ${eventAttachments.length} attachments for event ${event.job_no} by ${user.username}`);

  res.json({
    attachments: eventAttachments,
    total: eventAttachments.length,
  });
});

// Upload attachment to a maintenance event
app.post('/api/events/:eventId/attachments', (req, res) => {
  // Wrap multer middleware to handle errors properly
  upload.single('file')(req, res, (err) => {
    // Handle multer errors (file size, file type, etc.)
    if (err) {
      if (err.message.includes('Invalid file type')) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message.includes('File too large') || err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds 10MB limit' });
      }
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }

    const payload = authenticateRequest(req, res);
    if (!payload) return;

    const user = mockUsers.find(u => u.user_id === payload.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Check role permissions - only ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can upload
    const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: 'Access denied. You do not have permission to upload attachments.' });
    }

    const eventId = parseInt(req.params.eventId, 10);
    const event = maintenanceEvents.find(e => e.event_id === eventId);

    if (!event) {
      return res.status(404).json({ error: 'Maintenance event not found' });
    }

    // Check if user has access to this event's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(event.pgm_id)) {
      return res.status(403).json({ error: 'Access denied to this maintenance event' });
    }

    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

  const { description } = req.body;

  const newAttachment: Attachment = {
    attachment_id: attachmentNextId++,
    event_id: eventId,
    filename: req.file.filename,
    original_filename: req.file.originalname,
    file_path: req.file.path,
    file_size: req.file.size,
    mime_type: req.file.mimetype,
    uploaded_by: user.user_id,
    uploaded_by_name: `${user.first_name} ${user.last_name}`,
    uploaded_at: new Date().toISOString(),
    description: description || null,
  };

    attachments.push(newAttachment);

    console.log(`[ATTACHMENTS] Uploaded attachment ${newAttachment.attachment_id} (${newAttachment.original_filename}) for event ${event.job_no} by ${user.username}`);

    res.status(201).json({
      message: 'Attachment uploaded successfully',
      attachment: newAttachment,
    });
  });
});

// Download/serve an attachment
app.get('/api/attachments/:id/download', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const attachmentId = parseInt(req.params.id, 10);
  const attachment = attachments.find(a => a.attachment_id === attachmentId);

  if (!attachment) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === attachment.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this attachment' });
  }

  // Check if file exists
  if (!fs.existsSync(attachment.file_path)) {
    return res.status(404).json({ error: 'File not found on server' });
  }

  console.log(`[ATTACHMENTS] Serving attachment ${attachmentId} (${attachment.original_filename}) to ${user.username}`);

  // Set appropriate headers for download
  res.setHeader('Content-Type', attachment.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${attachment.original_filename}"`);
  res.setHeader('Content-Length', attachment.file_size);

  // Stream the file
  const fileStream = fs.createReadStream(attachment.file_path);
  fileStream.pipe(res);
});

// Serve attachment for inline viewing (images)
app.get('/api/attachments/:id/view', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const attachmentId = parseInt(req.params.id, 10);
  const attachment = attachments.find(a => a.attachment_id === attachmentId);

  if (!attachment) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === attachment.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this attachment' });
  }

  // Check if file exists
  if (!fs.existsSync(attachment.file_path)) {
    return res.status(404).json({ error: 'File not found on server' });
  }

  console.log(`[ATTACHMENTS] Viewing attachment ${attachmentId} (${attachment.original_filename}) by ${user.username}`);

  // Set appropriate headers for inline viewing
  res.setHeader('Content-Type', attachment.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${attachment.original_filename}"`);
  res.setHeader('Content-Length', attachment.file_size);

  // Stream the file
  const fileStream = fs.createReadStream(attachment.file_path);
  fileStream.pipe(res);
});

// Delete an attachment
app.delete('/api/attachments/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN, DEPOT_MANAGER can delete (or the user who uploaded)
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER'];

  const attachmentId = parseInt(req.params.id, 10);
  const attachmentIndex = attachments.findIndex(a => a.attachment_id === attachmentId);

  if (attachmentIndex === -1) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const attachment = attachments[attachmentIndex];

  // Allow delete if: admin, depot_manager, or the uploader
  if (!allowedRoles.includes(user.role) && attachment.uploaded_by !== user.user_id) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to delete this attachment.' });
  }

  // Get the associated event to check program access
  const event = maintenanceEvents.find(e => e.event_id === attachment.event_id);
  if (!event) {
    return res.status(404).json({ error: 'Associated maintenance event not found' });
  }

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this attachment' });
  }

  // Delete the file from disk
  if (fs.existsSync(attachment.file_path)) {
    fs.unlinkSync(attachment.file_path);
  }

  // Remove from array
  attachments.splice(attachmentIndex, 1);

  console.log(`[ATTACHMENTS] Deleted attachment ${attachmentId} (${attachment.original_filename}) by ${user.username}`);

  res.json({
    message: 'Attachment deleted successfully',
    deleted_attachment: {
      attachment_id: attachment.attachment_id,
      original_filename: attachment.original_filename,
    },
  });
});

// Close a maintenance event with validation
app.post('/api/events/:id/close', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions
  const allowedRoles = ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Access denied. You do not have permission to close maintenance events.' });
  }

  const eventId = parseInt(req.params.id, 10);
  const eventIndex = maintenanceEvents.findIndex(e => e.event_id === eventId);

  if (eventIndex === -1) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  const event = maintenanceEvents[eventIndex];

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this maintenance event' });
  }

  // Check if event is already closed
  if (event.status === 'closed') {
    return res.status(400).json({ error: 'This maintenance event is already closed' });
  }

  // Check if all repairs are closed
  const eventRepairs = repairs.filter(r => r.event_id === eventId);
  const openRepairs = eventRepairs.filter(r => r.shop_status === 'open');

  if (openRepairs.length > 0) {
    return res.status(400).json({
      error: `Cannot close event: ${openRepairs.length} repair(s) are still open. All repairs must be closed before closing the maintenance event.`,
      open_repairs: openRepairs.map(r => ({
        repair_id: r.repair_id,
        repair_seq: r.repair_seq,
        narrative: r.narrative.substring(0, 50) + (r.narrative.length > 50 ? '...' : ''),
      })),
    });
  }

  // Get stop_job from request or default to today
  const { stop_job } = req.body;
  const closingDate = stop_job || new Date().toISOString().split('T')[0];

  // Close the event
  maintenanceEvents[eventIndex].status = 'closed';
  maintenanceEvents[eventIndex].stop_job = closingDate;

  console.log(`[EVENTS] Closed maintenance event ${event.job_no} by ${user.username}`);

  res.json({
    message: 'Maintenance event closed successfully',
    event: maintenanceEvents[eventIndex],
  });
});

// Delete a maintenance event (ADMIN only)
app.delete('/api/events/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions - only ADMIN can delete events
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied. Only administrators can delete maintenance events.' });
  }

  const eventId = parseInt(req.params.id, 10);
  const eventIndex = maintenanceEvents.findIndex(e => e.event_id === eventId);

  if (eventIndex === -1) {
    return res.status(404).json({ error: 'Maintenance event not found' });
  }

  const event = maintenanceEvents[eventIndex];

  // Check if user has access to this event's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(event.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this maintenance event' });
  }

  // Check for related repairs
  const eventRepairs = repairs.filter(r => r.event_id === eventId);

  if (eventRepairs.length > 0) {
    // Cascade delete: remove all repairs associated with this event
    const repairIds = eventRepairs.map(r => r.repair_id);
    for (const repairId of repairIds) {
      const repairIndex = repairs.findIndex(r => r.repair_id === repairId);
      if (repairIndex !== -1) {
        repairs.splice(repairIndex, 1);
      }
    }
    console.log(`[EVENTS] Cascade deleted ${eventRepairs.length} repairs for event ${event.job_no}`);
  }

  // Remove the event
  const deletedEvent = maintenanceEvents.splice(eventIndex, 1)[0];
    // Also delete from DB
    await prisma.event.delete({ where: { event_id: deletedEvent.event_id } }).catch(e => console.error('[EVENT] DB delete failed:', e));

  console.log(`[EVENTS] Deleted maintenance event ${event.job_no} by ${user.username}`);

  res.json({
    message: 'Maintenance event deleted successfully',
    event: {
      event_id: deletedEvent.event_id,
      job_no: deletedEvent.job_no,
      asset_sn: deletedEvent.asset_sn,
      asset_name: deletedEvent.asset_name,
    },
    repairs_deleted: eventRepairs.length,
  });
});

// Get single PMI by ID
app.get('/api/pmi/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const pmiId = parseInt(req.params.id, 10);

  // Check both generated and custom PMI records
  const generatedPMI = generateMockPMIData();
  let pmi = generatedPMI.find(p => p.pmi_id === pmiId);

  // If not in generated, check custom records
  if (!pmi) {
    pmi = customPMIRecords.find(p => p.pmi_id === pmiId);
  }

  if (!pmi) {
    return res.status(404).json({ error: 'PMI record not found' });
  }

  // Update days_until_due dynamically
  const daysUntilDue = calculateDaysUntilDue(pmi.next_due_date);
  const updatedPmi = {
    ...pmi,
    days_until_due: daysUntilDue,
    status: pmi.completed_date ? 'completed' as const : getPMIStatus(daysUntilDue),
  };

  // Check if user has access to this PMI's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(updatedPmi.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this PMI record' });
  }

  res.json({ pmi: updatedPmi });
});

// Update PMI record
app.put('/api/pmi/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check permissions - only depot_manager and admin can edit PMI
  if (!['DEPOT_MANAGER', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Only depot managers and admins can edit PMI records' });
  }

  const pmiId = parseInt(req.params.id, 10);
  const { pmi_type, next_due_date, wuc_cd, completed_date } = req.body;

  // Check both generated and custom PMI records
  const generatedPMI = generateMockPMIData();
  let pmi = generatedPMI.find(p => p.pmi_id === pmiId);
  let isCustom = false;
  let customIndex = -1;

  // If not in generated, check custom records
  if (!pmi) {
    customIndex = customPMIRecords.findIndex(p => p.pmi_id === pmiId);
    if (customIndex !== -1) {
      pmi = customPMIRecords[customIndex];
      isCustom = true;
    }
  }

  if (!pmi) {
    return res.status(404).json({ error: 'PMI record not found' });
  }

  // Check if user has access to this PMI's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(pmi.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this PMI record' });
  }

  // Validate fields if provided
  if (pmi_type !== undefined && pmi_type.trim() === '') {
    return res.status(400).json({ error: 'PMI type cannot be empty' });
  }

  // Calculate new days until due if date changed
  const newDueDate = next_due_date || pmi.next_due_date;
  const daysUntilDue = calculateDaysUntilDue(newDueDate);

  // Create updated PMI record
  const updatedPMI: PMIRecord = {
    ...pmi,
    pmi_type: pmi_type !== undefined ? pmi_type.trim() : pmi.pmi_type,
    next_due_date: newDueDate,
    wuc_cd: wuc_cd !== undefined ? (wuc_cd?.trim() || '') : pmi.wuc_cd,
    completed_date: completed_date !== undefined ? completed_date : pmi.completed_date,
    days_until_due: daysUntilDue,
    status: (completed_date !== undefined ? completed_date : pmi.completed_date)
      ? 'completed' as const
      : getPMIStatus(daysUntilDue),
  };

  // For generated PMI records, we need to store the modifications
  // We'll add/update in customPMIRecords as an override
  if (isCustom) {
    customPMIRecords[customIndex] = updatedPMI;
  } else {
    // For generated PMI, add to custom records as override (remove any existing override first)
    const existingOverrideIndex = customPMIRecords.findIndex(p => p.pmi_id === pmiId);
    if (existingOverrideIndex !== -1) {
      customPMIRecords[existingOverrideIndex] = updatedPMI;
    } else {
      customPMIRecords.push(updatedPMI);
    }
  }

  console.log(`[PMI] Updated PMI #${updatedPMI.pmi_id} by ${user.username} - Type: ${updatedPMI.pmi_type}, Due: ${updatedPMI.next_due_date}`);

  res.json({
    message: 'PMI record updated successfully',
    pmi: updatedPMI,
  });
});

// Complete PMI - marks as completed and schedules next occurrence
app.post('/api/pmi/:id/complete', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Field technicians can complete PMI (they do the work)
  if (!['FIELD_TECHNICIAN', 'DEPOT_MANAGER', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Only field technicians, depot managers, and admins can complete PMI records' });
  }

  const pmiId = parseInt(req.params.id, 10);
  const { completion_date, linked_event_id } = req.body;

  // Validate completion date
  if (!completion_date) {
    return res.status(400).json({ error: 'Completion date is required' });
  }

  // Check both generated and custom PMI records
  const generatedPMI = generateMockPMIData();
  let pmi = generatedPMI.find(p => p.pmi_id === pmiId);
  let isCustom = false;
  let customIndex = -1;

  // If not in generated, check custom records
  if (!pmi) {
    customIndex = customPMIRecords.findIndex(p => p.pmi_id === pmiId);
    if (customIndex !== -1) {
      pmi = customPMIRecords[customIndex];
      isCustom = true;
    }
  }

  if (!pmi) {
    return res.status(404).json({ error: 'PMI record not found' });
  }

  // Check if user has access to this PMI's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(pmi.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this PMI record' });
  }

  // Validate linked_event_id if provided
  if (linked_event_id !== undefined && linked_event_id !== null) {
    const eventExists = maintenanceEvents.find(e => e.event_id === linked_event_id);
    if (!eventExists) {
      return res.status(400).json({ error: 'Invalid maintenance event ID' });
    }
  }

  // Calculate next due date based on completion date + interval
  const completionDateObj = new Date(completion_date);
  completionDateObj.setDate(completionDateObj.getDate() + pmi.interval_days);
  const nextDueDate = completionDateObj.toISOString().split('T')[0];
  const daysUntilDue = calculateDaysUntilDue(nextDueDate);

  // Create completed PMI record with next due date calculated
  const completedPMI: PMIRecord & { linked_event_id?: number | null } = {
    ...pmi,
    completed_date: completion_date,
    next_due_date: nextDueDate,
    days_until_due: daysUntilDue,
    status: getPMIStatus(daysUntilDue), // Reset to active status with new due date
    linked_event_id: linked_event_id || null,
  };

  // Store the completed/updated PMI
  if (isCustom) {
    customPMIRecords[customIndex] = completedPMI;
  } else {
    // For generated PMI, add to custom records as override
    const existingOverrideIndex = customPMIRecords.findIndex(p => p.pmi_id === pmiId);
    if (existingOverrideIndex !== -1) {
      customPMIRecords[existingOverrideIndex] = completedPMI;
    } else {
      customPMIRecords.push(completedPMI);
    }
  }

  console.log(`[PMI] Completed PMI #${completedPMI.pmi_id} by ${user.username} on ${completion_date} - Next due: ${nextDueDate}`);
  if (linked_event_id) {
    console.log(`[PMI] PMI #${completedPMI.pmi_id} linked to Maintenance Event #${linked_event_id}`);
  }

  res.json({
    message: 'PMI completed successfully',
    pmi: completedPMI,
    next_due_date: nextDueDate,
  });
});

// Get PMI history for a specific asset
app.get('/api/assets/:id/pmi-history', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);
  if (isNaN(assetId)) {
    return res.status(400).json({ error: 'Invalid asset ID' });
  }

  // Find the asset
  const asset = mockAssets.find(a => a.asset_id === assetId);
  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Get all PMI records (generated + custom) for this asset
  const generatedPMI = generateMockPMIData();
  const customPMIIds = new Set(customPMIRecords.map(p => p.pmi_id));
  const filteredGeneratedPMI = generatedPMI.filter(p => !customPMIIds.has(p.pmi_id));
  const allPMI = [...filteredGeneratedPMI, ...customPMIRecords];

  // Filter to only this asset's PMI records
  let assetPMI = allPMI.filter(pmi => pmi.asset_id === assetId);

  // Update days_until_due and status dynamically
  assetPMI = assetPMI.map(pmi => {
    const daysUntilDue = calculateDaysUntilDue(pmi.next_due_date);
    return {
      ...pmi,
      days_until_due: daysUntilDue,
      status: pmi.completed_date ? 'completed' as const : getPMIStatus(daysUntilDue),
    };
  });

  // Sort by next_due_date (most recent first for history view)
  assetPMI.sort((a, b) => new Date(a.next_due_date).getTime() - new Date(b.next_due_date).getTime());

  // Calculate summary for this asset
  const summary = {
    total: assetPMI.length,
    completed: assetPMI.filter(p => p.completed_date).length,
    pending: assetPMI.filter(p => !p.completed_date).length,
    overdue: assetPMI.filter(p => !p.completed_date && p.days_until_due < 0).length,
    due_soon: assetPMI.filter(p => !p.completed_date && p.days_until_due >= 0 && p.days_until_due <= 7).length,
    upcoming: assetPMI.filter(p => !p.completed_date && p.days_until_due > 7 && p.days_until_due <= 30).length,
  };

  console.log(`[PMI History] Retrieved ${assetPMI.length} PMI records for asset ${asset.serno} by ${user.username}`);

  res.json({
    pmi_history: assetPMI,
    summary,
    asset: {
      asset_id: asset.asset_id,
      serno: asset.serno,
      name: asset.name || asset.part_name,
    },
  });
});

// Mock Parts Order data for testing
interface PartsOrder {
  order_id: number;
  part_no: string;
  part_name: string;
  nsn: string;
  qty_ordered: number;
  qty_received: number;
  unit_price: number;
  order_date: string;
  request_date: string; // Date/time when request was created
  status: 'pending' | 'acknowledged' | 'shipped' | 'received' | 'cancelled';
  requestor_id: number;
  requestor_name: string;
  requesting_loc_id: number | null; // Location where part is being requested from (field location)
  fulfilling_loc_id: number | null; // Location where part will be fulfilled from (depot location)
  asset_sn: string | null;
  asset_name: string | null;
  job_no: string | null;
  priority: 'routine' | 'urgent' | 'critical';
  pgm_id: number;
  notes: string;
  shipping_tracking: string | null;
  estimated_delivery: string | null;
  acknowledged_date: string | null; // Date/time when depot acknowledged the request
  acknowledged_by: number | null; // User ID of depot manager who acknowledged
  acknowledged_by_name: string | null; // Name of depot manager who acknowledged
  filled_date: string | null; // Date/time when depot filled the order
  filled_by: number | null; // User ID of depot manager who filled
  filled_by_name: string | null; // Name of depot manager who filled
  replacement_asset_id: number | null; // Asset ID of replacement spare part
  replacement_serno: string | null; // Serial number of replacement spare
  shipper: string | null; // Shipper name (FedEx, UPS, DHL, GOV)
  ship_date: string | null; // Date when shipment was sent
  received_date: string | null; // Date/time when field tech received the part
  received_by: number | null; // User ID of field tech who received
  received_by_name: string | null; // Name of field tech who received
  pqdr: boolean; // Product Quality Deficiency Report flag
}

// Parts Order History interface for audit trail
interface PartsOrderHistoryEntry {
  history_id: number;
  order_id: number;
  timestamp: string;
  user_id: number;
  username: string;
  user_full_name: string;
  action_type: 'create' | 'request' | 'acknowledge' | 'fill' | 'deliver' | 'cancel' | 'pqdr_flag';
  status: string; // Status after this action
  description: string;
  metadata?: Record<string, any>; // Additional data like shipper, tracking, etc.
}

// Parts order history storage - stores all history events for parts orders
const partsOrderHistory: PartsOrderHistoryEntry[] = [];
let nextHistoryId = 1;

// Helper function to add parts order history entry
function addPartsOrderHistory(
  orderId: number,
  user: { user_id: number; username: string; first_name: string; last_name: string },
  actionType: PartsOrderHistoryEntry['action_type'],
  status: string,
  description: string,
  metadata?: Record<string, any>
): PartsOrderHistoryEntry {
  const entry: PartsOrderHistoryEntry = {
    history_id: nextHistoryId++,
    order_id: orderId,
    timestamp: new Date().toISOString(),
    user_id: user.user_id,
    username: user.username,
    user_full_name: `${user.first_name} ${user.last_name}`,
    action_type: actionType,
    status,
    description,
    metadata,
  };
  partsOrderHistory.push(entry);
  return entry;
}

// Persistent parts orders array
let partsOrders: PartsOrder[] = [];
let nextPartsOrderId = 10; // Start after initial mock data

// Initialize mock parts order data
function initializePartsOrders(): PartsOrder[] {
  const today = new Date();
  const addDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  };

  return [
    // Pending orders (waiting for acknowledgment) - CRIIS
    {
      order_id: 1,
      part_no: 'PN-PSU-001',
      part_name: 'Power Supply Unit 24V',
      nsn: '6130-01-555-1234',
      qty_ordered: 2,
      qty_received: 0,
      unit_price: 1250.00,
      order_date: addDays(-3),
      request_date: addDays(-3),
      status: 'pending',
      requestor_id: 3,
      requestor_name: 'Bob Field',
      requesting_loc_id: 24, // Bob Field's location (Langley AFB - 1 FW)
      fulfilling_loc_id: 41, // Depot location (Shaw AFB - 20 FW)
      asset_sn: 'CRIIS-006',
      asset_name: 'Radar Unit 01',
      job_no: 'MX-2024-002',
      priority: 'urgent',
      pgm_id: 1,
      notes: 'Required for NMCS asset - radar power supply failure',
      shipping_tracking: null,
      estimated_delivery: null,
      acknowledged_date: null,
      acknowledged_by: null,
      acknowledged_by_name: null,
      filled_date: null,
      filled_by: null,
      filled_by_name: null,
      replacement_asset_id: null,
      replacement_serno: null,
      shipper: null,
      ship_date: null,
      received_date: null,
      received_by: null,
      received_by_name: null,
      pqdr: true, // Flagged for PQDR - suspected manufacturing defect in power supply
    },
    {
      order_id: 2,
      part_no: 'PN-FLT-002',
      part_name: 'Air Filter Assembly',
      nsn: '2940-01-333-5678',
      qty_ordered: 5,
      qty_received: 0,
      unit_price: 89.50,
      order_date: addDays(-1),
      request_date: addDays(-1),
      status: 'shipped',
      requestor_id: 3,
      requestor_name: 'Bob Field',
      requesting_loc_id: 24, // Bob Field's location (Langley AFB - 1 FW)
      fulfilling_loc_id: 41, // Depot location (Shaw AFB - 20 FW)
      asset_sn: null,
      asset_name: null,
      job_no: null,
      priority: 'routine',
      pgm_id: 1,
      notes: 'Stock replenishment - shipped for testing',
      shipping_tracking: 'UPS-2024-TEST-123',
      estimated_delivery: addDays(1),
      acknowledged_date: addDays(-1),
      acknowledged_by: 2,
      acknowledged_by_name: 'Jane Depot',
      filled_date: addDays(-1),
      filled_by: 2,
      filled_by_name: 'Jane Depot',
      replacement_asset_id: 1,
      replacement_serno: 'SPARE-FLT-001',
      shipper: 'UPS',
      ship_date: addDays(-1),
      received_date: null,
      received_by: null,
      received_by_name: null,
      pqdr: false,
    },
    // Acknowledged orders (being processed) - CRIIS
    {
      order_id: 3,
      part_no: 'PN-DIODE-003',
      part_name: 'Laser Diode Module',
      nsn: '5960-01-444-9876',
      qty_ordered: 1,
      qty_received: 0,
      unit_price: 4500.00,
      order_date: addDays(-7),
      request_date: addDays(-7),
      status: 'acknowledged',
      requestor_id: 2,
      requestor_name: 'Jane Depot',
      requesting_loc_id: 41, // Jane Depot's location (Shaw AFB - 20 FW)
      fulfilling_loc_id: 41, // Same depot location (Shaw AFB - 20 FW)
      asset_sn: 'ACTS-005',
      asset_name: 'Laser System',
      job_no: 'MX-2024-006',
      priority: 'critical',
      pgm_id: 2,
      notes: 'Critical NMCS item - laser diode replacement for targeting system',
      shipping_tracking: null,
      estimated_delivery: addDays(5),
      acknowledged_date: addDays(-6),
      acknowledged_by: 2,
      acknowledged_by_name: 'Jane Depot',
      filled_date: null,
      filled_by: null,
      filled_by_name: null,
      replacement_asset_id: null,
      replacement_serno: null,
      shipper: null,
      ship_date: null,
      received_date: null,
      received_by: null,
      received_by_name: null,
    pqdr: false,
    },
    {
      order_id: 4,
      part_no: 'PN-CAB-004',
      part_name: 'Coaxial Cable Assembly',
      nsn: '6145-01-222-4567',
      qty_ordered: 10,
      qty_received: 0,
      unit_price: 45.00,
      order_date: addDays(-5),
      request_date: addDays(-5),
      status: 'acknowledged',
      requestor_id: 3,
      requestor_name: 'Bob Field',
      requesting_loc_id: 24, // Bob Field's location (Langley AFB - 1 FW)
      fulfilling_loc_id: 41, // Depot location (Shaw AFB - 20 FW)
      asset_sn: null,
      asset_name: null,
      job_no: null,
      priority: 'routine',
      pgm_id: 1,
      notes: 'Stock replenishment for field operations',
      shipping_tracking: null,
      estimated_delivery: addDays(10),
      acknowledged_date: addDays(-4),
      acknowledged_by: 2,
      acknowledged_by_name: 'Jane Depot',
      filled_date: null,
      filled_by: null,
      filled_by_name: null,
      replacement_asset_id: null,
      replacement_serno: null,
      shipper: null,
      ship_date: null,
      received_date: null,
      received_by: null,
      received_by_name: null,
    pqdr: false,
    },
    // Shipped orders - CRIIS
    {
      order_id: 5,
      part_no: 'PN-LENS-005',
      part_name: 'Optical Lens Kit',
      nsn: '6650-01-111-2345',
      qty_ordered: 1,
      qty_received: 0,
      unit_price: 2800.00,
      order_date: addDays(-10),
      request_date: addDays(-10),
      status: 'shipped',
      requestor_id: 2,
      requestor_name: 'Jane Depot',
      requesting_loc_id: 41, // Jane Depot's location (Shaw AFB - 20 FW)
      fulfilling_loc_id: 41, // Same depot location (Shaw AFB - 20 FW)
      asset_sn: 'ARDS-004',
      asset_name: 'Reconnaissance Camera',
      job_no: 'MX-2024-007',
      priority: 'urgent',
      pgm_id: 3,
      notes: 'Replacement optics for camera recalibration',
      shipping_tracking: 'FDX-2024-123456789',
      estimated_delivery: addDays(2),
      acknowledged_date: null,
      acknowledged_by: null,
      acknowledged_by_name: null,
      filled_date: null,
      filled_by: null,
      filled_by_name: null,
      replacement_asset_id: null,
      replacement_serno: null,
      shipper: null,
      ship_date: null,
      received_date: null,
      received_by: null,
      received_by_name: null,
    pqdr: false,
    },
    // More pending orders - ACTS
    {
      order_id: 6,
      part_no: 'PN-GYRO-006',
      part_name: 'Gyroscope Stabilizer',
      nsn: '6615-01-777-8901',
      qty_ordered: 1,
      qty_received: 0,
      unit_price: 3200.00,
      order_date: addDays(-2),
      request_date: addDays(-2),
      status: 'pending',
      requestor_id: 3,
      requestor_name: 'Bob Field',
      requesting_loc_id: 24, // Bob Field's location (Langley AFB - 1 FW)
      fulfilling_loc_id: 41, // Depot location (Shaw AFB - 20 FW)
      asset_sn: 'ACTS-003',
      asset_name: 'Targeting System B',
      job_no: 'MX-2024-005',
      priority: 'critical',
      pgm_id: 2,
      notes: 'Required for optical alignment issue fix',
      shipping_tracking: null,
      estimated_delivery: null,
      acknowledged_date: null,
      acknowledged_by: null,
      acknowledged_by_name: null,
      filled_date: null,
      filled_by: null,
      filled_by_name: null,
      replacement_asset_id: null,
      replacement_serno: null,
      shipper: null,
      ship_date: null,
      received_date: null,
      received_by: null,
      received_by_name: null,
    pqdr: false,
    },
    // Acknowledged - Program 236
    {
      order_id: 7,
      part_no: 'PN-CLASS-007',
      part_name: 'Classified Component Alpha',
      nsn: '5999-01-999-0001',
      qty_ordered: 1,
      qty_received: 0,
      unit_price: 15000.00,
      order_date: addDays(-8),
      request_date: addDays(-8),
      status: 'acknowledged',
      requestor_id: 2,
      requestor_name: 'Jane Depot',
      requesting_loc_id: 41, // Jane Depot's location (Shaw AFB - 20 FW)
      fulfilling_loc_id: 41, // Same depot location (Shaw AFB - 20 FW)
      asset_sn: '236-002',
      asset_name: 'Special Unit 001',
      job_no: 'MX-2024-010',
      priority: 'urgent',
      pgm_id: 4,
      notes: 'Classified component - special handling required',
      shipping_tracking: null,
      estimated_delivery: addDays(14),
      acknowledged_date: null,
      acknowledged_by: null,
      acknowledged_by_name: null,
      filled_date: null,
      filled_by: null,
      filled_by_name: null,
      replacement_asset_id: null,
      replacement_serno: null,
      shipper: null,
      ship_date: null,
      received_date: null,
      received_by: null,
      received_by_name: null,
    pqdr: true, // Flagged for PQDR - suspected quality issue
    },
    // Received orders (for history)
    {
      order_id: 8,
      part_no: 'PN-SEAL-008',
      part_name: 'O-Ring Seal Kit',
      nsn: '5330-01-666-3456',
      qty_ordered: 20,
      qty_received: 20,
      unit_price: 12.50,
      order_date: addDays(-15),
      request_date: addDays(-15),
      status: 'received',
      requestor_id: 3,
      requestor_name: 'Bob Field',
      requesting_loc_id: 24, // Bob Field's location (Langley AFB - 1 FW)
      fulfilling_loc_id: 41, // Depot location (Shaw AFB - 20 FW)
      asset_sn: null,
      asset_name: null,
      job_no: null,
      priority: 'routine',
      pgm_id: 1,
      notes: 'Stock replenishment - received complete',
      shipping_tracking: 'UPS-2024-987654321',
      estimated_delivery: addDays(-5),
      acknowledged_date: addDays(-14),
      acknowledged_by: 2,
      acknowledged_by_name: 'Jane Depot',
      filled_date: addDays(-13),
      filled_by: 2,
      filled_by_name: 'Jane Depot',
      replacement_asset_id: null,
      replacement_serno: 'SPARE-SEAL-001',
      shipper: 'UPS',
      ship_date: addDays(-13),
      received_date: addDays(-10),
      received_by: 3,
      received_by_name: 'Bob Field',
    pqdr: false,
    },
    // More pending items for CRIIS
    {
      order_id: 9,
      part_no: 'PN-BATT-009',
      part_name: 'Lithium Battery Pack',
      nsn: '6140-01-888-7654',
      qty_ordered: 4,
      qty_received: 0,
      unit_price: 650.00,
      order_date: addDays(-1),
      request_date: addDays(-1),
      status: 'pending',
      requestor_id: 3,
      requestor_name: 'Bob Field',
      requesting_loc_id: 24, // Bob Field's location (Langley AFB - 1 FW)
      fulfilling_loc_id: 41, // Depot location (Shaw AFB - 20 FW)
      asset_sn: 'CRIIS-005',
      asset_name: 'Camera System X',
      job_no: 'MX-2024-001',
      priority: 'urgent',
      pgm_id: 1,
      notes: 'Battery replacement for intermittent power issue',
      shipping_tracking: null,
      estimated_delivery: null,
      acknowledged_date: null,
      acknowledged_by: null,
      acknowledged_by_name: null,
      filled_date: null,
      filled_by: null,
      filled_by_name: null,
      replacement_asset_id: null,
      replacement_serno: null,
      shipper: null,
      ship_date: null,
      received_date: null,
      received_by: null,
      received_by_name: null,
    pqdr: false,
    },
  ];
}

// Initialize parts orders on server start
partsOrders = initializePartsOrders();

// Initialize historical entries for existing orders
function initializePartsOrderHistory(): void {
  // Get mock users for history entries
  const bobField = mockUsers.find(u => u.username === 'field_tech')!;
  const janeDepot = mockUsers.find(u => u.username === 'depot_mgr')!;
  const johnAdmin = mockUsers.find(u => u.username === 'admin')!;

  // Add history for each existing order based on their current status
  partsOrders.forEach(order => {
    const requestor = mockUsers.find(u => u.user_id === order.requestor_id) || bobField;

    // All orders start with a REQUEST action
    addPartsOrderHistory(
      order.order_id,
      requestor,
      'request',
      'pending',
      `Parts request created for ${order.part_name}`,
      {
        part_no: order.part_no,
        qty_ordered: order.qty_ordered,
        priority: order.priority,
        asset_sn: order.asset_sn,
        job_no: order.job_no,
      }
    );

    // If acknowledged, add ACKNOWLEDGE action
    if (order.acknowledged_date && order.acknowledged_by) {
      const acknowledger = mockUsers.find(u => u.user_id === order.acknowledged_by) || janeDepot;
      addPartsOrderHistory(
        order.order_id,
        acknowledger,
        'acknowledge',
        'acknowledged',
        `Order acknowledged by depot`,
        {
          acknowledged_date: order.acknowledged_date,
        }
      );
    }

    // If filled, add FILL action
    if (order.filled_date && order.filled_by) {
      const filler = mockUsers.find(u => u.user_id === order.filled_by) || janeDepot;
      addPartsOrderHistory(
        order.order_id,
        filler,
        'fill',
        'shipped',
        `Order filled with replacement part ${order.replacement_serno || 'N/A'}`,
        {
          filled_date: order.filled_date,
          replacement_serno: order.replacement_serno,
          shipper: order.shipper,
          tracking_number: order.shipping_tracking,
          ship_date: order.ship_date,
        }
      );
    }

    // If received, add DELIVER action
    if (order.received_date && order.received_by) {
      const receiver = mockUsers.find(u => u.user_id === order.received_by) || bobField;
      addPartsOrderHistory(
        order.order_id,
        receiver,
        'deliver',
        'received',
        `Parts received and order completed`,
        {
          received_date: order.received_date,
        }
      );
    }

    // If PQDR flagged, add PQDR action
    if (order.pqdr) {
      addPartsOrderHistory(
        order.order_id,
        requestor,
        'pqdr_flag',
        order.status,
        `Order flagged for PQDR (Product Quality Deficiency Report)`,
        {
          pqdr: true,
        }
      );
    }
  });
}

// Initialize history after orders are created
initializePartsOrderHistory();

// Dashboard: Get parts awaiting action (requires authentication)
app.get('/api/dashboard/parts-awaiting-action', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get program filter from query string (optional)
  const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // Get user's location IDs for authorization check
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get location filter from query string (optional)
  let locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;

  // If location specified, verify user has access to it
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' });
  }

  // Get all orders (use persistent array)
  const allOrders = partsOrders;

  // Filter by user's accessible programs and only show pending/acknowledged items
  let filteredOrders = allOrders.filter(
    order => (order.status === 'pending' || order.status === 'acknowledged') && userProgramIds.includes(order.pgm_id)
  );

  // Apply program filter if specified
  if (programIdFilter && userProgramIds.includes(programIdFilter)) {
    filteredOrders = filteredOrders.filter(order => order.pgm_id === programIdFilter);
  }

  // SECURITY: Filter by location - join with assets to check loc_ida/loc_idc
  // Parts orders have asset_id which we can use to find the asset's location
  if (locationIdFilter || userLocationIds.length > 0) {
    filteredOrders = filteredOrders.filter(order => {
      // If order has no associated asset, include it (general inventory orders)
      if (!order.asset_id) return true;

      const asset = detailedAssets.find(a => a.asset_id === order.asset_id);
      if (!asset) return false; // Order for deleted asset

      if (locationIdFilter) {
        // Filter by specific location
        const matchesAssignedBase = asset.loc_ida === locationIdFilter;
        const matchesCurrentBase = asset.loc_idc === locationIdFilter;
        return matchesAssignedBase || matchesCurrentBase;
      } else if (userLocationIds.length > 0) {
        // Filter by all user's locations
        const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida);
        const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc);
        return matchesAssignedBase || matchesCurrentBase;
      }
      return true;
    });
  }

  // Sort by priority (critical first, then urgent, then routine)
  const priorityOrder: Record<string, number> = { critical: 0, urgent: 1, routine: 2 };
  filteredOrders.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // Calculate summary counts
  const summary = {
    pending: filteredOrders.filter(o => o.status === 'pending').length,
    acknowledged: filteredOrders.filter(o => o.status === 'acknowledged').length,
    critical: filteredOrders.filter(o => o.priority === 'critical').length,
    urgent: filteredOrders.filter(o => o.priority === 'urgent').length,
    routine: filteredOrders.filter(o => o.priority === 'routine').length,
    total: filteredOrders.length,
  };

  console.log(`[PARTS] Awaiting action request by ${user.username} - Total: ${summary.total}, Pending: ${summary.pending}, Acknowledged: ${summary.acknowledged}`);

  res.json({
    orders: filteredOrders,
    summary,
  });
});

// Mock Activity Log data for recent activity feed
interface ActivityLogEntry {
  activity_id: number;
  timestamp: string;
  user_id: number;
  username: string;
  user_full_name: string;
  action_type: 'create' | 'update' | 'delete' | 'login' | 'logout' | 'status_change' | 'order' | 'complete';
  entity_type: 'asset' | 'maintenance' | 'pmi' | 'parts_order' | 'user' | 'session' | 'tcto';
  entity_id: number | null;
  entity_name: string | null;
  description: string;
  pgm_id: number | null;
}

// Generate mock activity log data with realistic timestamps
function generateMockActivityLog(): ActivityLogEntry[] {
  const now = new Date();

  // Helper to create timestamp strings with relative time
  const subtractMinutes = (minutes: number): string => {
    const date = new Date(now);
    date.setMinutes(date.getMinutes() - minutes);
    return date.toISOString();
  };

  return [
    {
      activity_id: 1,
      timestamp: subtractMinutes(5),
      user_id: 3,
      username: 'field_tech',
      user_full_name: 'Bob Field',
      action_type: 'create',
      entity_type: 'maintenance',
      entity_id: 11,
      entity_name: 'MX-2024-011',
      description: 'Created maintenance job MX-2024-011 for Sensor Unit A',
      pgm_id: 1,
    },
    {
      activity_id: 2,
      timestamp: subtractMinutes(12),
      user_id: 2,
      username: 'depot_mgr',
      user_full_name: 'Jane Depot',
      action_type: 'status_change',
      entity_type: 'parts_order',
      entity_id: 3,
      entity_name: 'PN-DIODE-003',
      description: 'Acknowledged parts order for Laser Diode Module',
      pgm_id: 2,
    },
    {
      activity_id: 3,
      timestamp: subtractMinutes(25),
      user_id: 3,
      username: 'field_tech',
      user_full_name: 'Bob Field',
      action_type: 'order',
      entity_type: 'parts_order',
      entity_id: 9,
      entity_name: 'PN-BATT-009',
      description: 'Ordered 4x Lithium Battery Pack for Camera System X',
      pgm_id: 1,
    },
    {
      activity_id: 4,
      timestamp: subtractMinutes(45),
      user_id: 1,
      username: 'admin',
      user_full_name: 'John Admin',
      action_type: 'update',
      entity_type: 'user',
      entity_id: 5,
      entity_name: 'test_user',
      description: 'Updated user account test_user - changed role to VIEWER',
      pgm_id: null,
    },
    {
      activity_id: 5,
      timestamp: subtractMinutes(60),
      user_id: 2,
      username: 'depot_mgr',
      user_full_name: 'Jane Depot',
      action_type: 'complete',
      entity_type: 'pmi',
      entity_id: 12,
      entity_name: 'PMI-30DAY',
      description: 'Completed 30-Day Inspection on Sensor Unit A (CRIIS-001)',
      pgm_id: 1,
    },
    {
      activity_id: 6,
      timestamp: subtractMinutes(90),
      user_id: 3,
      username: 'field_tech',
      user_full_name: 'Bob Field',
      action_type: 'update',
      entity_type: 'maintenance',
      entity_id: 2,
      entity_name: 'MX-2024-002',
      description: 'Updated maintenance job MX-2024-002 - added repair notes',
      pgm_id: 1,
    },
    {
      activity_id: 7,
      timestamp: subtractMinutes(120),
      user_id: 2,
      username: 'depot_mgr',
      user_full_name: 'Jane Depot',
      action_type: 'status_change',
      entity_type: 'asset',
      entity_id: 5,
      entity_name: 'CRIIS-005',
      description: 'Changed asset status from FMC to NMCM - Camera System X',
      pgm_id: 1,
    },
    {
      activity_id: 8,
      timestamp: subtractMinutes(180),
      user_id: 1,
      username: 'admin',
      user_full_name: 'John Admin',
      action_type: 'create',
      entity_type: 'user',
      entity_id: 6,
      entity_name: 'new_technician',
      description: 'Created new user account new_technician with role FIELD_TECHNICIAN',
      pgm_id: null,
    },
    {
      activity_id: 9,
      timestamp: subtractMinutes(240),
      user_id: 3,
      username: 'field_tech',
      user_full_name: 'Bob Field',
      action_type: 'create',
      entity_type: 'maintenance',
      entity_id: 1,
      entity_name: 'MX-2024-001',
      description: 'Created maintenance job MX-2024-001 - intermittent power failure',
      pgm_id: 1,
    },
    {
      activity_id: 10,
      timestamp: subtractMinutes(300),
      user_id: 2,
      username: 'depot_mgr',
      user_full_name: 'Jane Depot',
      action_type: 'status_change',
      entity_type: 'parts_order',
      entity_id: 5,
      entity_name: 'PN-LENS-005',
      description: 'Shipped parts order - Optical Lens Kit (FDX-2024-123456789)',
      pgm_id: 3,
    },
    {
      activity_id: 11,
      timestamp: subtractMinutes(360),
      user_id: 1,
      username: 'admin',
      user_full_name: 'John Admin',
      action_type: 'update',
      entity_type: 'tcto',
      entity_id: 1,
      entity_name: 'TCTO-2024-15',
      description: 'Updated TCTO-2024-15 compliance deadline to 2024-03-15',
      pgm_id: 1,
    },
    {
      activity_id: 12,
      timestamp: subtractMinutes(420),
      user_id: 3,
      username: 'field_tech',
      user_full_name: 'Bob Field',
      action_type: 'order',
      entity_type: 'parts_order',
      entity_id: 1,
      entity_name: 'PN-PSU-001',
      description: 'Ordered 2x Power Supply Unit 24V for Radar Unit 01',
      pgm_id: 1,
    },
    {
      activity_id: 13,
      timestamp: subtractMinutes(500),
      user_id: 2,
      username: 'depot_mgr',
      user_full_name: 'Jane Depot',
      action_type: 'complete',
      entity_type: 'maintenance',
      entity_id: 8,
      entity_name: 'MX-2024-008',
      description: 'Closed maintenance job MX-2024-008 - 30-day inspection completed',
      pgm_id: 1,
    },
    {
      activity_id: 14,
      timestamp: subtractMinutes(600),
      user_id: 1,
      username: 'admin',
      user_full_name: 'John Admin',
      action_type: 'login',
      entity_type: 'session',
      entity_id: null,
      entity_name: null,
      description: 'User logged in from 192.168.1.100',
      pgm_id: null,
    },
    {
      activity_id: 15,
      timestamp: subtractMinutes(720),
      user_id: 3,
      username: 'field_tech',
      user_full_name: 'Bob Field',
      action_type: 'status_change',
      entity_type: 'asset',
      entity_id: 6,
      entity_name: 'CRIIS-006',
      description: 'Changed asset status from PMC to NMCS - Radar Unit 01',
      pgm_id: 1,
    },
  ];
}

// Mutable activity log to store new activities (e.g., from asset updates)
const dynamicActivityLog: ActivityLogEntry[] = [];

// Dashboard: Get recent activity (requires authentication)
app.get('/api/dashboard/recent-activity', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get user's location IDs for authorization check
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get location filter from query string (optional)
  let locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;

  // If location specified, verify user has access to it
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' });
  }

  // Get optional limit from query string (default to 10)
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 50);

  // Generate activity log (static + dynamic entries)
  const allActivity = [...generateMockActivityLog(), ...dynamicActivityLog];

  // Filter activity by user's accessible programs (null pgm_id entries are global and visible to all)
  let filteredActivity = allActivity.filter(
    activity => activity.pgm_id === null || userProgramIds.includes(activity.pgm_id)
  );

  // SECURITY: Filter by location - check entity's location based on entity_type
  if (locationIdFilter || userLocationIds.length > 0) {
    filteredActivity = filteredActivity.filter(activity => {
      // Global activities (null entity_id, user/session entity_type) are always visible
      if (activity.entity_id === null || activity.entity_type === 'user' || activity.entity_type === 'session') {
        return true;
      }

      // For other entity types, find the associated asset to check location
      let asset: AssetDetails | undefined;

      if (activity.entity_type === 'asset') {
        asset = detailedAssets.find(a => a.asset_id === activity.entity_id);
      } else if (activity.entity_type === 'maintenance') {
        const event = maintenanceEvents.find(e => e.event_id === activity.entity_id);
        if (event) {
          asset = detailedAssets.find(a => a.asset_id === event.asset_id);
        }
      } else if (activity.entity_type === 'pmi') {
        // PMI records - need to find via generateMockPMIData
        const generatedPMI = generateMockPMIData();
        const pmiRecord = [...generatedPMI, ...customPMIRecords].find(p => p.pmi_id === activity.entity_id);
        if (pmiRecord) {
          asset = detailedAssets.find(a => a.asset_id === pmiRecord.asset_id);
        }
      } else if (activity.entity_type === 'parts_order') {
        const order = partsOrders.find(o => o.order_id === activity.entity_id);
        if (order && order.asset_id) {
          asset = detailedAssets.find(a => a.asset_id === order.asset_id);
        } else {
          // Parts order with no asset (general inventory) - include it
          return true;
        }
      }

      // If no asset found, exclude the activity (entity was deleted or data inconsistency)
      if (!asset) return false;

      // Check location match
      if (locationIdFilter) {
        const matchesAssignedBase = asset.loc_ida === locationIdFilter;
        const matchesCurrentBase = asset.loc_idc === locationIdFilter;
        return matchesAssignedBase || matchesCurrentBase;
      } else if (userLocationIds.length > 0) {
        const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida);
        const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc);
        return matchesAssignedBase || matchesCurrentBase;
      }
      return true;
    });
  }

  // Sort by timestamp (most recent first) and limit
  const sortedActivity = filteredActivity
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  console.log(`[ACTIVITY] Recent activity request by ${user.username} - Returned: ${sortedActivity.length} entries`);

  res.json({
    activities: sortedActivity,
    total: sortedActivity.length,
  });
});

// Dashboard: Get maintenance trends data for line chart (requires authentication)
app.get('/api/dashboard/maintenance-trends', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get program filter from query string (optional)
  const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // Get user's location IDs for authorization check
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get location filter from query string (optional)
  let locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;

  // If location specified, verify user has access to it
  if (locationIdFilter && userLocationIds.length > 0 && !userLocationIds.includes(locationIdFilter)) {
    return res.status(403).json({ error: 'Access denied to this location' });
  }

  // Get number of days for the trend data (default 30)
  const days = Math.min(parseInt(req.query.days as string, 10) || 30, 90);

  // Use persistent maintenance events array
  const allEvents = maintenanceEvents;

  // Filter by user's accessible programs
  let filteredEvents = allEvents.filter(event => userProgramIds.includes(event.pgm_id));

  // Apply program filter if specified
  if (programIdFilter && userProgramIds.includes(programIdFilter)) {
    filteredEvents = filteredEvents.filter(event => event.pgm_id === programIdFilter);
  }

  // SECURITY: Filter by location
  if (locationIdFilter || userLocationIds.length > 0) {
    filteredEvents = filteredEvents.filter(event => {
      const asset = detailedAssets.find(a => a.asset_id === event.asset_id);
      if (!asset) return false;

      if (locationIdFilter) {
        const matchesAssignedBase = asset.loc_ida === locationIdFilter;
        const matchesCurrentBase = asset.loc_idc === locationIdFilter;
        return matchesAssignedBase || matchesCurrentBase;
      } else if (userLocationIds.length > 0) {
        const matchesAssignedBase = asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida);
        const matchesCurrentBase = asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc);
        return matchesAssignedBase || matchesCurrentBase;
      }
      return true;
    });
  }

  // Generate date range for the past N days
  const today = new Date();
  today.setHours(23, 59, 59, 999); // End of today
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days + 1);
  startDate.setHours(0, 0, 0, 0); // Start of first day

  // Initialize data structure for each day
  const trendsMap: Map<string, { date: string; created: number; completed: number; inProgress: number }> = new Map();

  // Create entries for each day in the range
  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    trendsMap.set(dateStr, { date: dateStr, created: 0, completed: 0, inProgress: 0 });
  }

  // Count events created on each day
  filteredEvents.forEach(event => {
    const startJobDate = event.start_job;
    if (startJobDate && trendsMap.has(startJobDate)) {
      const dayData = trendsMap.get(startJobDate)!;
      dayData.created += 1;
    }
  });

  // Count events completed on each day
  filteredEvents.forEach(event => {
    if (event.stop_job && trendsMap.has(event.stop_job)) {
      const dayData = trendsMap.get(event.stop_job)!;
      dayData.completed += 1;
    }
  });

  // Calculate in-progress count for each day
  // An event is in-progress on a given day if:
  // - start_job is on or before that day
  // - stop_job is null OR stop_job is after that day
  const sortedDates = Array.from(trendsMap.keys()).sort();
  sortedDates.forEach(dateStr => {
    const dateEnd = new Date(dateStr);
    dateEnd.setHours(23, 59, 59, 999);

    const inProgressCount = filteredEvents.filter(event => {
      const startJob = new Date(event.start_job);
      startJob.setHours(0, 0, 0, 0);

      // Event started on or before this day
      if (startJob > dateEnd) return false;

      // Event is either still open or was closed after this day
      if (event.stop_job === null) return true;

      const stopJob = new Date(event.stop_job);
      stopJob.setHours(23, 59, 59, 999);
      return stopJob >= dateEnd;
    }).length;

    const dayData = trendsMap.get(dateStr)!;
    dayData.inProgress = inProgressCount;
  });

  // Convert map to array sorted by date
  const trends = Array.from(trendsMap.values()).sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  // Calculate summary statistics
  const totalCreated = trends.reduce((sum, day) => sum + day.created, 0);
  const totalCompleted = trends.reduce((sum, day) => sum + day.completed, 0);
  const currentInProgress = filteredEvents.filter(e => e.status === 'open').length;
  const avgPerDay = totalCreated / days;

  console.log(`[MAINTENANCE-TRENDS] Request by ${user.username} - Days: ${days}, Created: ${totalCreated}, Completed: ${totalCompleted}, In-Progress: ${currentInProgress}`);

  res.json({
    trends,
    summary: {
      totalCreated,
      totalCompleted,
      currentInProgress,
      avgPerDay: Math.round(avgPerDay * 10) / 10, // Round to 1 decimal
      days,
    },
  });
});

// Enhanced mock asset data with more details for the Assets page
interface AssetDetails {
  asset_id: number;
  serno: string;
  partno: string;
  part_name: string;
  sys_type: string;  // System type (e.g., "Camera System", "Targeting System")
  pgm_id: number;
  status_cd: string;
  status_name: string;
  active: boolean;
  location: string;
  loc_type: 'depot' | 'field';
  in_transit: boolean;
  bad_actor: boolean;
  last_maint_date: string | null;
  next_pmi_date: string | null;
  next_ndi_date: string | null;  // Next Non-Destructive Inspection date
  eti_hours: number | null;
  remarks: string | null;
  // Additional fields for asset detail view
  uii: string | null;  // Unique Item Identifier
  mfg_date: string | null;  // Manufacturing date
  acceptance_date: string | null;  // Acceptance date
  loc_ida: number | null;  // Administrative location ID (Assigned Base)
  loc_idc: number | null;  // Custodial location ID (Current Base)
  admin_loc: string;  // Administrative location code
  admin_loc_name: string;  // Administrative location name
  cust_loc: string;  // Custodial location code
  cust_loc_name: string;  // Custodial location name
  // NHA/SRA hierarchy fields
  nha_asset_id: number | null;  // Next Higher Assembly - parent asset ID
  // In-transit shipping information
  carrier: string | null;  // Shipping carrier (e.g., FedEx, UPS, USPS)
  tracking_number: string | null;  // Carrier tracking number
  ship_date: string | null;  // Date asset was shipped (ISO format)
  // Meter tracking fields
  meter_type: 'hours' | 'cycles' | 'eti' | null;  // Type of meter for this asset
  cycles_count: number | null;  // Cycles count (for assets that track cycles instead of/in addition to hours)
  // Audit fields
  created_date: string;  // Creation timestamp (ISO format)
  modified_date: string | null;  // Last modification timestamp (ISO format)
}

// Generate detailed asset data - initialize once and make mutable
// detailedAssets - loaded from DB at startup (see initializeAssetsFromDb)
let detailedAssets: AssetDetails[] = [];

// ============================================================
// DATABASE ASSET HELPERS
// ============================================================

const STATUS_NAMES: Record<string, string> = {
  'FMC': 'Fully Mission Capable',
  'PMC': 'Partially Mission Capable',
  'PMCM': 'Partially Mission Capable Maintenance',
  'NMCM': 'Not Mission Capable Maintenance',
  'NMCS': 'Not Mission Capable Supply',
  'CNDM': 'Condemned',
};

const ASSET_INCLUDE = {
  part: true,
  assignedLocation: true,
  currentLocation: true,
} as const;

function toAssetDetails(dbAsset: any): AssetDetails {
  return {
    asset_id: dbAsset.asset_id,
    serno: dbAsset.serno,
    partno: dbAsset.part?.partno ?? '',
    part_name: dbAsset.part?.noun ?? '',
    sys_type: String(dbAsset.part?.sys_type ?? ''),
    pgm_id: dbAsset.part?.pgm_id ?? 0,
    status_cd: dbAsset.status_cd,
    status_name: STATUS_NAMES[dbAsset.status_cd] ?? dbAsset.status_cd,
    active: dbAsset.active,
    location: dbAsset.assignedLocation?.display_name ?? 'Unknown',
    loc_type: 'depot',
    in_transit: dbAsset.in_transit ?? false,
    bad_actor: dbAsset.bad_actor ?? false,
    last_maint_date: null,
    next_pmi_date: null,
    next_ndi_date: dbAsset.next_ndi_date ? new Date(dbAsset.next_ndi_date).toISOString().split('T')[0] : null,
    eti_hours: dbAsset.eti ? Number(dbAsset.eti) : null,
    remarks: dbAsset.remarks ?? null,
    uii: dbAsset.uii ?? null,
    mfg_date: dbAsset.mfg_date ? new Date(dbAsset.mfg_date).toISOString().split('T')[0] : null,
    acceptance_date: dbAsset.accept_date ? new Date(dbAsset.accept_date).toISOString().split('T')[0] : null,
    loc_ida: dbAsset.loc_ida,
    loc_idc: dbAsset.loc_idc,
    admin_loc: dbAsset.assignedLocation?.site_cd ?? '',
    admin_loc_name: dbAsset.assignedLocation?.display_name ?? '',
    cust_loc: dbAsset.currentLocation?.site_cd ?? '',
    cust_loc_name: dbAsset.currentLocation?.display_name ?? '',
    nha_asset_id: dbAsset.nha_asset_id,
    carrier: dbAsset.shipper ?? null,
    tracking_number: dbAsset.tcn ?? null,
    ship_date: dbAsset.ship_date ? new Date(dbAsset.ship_date).toISOString().split('T')[0] : null,
    meter_type: null,
    cycles_count: null,
    created_date: dbAsset.ins_date ? new Date(dbAsset.ins_date).toISOString() : new Date().toISOString(),
    modified_date: dbAsset.chg_date ? new Date(dbAsset.chg_date).toISOString() : null,
  };
}

function toBasicAsset(dbAsset: any): Asset {
  return {
    asset_id: dbAsset.asset_id,
    serno: dbAsset.serno,
    partno: dbAsset.part?.partno ?? '',
    name: dbAsset.part?.noun ?? '',
    pgm_id: dbAsset.part?.pgm_id ?? 0,
    status_cd: dbAsset.status_cd,
    admin_loc: dbAsset.assignedLocation?.display_name ?? '',
    cust_loc: dbAsset.currentLocation?.display_name ?? '',
    notes: dbAsset.remarks ?? '',
    active: dbAsset.active,
    created_date: dbAsset.ins_date ? new Date(dbAsset.ins_date).toISOString() : '',
  };
}

async function initializeAssetsFromDb(): Promise<void> {
  try {
    const dbAssets = await prisma.asset.findMany({
      where: { active: true },
      include: ASSET_INCLUDE,
    });
    mockAssets = dbAssets.map(toBasicAsset);
    detailedAssets = dbAssets.map(toAssetDetails);
    console.log(`[Assets] Loaded ${mockAssets.length} assets from database`);
  } catch (error) {
    console.error('[Assets] Failed to load from DB, arrays will be empty:', error);
  }
}

// Helper to refresh a single asset in the in-memory arrays after DB mutation
async function refreshAssetInMemory(assetId: number): Promise<void> {
  const dbAsset = await prisma.asset.findUnique({
    where: { asset_id: assetId },
    include: ASSET_INCLUDE,
  });
  if (!dbAsset) {
    // Remove from arrays if deleted
    const mi = mockAssets.findIndex(a => a.asset_id === assetId);
    if (mi !== -1) mockAssets.splice(mi, 1);
    const di = detailedAssets.findIndex(a => a.asset_id === assetId);
    if (di !== -1) detailedAssets.splice(di, 1);
    return;
  }
  // Update or add to mockAssets
  const basicAsset = toBasicAsset(dbAsset);
  const mi = mockAssets.findIndex(a => a.asset_id === assetId);
  if (mi !== -1) mockAssets[mi] = basicAsset;
  else mockAssets.push(basicAsset);
  // Update or add to detailedAssets
  const detailedAsset = toAssetDetails(dbAsset);
  const di = detailedAssets.findIndex(a => a.asset_id === assetId);
  if (di !== -1) detailedAssets[di] = detailedAsset;
  else detailedAssets.push(detailedAsset);
}


// Create new PMI record (moved here so detailedAssets is available)
app.post('/api/pmi', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check permissions - only depot_manager and admin can create PMI
  if (!['DEPOT_MANAGER', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Only depot managers and admins can create PMI records' });
  }

  const { asset_id, pmi_type, next_due_date, wuc_cd, interval_days } = req.body;

  // Validate required fields
  if (!asset_id) {
    return res.status(400).json({ error: 'Asset is required' });
  }
  if (!pmi_type || pmi_type.trim() === '') {
    return res.status(400).json({ error: 'PMI type is required' });
  }
  if (!next_due_date) {
    return res.status(400).json({ error: 'Due date is required' });
  }

  // Get asset details from detailed assets array
  const asset = detailedAssets.find(a => a.asset_id === parseInt(asset_id, 10));
  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Calculate days until due
  const daysUntilDue = calculateDaysUntilDue(next_due_date);

  // Parse interval_days - default to 30 if not provided
  const parsedIntervalDays = interval_days ? parseInt(interval_days, 10) : 30;
  // Validate interval is one of the standard values
  const validIntervals = [30, 60, 90, 180, 365];
  const finalIntervalDays = validIntervals.includes(parsedIntervalDays) ? parsedIntervalDays : 30;

  // Create new PMI record
  const newPMI: PMIRecord = {
    pmi_id: nextCustomPMIId++,
    asset_id: asset.asset_id,
    asset_sn: asset.serno,
    asset_name: asset.part_name || asset.partno || 'Unknown',
    pmi_type: pmi_type.trim(),
    wuc_cd: wuc_cd?.trim() || '',
    next_due_date: next_due_date,
    days_until_due: daysUntilDue,
    completed_date: null,
    pgm_id: asset.pgm_id,
    status: getPMIStatus(daysUntilDue),
    interval_days: finalIntervalDays,
  };

  customPMIRecords.push(newPMI);

  console.log(`[PMI] Created PMI #${newPMI.pmi_id} by ${user.username} - Type: ${newPMI.pmi_type}, Asset: ${newPMI.asset_sn}`);

  res.status(201).json({
    message: 'PMI record created successfully',
    pmi: newPMI,
  });
});

// GET /api/assets - List all assets for a program (requires authentication)
// Now queries the REAL PostgreSQL database instead of mock data
app.get('/api/assets', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    // Load code cache for lookups
    const codes = await loadCodeCache();

    // Get user's program IDs
    const userProgramIds = user.programs.map(p => p.pgm_id);

    // Get program filter from query string (required or use default)
    let programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

    // If no program specified, use user's default program
    if (!programIdFilter) {
      const defaultProgram = user.programs.find(p => p.is_default);
      programIdFilter = defaultProgram?.pgm_id || user.programs[0]?.pgm_id || 1;
    }

    // Check if user has access to this program (ADMIN can access all)
    if (!userProgramIds.includes(programIdFilter) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this program' });
    }

    // Get user's location IDs for filtering (non-admin users see only their locations)
    const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

    // Get location filter from query string (optional)
    // location_id=0 means "All Locations" (admin only)
    const locationIdRaw = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;
    const locationIdFilter = locationIdRaw === 0 ? null : locationIdRaw; // Treat 0 as "all locations"

    // Get pagination params
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 25, 100);
    const offset = (page - 1) * limit;

    // Build where clause for Prisma query
    const whereClause: Prisma.AssetWhereInput = {
      active: true,
      part: {
        pgm_id: programIdFilter
      }
    };

    // Apply location filtering
    // If specific location requested (not 0), filter by that location
    // For non-admin users, filter by their assigned locations
    // location_id=0 or null for ADMIN means show all assets for the program
    if (locationIdFilter && locationIdFilter > 0) {
      // Filter by specific requested location (admin loc OR custodial loc)
      whereClause.OR = [
        { loc_ida: locationIdFilter },
        { loc_idc: locationIdFilter }
      ];
    } else if (user.role !== 'ADMIN' && userLocationIds.length > 0) {
      // Non-admin users see only assets at their assigned locations
      whereClause.OR = [
        { loc_ida: { in: userLocationIds } },
        { loc_idc: { in: userLocationIds } }
      ];
    }
    // ADMIN users with location_id=0 or no location filter see all assets for the program

    // Apply optional status filter
    const statusFilter = req.query.status as string;
    if (statusFilter) {
      // Merge with existing OR clause if present
      if (whereClause.OR) {
        whereClause.AND = [
          { OR: whereClause.OR },
          { status_cd: statusFilter }
        ];
        delete whereClause.OR;
      } else {
        whereClause.status_cd = statusFilter;
      }
    }

    // Apply optional search filter (searches serno, partno via part relation, noun via part relation)
    const searchQuery = (req.query.search as string)?.trim() || null;
    if (searchQuery) {
      const searchConditions = [
        { serno: { contains: searchQuery, mode: 'insensitive' as const } },
        { part: { partno: { contains: searchQuery, mode: 'insensitive' as const } } },
        { part: { noun: { contains: searchQuery, mode: 'insensitive' as const } } },
      ];

      if (whereClause.AND) {
        (whereClause.AND as Prisma.AssetWhereInput[]).push({ OR: searchConditions });
      } else if (whereClause.OR) {
        whereClause.AND = [
          { OR: whereClause.OR },
          { OR: searchConditions }
        ];
        delete whereClause.OR;
      } else {
        whereClause.OR = searchConditions;
      }
    }

    // Determine sort field and order
    const sortBy = (req.query.sort_by as string) || 'serno';
    const sortOrder = (req.query.sort_order as string) === 'desc' ? 'desc' : 'asc';

    // Map sort fields to Prisma orderBy
    let orderBy: Prisma.AssetOrderByWithRelationInput = { serno: sortOrder };
    switch (sortBy) {
      case 'serno':
        orderBy = { serno: sortOrder };
        break;
      case 'partno':
        orderBy = { part: { partno: sortOrder } };
        break;
      case 'part_name':
        orderBy = { part: { noun: sortOrder } };
        break;
      case 'status_cd':
        orderBy = { status_cd: sortOrder };
        break;
      case 'eti_hours':
        orderBy = { eti: sortOrder };
        break;
    }

    // Get total count
    const total = await prisma.asset.count({ where: whereClause });

    // Query assets from database with relations
    const dbAssets = await prisma.asset.findMany({
      where: whereClause,
      include: {
        part: {
          select: {
            partno: true,
            noun: true,
            pgm_id: true,
            program: {
              select: { pgm_cd: true, pgm_name: true }
            }
          }
        },
        assignedLocation: {
          select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true }
        },
        currentLocation: {
          select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true }
        }
      },
      orderBy,
      skip: offset,
      take: limit,
    });

    // Transform database results to match frontend expected format
    const assets = dbAssets.map(asset => {
      // Build location display string - resolve code IDs to actual codes
      const formatLocation = (loc: { display_name: string; majcom_cd?: string | null; site_cd?: string | null; unit_cd?: string | null } | null) => {
        if (!loc) return 'Unknown';

        // Resolve the majcom, site, unit IDs to actual codes
        const majcom = resolveCodeId(loc.majcom_cd || null, codes);
        const site = resolveCodeId(loc.site_cd || null, codes);
        const unit = resolveCodeId(loc.unit_cd || null, codes);

        // Build from resolved hierarchy components
        const parts = [majcom, site, unit].filter(Boolean);
        if (parts.length > 0) {
          return parts.join('/');
        }

        // Fallback to display_name if available and not just IDs
        if (loc.display_name && !loc.display_name.match(/^\d+\/\d+\/\d+$/)) {
          return loc.display_name;
        }

        return 'Unknown';
      };

      // Resolve the status_cd (which is stored as a code_id) to actual status code
      const resolvedStatusCd = resolveCodeId(asset.status_cd, codes);

      return {
        asset_id: asset.asset_id,
        serno: asset.serno,
        partno: asset.part?.partno || '',
        part_name: asset.part?.noun || '',
        pgm_id: asset.part?.pgm_id || programIdFilter,
        status_cd: resolvedStatusCd || 'FMC',
        status_name: getStatusName(resolvedStatusCd),
        active: asset.active,
        location: formatLocation(asset.assignedLocation) || formatLocation(asset.currentLocation) || 'Unknown',
        loc_type: 'depot' as const,
        in_transit: asset.in_transit || false,
        bad_actor: asset.bad_actor || false,
        last_maint_date: null,
        next_pmi_date: null,
        eti_hours: asset.eti ? Number(asset.eti) : null,
        remarks: asset.remarks,
        uii: asset.uii,
        mfg_date: asset.mfg_date?.toISOString().split('T')[0] || null,
        acceptance_date: asset.accept_date?.toISOString().split('T')[0] || null,
        loc_ida: asset.loc_ida,
        loc_idc: asset.loc_idc,
        admin_loc: formatLocation(asset.assignedLocation),
        admin_loc_name: formatLocation(asset.assignedLocation),
        cust_loc: formatLocation(asset.currentLocation),
        cust_loc_name: formatLocation(asset.currentLocation),
        nha_asset_id: asset.nha_asset_id,
        carrier: asset.shipper,
        tracking_number: asset.tcn,
        ship_date: asset.ship_date?.toISOString().split('T')[0] || null,
        created_date: asset.ins_date?.toISOString() || new Date().toISOString(),
        modified_date: asset.chg_date?.toISOString() || null,
      };
    });

    // Get program info from database
    const program = await prisma.program.findUnique({
      where: { pgm_id: programIdFilter },
      select: { pgm_id: true, pgm_cd: true, pgm_name: true }
    });

    console.log(`[ASSETS-DB] List request by ${user.username} (${user.role}) - Program: ${program?.pgm_cd || programIdFilter}, Location filter: ${locationIdFilter || 'none'}, Total: ${total}, Page: ${page}`);

    res.json({
      assets,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
      program: {
        pgm_id: programIdFilter,
        pgm_cd: program?.pgm_cd || 'UNKNOWN',
        pgm_name: program?.pgm_name || 'Unknown Program',
      },
    });
  } catch (error) {
    console.error('[ASSETS-DB] Error fetching assets:', error);
    res.status(500).json({ error: 'Failed to fetch assets from database' });
  }
});

// Helper function to get status name from code
function getStatusName(statusCd: string | null): string {
  const statusMap: Record<string, string> = {
    'FMC': 'Fully Mission Capable',
    'PMC': 'Partially Mission Capable',
    'PMCM': 'Partially Mission Capable (Maintenance)',
    'PMCS': 'Partially Mission Capable (Supply)',
    'PMCB': 'Partially Mission Capable (Both)',
    'NMCM': 'Not Mission Capable (Maintenance)',
    'NMCS': 'Not Mission Capable (Supply)',
    'NMCB': 'Not Mission Capable (Both)',
    'CNDM': 'Condemned',
  };
  return statusMap[statusCd || ''] || statusCd || 'Unknown';
}

// GET /api/assets/available-for-install - Get assets available for installation/cannibalization
app.get('/api/assets/available-for-install', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get assets that are FMC or PMC status (operational) from user's programs
  const availableAssets = mockAssets
    .filter(asset => {
      if (!userProgramIds.includes(asset.pgm_id)) return false;
      if (!asset.active) return false;
      return asset.status_cd === 'FMC' || asset.status_cd === 'PMC';
    })
    .map(asset => ({
      asset_id: asset.asset_id,
      serno: asset.serno,
      partno: asset.partno,
      nomen: asset.name,
      status: asset.status_cd,
      location: asset.cust_loc || null,
    }));

  console.log(`[ASSETS] Available for install - User: ${user.username}, Count: ${availableAssets.length}`);

  res.json({ assets: availableAssets });
});

// GET /api/assets/:id - Get single asset by ID (requires authentication)
app.get('/api/assets/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);

  try {
    // Load code cache for lookups
    const codes = await loadCodeCache();

    // Get the asset from database with all related data
    const asset = await prisma.asset.findUnique({
      where: { asset_id: assetId },
      include: {
        part: {
          select: {
            partno: true,
            noun: true,
            pgm_id: true,
            program: {
              select: { pgm_cd: true, pgm_name: true }
            }
          }
        },
        assignedLocation: {
          select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true }
        },
        currentLocation: {
          select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true }
        }
      }
    });

    // Return 404 if asset doesn't exist or is deleted (soft delete)
    if (!asset || !asset.active) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    // Check if user has access to this asset's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    const assetPgmId = asset.part?.pgm_id;
    if (assetPgmId && !userProgramIds.includes(assetPgmId) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this asset' });
    }

    // Helper to format location display - resolve code IDs to actual codes
    const formatLocation = (loc: { display_name: string; majcom_cd?: string | null; site_cd?: string | null; unit_cd?: string | null } | null) => {
      if (!loc) return 'Unknown';

      // Resolve the majcom, site, unit IDs to actual codes
      const majcom = resolveCodeId(loc.majcom_cd, codes);
      const site = resolveCodeId(loc.site_cd, codes);
      const unit = resolveCodeId(loc.unit_cd, codes);

      // Build from resolved hierarchy components
      const parts = [majcom, site, unit].filter(Boolean);
      if (parts.length > 0) {
        return parts.join('/');
      }

      // Fallback to display_name if available and not just IDs
      if (loc.display_name && !loc.display_name.match(/^\d+\/\d+\/\d+$/)) {
        return loc.display_name;
      }

      return 'Unknown';
    };

    // Resolve the status_cd (which is stored as a code_id) to actual status code
    const resolvedStatusCd = resolveCodeId(asset.status_cd, codes);

    // Transform to frontend expected format
    const transformedAsset = {
      asset_id: asset.asset_id,
      serno: asset.serno,
      partno: asset.part?.partno || '',
      part_name: asset.part?.noun || '',
      name: asset.part?.noun || '',
      pgm_id: asset.part?.pgm_id || 1,
      status_cd: resolvedStatusCd || 'FMC',
      status_name: getStatusName(resolvedStatusCd),
      active: asset.active,
      admin_loc: formatLocation(asset.assignedLocation),
      admin_loc_name: formatLocation(asset.assignedLocation),
      cust_loc: formatLocation(asset.currentLocation),
      cust_loc_name: formatLocation(asset.currentLocation),
      location: formatLocation(asset.assignedLocation) || formatLocation(asset.currentLocation) || 'Unknown',
      loc_type: 'depot' as const,
      in_transit: asset.in_transit || false,
      bad_actor: asset.bad_actor || false,
      eti_hours: asset.eti ? Number(asset.eti) : null,
      remarks: asset.remarks,
      notes: asset.remarks || '',
      uii: asset.uii,
      mfg_date: asset.mfg_date?.toISOString().split('T')[0] || null,
      acceptance_date: asset.accept_date?.toISOString().split('T')[0] || null,
      last_maint_date: null,
      next_pmi_date: null,
      next_ndi_date: asset.next_ndi_date?.toISOString().split('T')[0] || null,
      nha_asset_id: asset.nha_asset_id,
      carrier: asset.shipper,
      tracking_number: asset.tcn,
      ship_date: asset.ship_date?.toISOString().split('T')[0] || null,
      created_date: asset.ins_date?.toISOString() || new Date().toISOString(),
      modified_date: asset.chg_date?.toISOString() || null,
      program_cd: asset.part?.program?.pgm_cd || 'UNKNOWN',
      program_name: asset.part?.program?.pgm_name || 'Unknown Program',
    };

    console.log(`[ASSETS-DB] Detail request by ${user.username} for asset ${asset.serno} (ID: ${assetId})`);

    res.json({
      asset: transformedAsset
    });
  } catch (error) {
    console.error('[ASSETS-DB] Error fetching asset detail:', error);
    res.status(500).json({ error: 'Failed to fetch asset from database' });
  }
});

// GET /api/assets/:id/hierarchy - Get asset NHA/SRA hierarchy (requires authentication)
app.get('/api/assets/:id/hierarchy', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);

  // Get the asset from detailedAssets
  const asset = detailedAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Get program info
  const program = allPrograms.find(p => p.pgm_id === asset.pgm_id);

  // Get parent asset (NHA - Next Higher Assembly)
  let nha: { asset_id: number; serno: string; partno: string; part_name: string; status_cd: string; status_name: string } | null = null;
  if (asset.nha_asset_id) {
    const parentAsset = detailedAssets.find(a => a.asset_id === asset.nha_asset_id);
    if (parentAsset) {
      nha = {
        asset_id: parentAsset.asset_id,
        serno: parentAsset.serno,
        partno: parentAsset.partno,
        part_name: parentAsset.part_name,
        status_cd: parentAsset.status_cd,
        status_name: parentAsset.status_name,
      };
    }
  }

  // Get child assets (SRA - Shop Replaceable Assemblies)
  const sra = detailedAssets
    .filter(a => a.nha_asset_id === assetId)
    .map(child => ({
      asset_id: child.asset_id,
      serno: child.serno,
      partno: child.partno,
      part_name: child.part_name,
      status_cd: child.status_cd,
      status_name: child.status_name,
    }));

  console.log(`[ASSETS] Hierarchy request by ${user.username} for asset ${assetId}: NHA=${nha?.serno || 'none'}, SRA count=${sra.length}`);

  res.json({
    asset: {
      asset_id: asset.asset_id,
      serno: asset.serno,
      partno: asset.partno,
      part_name: asset.part_name,
      status_cd: asset.status_cd,
      status_name: asset.status_name,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    },
    nha,
    sra,
    has_nha: nha !== null,
    has_sra: sra.length > 0,
  });
});

// GET /api/assets/:id/history - Get asset change history (requires authentication)
app.get('/api/assets/:id/history', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);

  try {
    // First try to find asset in mockAssets (in-memory)
    let asset = mockAssets.find(a => a.asset_id === assetId);
    let assetSerno = asset?.serno;
    let assetPgmId = asset?.pgm_id;

    // If not found in mockAssets, try database
    if (!asset) {
      const dbAsset = await prisma.asset.findUnique({
        where: { asset_id: assetId },
        include: {
          part: {
            select: { pgm_id: true }
          }
        }
      });

      if (!dbAsset || !dbAsset.active) {
        return res.status(404).json({ error: 'Asset not found' });
      }

      assetSerno = dbAsset.serno;
      assetPgmId = dbAsset.part?.pgm_id || 1;
    }

    // Check if user has access to this asset's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (assetPgmId && !userProgramIds.includes(assetPgmId) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this asset' });
    }

    // Get history entries for this asset, sorted by timestamp descending (most recent first)
    const history = assetHistory
      .filter(h => h.asset_id === assetId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    console.log(`[ASSETS] History request by ${user.username} for asset ${assetSerno} (ID: ${assetId}) - ${history.length} entries`);

    res.json({
      asset_id: assetId,
      serno: assetSerno,
      history,
      total: history.length,
    });
  } catch (error) {
    console.error('[ASSETS] Error fetching asset history:', error);
    return res.status(500).json({ error: 'Failed to fetch asset history' });
  }
});

// GET /api/assets/:id/eti-history - Get ETI (Elapsed Time Indicator) history for an asset
app.get('/api/assets/:id/eti-history', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);
  const asset = detailedAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Get query parameter for meter type filtering
  const meterTypeFilter = req.query.meter_type as string | undefined;

  // Get meter history entries for this asset, sorted by timestamp descending (most recent first)
  let history = meterHistory
    .filter(h => h.asset_id === assetId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Filter by meter type if specified
  if (meterTypeFilter && ['hours', 'cycles', 'eti'].includes(meterTypeFilter)) {
    history = history.filter(h => h.meter_type === meterTypeFilter);
  }

  console.log(`[METER] History request by ${user.username} for asset ${asset.serno} (ID: ${assetId}) - ${history.length} entries`);

  res.json({
    asset_id: assetId,
    serno: asset.serno,
    current_eti_hours: asset.eti_hours,
    current_cycles_count: asset.cycles_count,
    meter_type: asset.meter_type,
    history,
    total: history.length,
  });
});

// POST /api/assets/:id/eti - Update ETI hours for an asset (requires authentication and depot_manager/admin/field_technician role)
app.post('/api/assets/:id/eti', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can update ETI
  if (!['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to update ETI hours' });
  }

  const assetId = parseInt(req.params.id, 10);
  const asset = detailedAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  const { hours_to_add, new_eti_hours, source, source_ref, notes } = req.body;

  // Validate input - either hours_to_add or new_eti_hours must be provided
  if (hours_to_add === undefined && new_eti_hours === undefined) {
    return res.status(400).json({ error: 'Either hours_to_add or new_eti_hours must be provided' });
  }

  // Validate source
  const validSources: Array<'maintenance' | 'manual' | 'sortie'> = ['maintenance', 'manual', 'sortie'];
  const sourceType = source || 'manual';
  if (!validSources.includes(sourceType)) {
    return res.status(400).json({ error: 'Invalid source. Must be maintenance, manual, or sortie' });
  }

  const oldETI = asset.eti_hours;
  let calculatedHoursAdded: number;
  let calculatedNewETI: number;

  if (new_eti_hours !== undefined) {
    // Direct ETI value set
    calculatedNewETI = parseFloat(new_eti_hours);
    if (isNaN(calculatedNewETI) || calculatedNewETI < 0) {
      return res.status(400).json({ error: 'new_eti_hours must be a non-negative number' });
    }
    calculatedHoursAdded = calculatedNewETI - (oldETI || 0);
  } else {
    // Add hours to existing
    calculatedHoursAdded = parseFloat(hours_to_add);
    if (isNaN(calculatedHoursAdded)) {
      return res.status(400).json({ error: 'hours_to_add must be a valid number' });
    }
    calculatedNewETI = (oldETI || 0) + calculatedHoursAdded;
    if (calculatedNewETI < 0) {
      return res.status(400).json({ error: 'ETI hours cannot be negative' });
    }
  }

  // Update the asset's ETI
  asset.eti_hours = calculatedNewETI;

  // Also update the mockAssets entry if exists
  const mockAsset = mockAssets.find(a => a.asset_id === assetId);
  // Note: mockAssets doesn't have eti_hours, but detailedAssets does

  // Add ETI history entry
  const historyEntry = addETIHistory(
    assetId,
    user,
    oldETI,
    calculatedNewETI,
    calculatedHoursAdded,
    sourceType,
    null,  // source_id - could be linked to maintenance event
    source_ref || null,
    notes || null
  );

  // Add to asset history as well
  const historyChanges: AssetHistoryChange[] = [{
    field: 'eti_hours',
    field_label: 'ETI Hours',
    old_value: oldETI?.toString() || '0',
    new_value: calculatedNewETI.toString()
  }];

  addAssetHistory(
    assetId,
    user,
    'update',
    historyChanges,
    `Updated ETI hours: ${oldETI || 0} → ${calculatedNewETI} (${calculatedHoursAdded >= 0 ? '+' : ''}${calculatedHoursAdded} hours via ${sourceType})`
  );

  console.log(`[ETI] Updated by ${user.username} for asset ${asset.serno}: ${oldETI || 0} → ${calculatedNewETI} (${calculatedHoursAdded >= 0 ? '+' : ''}${calculatedHoursAdded})`);

  res.json({
    message: 'ETI hours updated successfully',
    asset_id: assetId,
    serno: asset.serno,
    old_eti_hours: oldETI,
    new_eti_hours: calculatedNewETI,
    hours_added: calculatedHoursAdded,
    history_entry: historyEntry,
  });
});

// POST /api/assets/:id/meter - Add meter reading for an asset (supports hours, cycles, ETI)
app.post('/api/assets/:id/meter', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - ADMIN, DEPOT_MANAGER, and FIELD_TECHNICIAN can add meter readings
  if (!['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to add meter readings' });
  }

  const assetId = parseInt(req.params.id, 10);
  const asset = detailedAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  const { meter_type, value_to_add, new_value, source, source_ref, notes } = req.body;

  // Validate meter_type
  const validMeterTypes: Array<'hours' | 'cycles' | 'eti'> = ['hours', 'cycles', 'eti'];
  if (!meter_type || !validMeterTypes.includes(meter_type)) {
    return res.status(400).json({ error: 'meter_type must be one of: hours, cycles, eti' });
  }

  // Validate input - either value_to_add or new_value must be provided
  if (value_to_add === undefined && new_value === undefined) {
    return res.status(400).json({ error: 'Either value_to_add or new_value must be provided' });
  }

  // Validate source
  const validSources: Array<'maintenance' | 'manual' | 'sortie'> = ['maintenance', 'manual', 'sortie'];
  const sourceType = source || 'manual';
  if (!validSources.includes(sourceType)) {
    return res.status(400).json({ error: 'Invalid source. Must be maintenance, manual, or sortie' });
  }

  // Get old value based on meter type
  let oldValue: number | null;
  if (meter_type === 'cycles') {
    oldValue = asset.cycles_count;
  } else {
    // 'hours' or 'eti' both use eti_hours field
    oldValue = asset.eti_hours;
  }

  let calculatedValueAdded: number;
  let calculatedNewValue: number;

  if (new_value !== undefined) {
    // Direct value set
    calculatedNewValue = parseFloat(new_value);
    if (isNaN(calculatedNewValue) || calculatedNewValue < 0) {
      return res.status(400).json({ error: 'new_value must be a non-negative number' });
    }
    calculatedValueAdded = calculatedNewValue - (oldValue || 0);
  } else {
    // Add value to existing
    calculatedValueAdded = parseFloat(value_to_add);
    if (isNaN(calculatedValueAdded)) {
      return res.status(400).json({ error: 'value_to_add must be a valid number' });
    }
    calculatedNewValue = (oldValue || 0) + calculatedValueAdded;
    if (calculatedNewValue < 0) {
      return res.status(400).json({ error: 'Meter value cannot be negative' });
    }
  }

  // Update the asset's meter value based on type
  if (meter_type === 'cycles') {
    asset.cycles_count = calculatedNewValue;
  } else {
    // 'hours' or 'eti' both use eti_hours field
    asset.eti_hours = calculatedNewValue;
  }

  // Also set/update the meter_type if not already set
  if (!asset.meter_type) {
    asset.meter_type = meter_type;
  }

  // Add meter history entry
  const historyEntry = addMeterHistory(
    assetId,
    user,
    meter_type,
    oldValue,
    calculatedNewValue,
    calculatedValueAdded,
    sourceType,
    null,  // source_id - could be linked to maintenance event
    source_ref || null,
    notes || null
  );

  // Add to asset history as well
  const meterLabel = meter_type === 'cycles' ? 'Cycles' : meter_type === 'eti' ? 'ETI Hours' : 'Hours';
  const historyChanges: AssetHistoryChange[] = [{
    field: meter_type === 'cycles' ? 'cycles_count' : 'eti_hours',
    field_label: meterLabel,
    old_value: oldValue?.toString() || '0',
    new_value: calculatedNewValue.toString()
  }];

  addAssetHistory(
    assetId,
    user,
    'update',
    historyChanges,
    `Updated ${meterLabel}: ${oldValue || 0} → ${calculatedNewValue} (${calculatedValueAdded >= 0 ? '+' : ''}${calculatedValueAdded} via ${sourceType})`
  );

  console.log(`[METER] ${meter_type} updated by ${user.username} for asset ${asset.serno}: ${oldValue || 0} → ${calculatedNewValue} (${calculatedValueAdded >= 0 ? '+' : ''}${calculatedValueAdded})`);

  res.json({
    message: `${meterLabel} updated successfully`,
    asset_id: assetId,
    serno: asset.serno,
    meter_type: meter_type,
    old_value: oldValue,
    new_value: calculatedNewValue,
    value_added: calculatedValueAdded,
    history_entry: historyEntry,
  });
});

// POST /api/assets/:id/replace-meter - Replace a meter on an asset (requires depot_manager or admin)
app.post('/api/assets/:id/replace-meter', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - Only DEPOT_MANAGER and ADMIN can replace meters
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to replace meters' });
  }

  const assetId = parseInt(req.params.id, 10);
  const asset = detailedAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  const { replacement_reason, new_meter_start_value, notes } = req.body;

  // Validate input
  if (!replacement_reason || replacement_reason.trim() === '') {
    return res.status(400).json({ error: 'Replacement reason is required' });
  }

  if (new_meter_start_value === undefined || new_meter_start_value === null) {
    return res.status(400).json({ error: 'New meter starting value is required' });
  }

  const parsedStartValue = parseFloat(new_meter_start_value);
  if (isNaN(parsedStartValue) || parsedStartValue < 0) {
    return res.status(400).json({ error: 'New meter start value must be a non-negative number' });
  }

  // Get the meter type for this asset (default to 'eti' if not set)
  const meterType = asset.meter_type || 'eti';

  // Store old meter value
  const oldMeterValue = asset.eti_hours;

  // Create meter replacement entry
  const replacementEntry = addMeterReplacement(
    assetId,
    user,
    meterType,
    oldMeterValue,
    parsedStartValue,
    replacement_reason.trim(),
    notes || null
  );

  // Add a special meter history entry marking the replacement
  addMeterHistory(
    assetId,
    user,
    meterType,
    oldMeterValue,
    parsedStartValue,
    parsedStartValue - (oldMeterValue || 0),
    'manual',
    replacementEntry.replacement_id,
    `METER-REPLACEMENT-${replacementEntry.replacement_id}`,
    `Meter replaced: ${replacement_reason}. Old meter: ${oldMeterValue || 0}, New meter start: ${parsedStartValue}`
  );

  // Update the asset's meter value to the new starting value
  asset.eti_hours = parsedStartValue;

  // Add to asset history
  const historyChanges: AssetHistoryChange[] = [{
    field: 'eti_hours',
    field_label: 'Meter Reading',
    old_value: oldMeterValue?.toString() || '0',
    new_value: parsedStartValue.toString()
  }];

  addAssetHistory(
    assetId,
    user,
    'update',
    historyChanges,
    `Meter replaced: ${replacement_reason}. Old meter final reading: ${oldMeterValue || 0}, New meter starting value: ${parsedStartValue}`
  );

  console.log(`[METER-REPLACEMENT] Asset ${asset.serno}: ${user.username} replaced ${meterType} meter - Old: ${oldMeterValue || 0}, New Start: ${parsedStartValue} - Reason: ${replacement_reason}`);

  res.json({
    message: 'Meter replaced successfully',
    asset_id: assetId,
    serno: asset.serno,
    meter_type: meterType,
    old_meter_value: oldMeterValue,
    new_meter_start_value: parsedStartValue,
    replacement_reason: replacement_reason.trim(),
    replacement_entry: replacementEntry,
  });
});

// GET /api/assets/:id/meter-history - Get ETM (Engineering Time Meters) history for an asset
// Returns all meter in/out readings from maintenance repairs
app.get('/api/assets/:id/meter-history', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);

  // First try to find asset in detailedAssets (in-memory sample data)
  let asset = detailedAssets.find(a => a.asset_id === assetId);

  // If not found in detailedAssets, try database
  let dbAsset = null;
  if (!asset) {
    dbAsset = await prisma.asset.findUnique({
      where: { asset_id: assetId },
      include: {
        part: {
          select: {
            pgm_id: true
          }
        }
      }
    });

    if (!dbAsset || !dbAsset.active) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    // Check if user has access to this asset's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(dbAsset.part.pgm_id) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this asset' });
    }
  } else {
    // Check if user has access to this asset's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this asset' });
    }
  }

  // Get all repairs for this asset that have meter readings
  // First check in-memory repairs (for detailedAssets)
  let assetRepairs = repairs
    .filter(r => r.asset_id === assetId && (r.eti_in !== null || r.eti_out !== null))
    .map(r => ({
      ...r,
      isFromMemory: true
    }));

  // If asset is from database, also query database repairs
  if (dbAsset) {
    try {
      const dbRepairs = await prisma.repair.findMany({
        where: {
          asset_id: assetId,
          OR: [
            { eti_in: { not: null } },
            { eti_out: { not: null } }
          ]
        },
        include: {
          event: {
            select: {
              job_no: true
            }
          }
        },
        orderBy: {
          start_date: 'desc'
        }
      });

      // Merge database repairs with in-memory repairs
      const dbRepairsFormatted = dbRepairs.map(r => ({
        repair_id: r.repair_id,
        event_id: r.event_id,
        asset_id: r.asset_id,
        job_no: r.event?.job_no || null,
        start_date: r.start_date.toISOString(),
        stop_date: r.stop_date ? r.stop_date.toISOString() : null,
        type_maint: r.type_maint,
        shop_status: r.shop_status,
        eti_in: r.eti_in,
        eti_out: r.eti_out,
        eti_delta: r.eti_delta,
        narrative: r.narrative,
        created_by_name: r.tech_name || 'Unknown',
        created_at: r.created_at.toISOString(),
        isFromMemory: false
      }));

      // Combine and deduplicate by repair_id
      const allRepairs = [...assetRepairs, ...dbRepairsFormatted];
      const repairMap = new Map();

      allRepairs.forEach(r => {
        if (!repairMap.has(r.repair_id)) {
          repairMap.set(r.repair_id, r);
        }
      });

      assetRepairs = Array.from(repairMap.values())
        .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime());
    } catch (error) {
      console.error('[METER] Error fetching repairs from database:', error);
    }
  }

  // Get maintenance events for additional context (only for in-memory repairs)
  const eventIds = assetRepairs.filter(r => r.isFromMemory).map(r => r.event_id);
  const relatedEvents = maintenanceEvents.filter(e => eventIds.includes(e.event_id));

  // Build meter history entries with event context
  const meterHistory = assetRepairs.map(repair => {
    // For in-memory repairs, get event from maintenanceEvents array
    // For database repairs, event data is already included
    const event = repair.isFromMemory
      ? relatedEvents.find(e => e.event_id === repair.event_id)
      : { job_no: repair.job_no };

    return {
      repair_id: repair.repair_id,
      event_id: repair.event_id,
      job_no: event?.job_no || null,
      start_date: repair.start_date,
      stop_date: repair.stop_date,
      type_maint: repair.type_maint,
      shop_status: repair.shop_status,
      eti_in: repair.eti_in,
      eti_out: repair.eti_out,
      eti_delta: repair.eti_delta,
      narrative: repair.narrative,
      created_by: repair.created_by_name,
      created_at: repair.created_at,
    };
  });

  const serno = asset?.serno || dbAsset?.serno || 'Unknown';
  const etiHours = asset?.eti_hours || dbAsset?.eti_hours || 0;

  console.log(`[METER] History request by ${user.username} for asset ${serno} (ID: ${assetId}) - ${meterHistory.length} entries`);

  res.json({
    asset_id: assetId,
    serno: serno,
    current_eti_hours: etiHours,
    meter_history: meterHistory,
    total: meterHistory.length,
  });
});

// GET /api/assets/:id/events - Get maintenance events linked to an asset
app.get('/api/assets/:id/events', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);
  const asset = mockAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Find all maintenance events linked to this asset
  const assetEvents = maintenanceEvents
    .filter(e => e.asset_id === assetId)
    .sort((a, b) => new Date(b.start_job).getTime() - new Date(a.start_job).getTime());

  // Calculate summary statistics
  const summary = {
    total: assetEvents.length,
    open: assetEvents.filter(e => e.status === 'open').length,
    closed: assetEvents.filter(e => e.status === 'closed').length,
    by_type: {
      standard: assetEvents.filter(e => e.event_type === 'Standard').length,
      pmi: assetEvents.filter(e => e.event_type === 'PMI').length,
      tcto: assetEvents.filter(e => e.event_type === 'TCTO').length,
      bitpc: assetEvents.filter(e => e.event_type === 'BIT/PC').length,
    },
  };

  console.log(`[ASSETS] Events request by ${user.username} for asset ${asset.serno} (ID: ${assetId}) - ${assetEvents.length} events`);

  res.json({
    asset_id: assetId,
    serno: asset.serno,
    events: assetEvents,
    summary,
    total: assetEvents.length,
  });
});

// GET /api/assets/:id/software - Get software associations for an asset
app.get('/api/assets/:id/software', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const assetId = parseInt(req.params.id, 10);
  const asset = mockAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Find all software associations for this asset
  const associations = assetSoftware
    .filter(assoc => assoc.asset_id === assetId)
    .map(assoc => {
      const software = softwareCatalog.find(sw => sw.sw_id === assoc.sw_id);
      return {
        assoc_id: assoc.assoc_id,
        asset_id: assoc.asset_id,
        sw_version_id: assoc.sw_id,
        sw_version: software?.revision || 'Unknown',
        sw_name: software?.sw_title || 'Unknown Software',
        sw_number: software?.sw_number || '',
        sw_type: software?.sw_type || '',
        effective_date: assoc.effective_date,
        end_date: assoc.end_date,
        created_by: assoc.created_by,
        created_date: assoc.created_date,
      };
    })
    .sort((a, b) => new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime());

  console.log(`[ASSETS] Software associations request by ${user.username} for asset ${asset.serno} (ID: ${assetId}) - ${associations.length} associations`);

  res.json({
    asset_id: assetId,
    serno: asset.serno,
    associations,
    total: associations.length,
  });
});

// POST /api/assets/:id/software - Add software association to an asset
app.post('/api/assets/:id/software', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN and DEPOT_MANAGER can add software associations
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to add software associations' });
  }

  const assetId = parseInt(req.params.id, 10);
  const asset = mockAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  const { sw_version_id, effective_date } = req.body;

  // Validate input
  if (!sw_version_id || !effective_date) {
    return res.status(400).json({ error: 'Software version and effective date are required' });
  }

  const swId = parseInt(sw_version_id, 10);
  const software = softwareCatalog.find(sw => sw.sw_id === swId);

  if (!software) {
    return res.status(404).json({ error: 'Software version not found' });
  }

  // Check if asset's program matches software's program (unless admin)
  if (asset.pgm_id !== software.pgm_id && user.role !== 'ADMIN') {
    return res.status(400).json({ error: 'Software version is not compatible with this asset\'s program' });
  }

  // Check if association already exists (active)
  const existingAssoc = assetSoftware.find(
    assoc => assoc.asset_id === assetId && assoc.sw_id === swId && assoc.end_date === null
  );

  if (existingAssoc) {
    return res.status(400).json({ error: 'This software version is already associated with this asset' });
  }

  // Create new association
  const newAssociation: AssetSoftware = {
    assoc_id: nextAssetSwId++,
    asset_id: assetId,
    sw_id: swId,
    effective_date: effective_date,
    end_date: null,
    created_by: user.username,
    created_date: new Date().toISOString().split('T')[0],
  };

  assetSoftware.push(newAssociation);

  console.log(`[ASSETS] Software association added by ${user.username} for asset ${asset.serno}: ${software.sw_title} (${software.revision})`);

  res.status(201).json({
    message: 'Software association added successfully',
    association: {
      assoc_id: newAssociation.assoc_id,
      asset_id: newAssociation.asset_id,
      sw_version_id: newAssociation.sw_id,
      sw_version: software.revision,
      sw_name: software.sw_title,
      sw_number: software.sw_number,
      sw_type: software.sw_type,
      effective_date: newAssociation.effective_date,
      end_date: newAssociation.end_date,
      created_by: newAssociation.created_by,
      created_date: newAssociation.created_date,
    },
  });
});

// DELETE /api/assets/:id/software/:assocId - Remove software association from an asset
app.delete('/api/assets/:id/software/:assocId', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN and DEPOT_MANAGER can remove software associations
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to remove software associations' });
  }

  const assetId = parseInt(req.params.id, 10);
  const assocId = parseInt(req.params.assocId, 10);

  if (isNaN(assetId) || isNaN(assocId)) {
    return res.status(400).json({ error: 'Invalid asset ID or association ID' });
  }

  const asset = mockAssets.find(a => a.asset_id === assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Find the association
  const assocIndex = assetSoftware.findIndex(
    assoc => assoc.assoc_id === assocId && assoc.asset_id === assetId
  );

  if (assocIndex === -1) {
    return res.status(404).json({ error: 'Software association not found' });
  }

  // Get association details before removing
  const removedAssoc = assetSoftware[assocIndex];
  const software = softwareCatalog.find(sw => sw.sw_id === removedAssoc.sw_id);

  // Remove the association
  assetSoftware.splice(assocIndex, 1);

  console.log(`[ASSETS] Software association removed by ${user.username} for asset ${asset.serno}: ${software?.sw_title || 'Unknown'} (assoc_id: ${assocId})`);

  res.json({
    message: 'Software association removed successfully',
    assoc_id: assocId,
  });
});

// PUT /api/assets/:id - Update an existing asset (requires authentication and depot_manager/admin role)
app.put('/api/assets/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN and DEPOT_MANAGER can update assets
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to modify assets' });
  }

  const assetId = parseInt(req.params.id, 10);

  try {
    // Load code cache for lookups
    const codes = await loadCodeCache();

    // Always read from database
    const dbAsset = await prisma.asset.findUnique({
      where: { asset_id: assetId },
      include: {
        part: { select: { partno: true, noun: true, pgm_id: true, program: { select: { pgm_cd: true, pgm_name: true } } } },
        assignedLocation: { select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true } },
        currentLocation: { select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true } },
      }
    });

    if (!dbAsset || !dbAsset.active) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    // Check if user has access to this asset's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    const assetPgmId = dbAsset.part?.pgm_id;
    if (assetPgmId && !userProgramIds.includes(assetPgmId) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this asset' });
    }

    const { status_cd, status_reason, uii, next_ndi_date, remarks, notes, bad_actor, in_transit, carrier, tracking_number, ship_date, active, admin_loc, cust_loc, loc_ida, loc_idc } = req.body;

    // Track changes for audit log
    const changes: string[] = [];
    const historyChanges: AssetHistoryChange[] = [];
    const updateData: any = {
      chg_date: new Date(),
      chg_by: user.username
    };

    // Resolve current status for display
    const currentStatusCd = resolveCodeId(dbAsset.status_cd, codes) || dbAsset.status_cd;

    // --- Status change ---
    if (status_cd !== undefined && status_cd !== currentStatusCd) {
      const validStatuses = assetStatusCodes.map(s => s.status_cd);
      if (!validStatuses.includes(status_cd)) {
        return res.status(400).json({ error: 'Invalid status code' });
      }

      const transitionResult = isValidStatusTransition(currentStatusCd, status_cd);
      if (!transitionResult.valid) {
        return res.status(400).json({ error: transitionResult.message });
      }

      // Require reason for NMC statuses
      const nmcStatuses = ['NMCM', 'NMCS', 'NMCB'];
      if (nmcStatuses.includes(status_cd) && !status_reason) {
        return res.status(400).json({ error: 'Status change reason is required when changing to a non-mission-capable status.' });
      }

      const oldName = getStatusName(currentStatusCd);
      const newName = getStatusName(status_cd);
      const changeMsg = status_reason ? `Status: ${oldName} → ${newName} (Reason: ${status_reason})` : `Status: ${oldName} → ${newName}`;
      changes.push(changeMsg);
      historyChanges.push({ field: 'status_cd', field_label: 'Status', old_value: oldName, new_value: status_reason ? `${newName} (Reason: ${status_reason})` : newName });
      updateData.status_cd = status_cd;
    }

    // --- UII ---
    if (uii !== undefined && uii !== (dbAsset.uii || '')) {
      const oldUii = dbAsset.uii || '(not assigned)';
      const newUii = uii || '(not assigned)';
      changes.push(`UII: ${oldUii} → ${newUii}`);
      historyChanges.push({ field: 'uii', field_label: 'UII (Unique Item Identifier)', old_value: oldUii, new_value: newUii });
      updateData.uii = uii || null;
    }

    // --- Next NDI Date ---
    if (next_ndi_date !== undefined) {
      const oldNdi = dbAsset.next_ndi_date ? dbAsset.next_ndi_date.toISOString().split('T')[0] : '(not assigned)';
      const newNdi = next_ndi_date || '(not assigned)';
      if (oldNdi !== newNdi) {
        changes.push(`Next NDI Date: ${oldNdi} → ${newNdi}`);
        historyChanges.push({ field: 'next_ndi_date', field_label: 'Next NDI Date', old_value: oldNdi, new_value: newNdi });
        updateData.next_ndi_date = next_ndi_date ? new Date(next_ndi_date) : null;
      }
    }

    // --- Remarks/Notes ---
    const newRemarks = remarks !== undefined ? remarks : notes;
    if (newRemarks !== undefined && newRemarks !== (dbAsset.remarks || '')) {
      const oldRemarks = dbAsset.remarks || '(empty)';
      changes.push(`Notes: "${oldRemarks}" → "${newRemarks || '(empty)'}"`);
      historyChanges.push({ field: 'remarks', field_label: 'Notes', old_value: oldRemarks, new_value: newRemarks || '(empty)' });
      updateData.remarks = newRemarks || null;
    }

    // --- Bad Actor ---
    if (bad_actor !== undefined && bad_actor !== dbAsset.bad_actor) {
      changes.push(`Bad Actor: ${dbAsset.bad_actor ? 'Yes' : 'No'} → ${bad_actor ? 'Yes' : 'No'}`);
      historyChanges.push({ field: 'bad_actor', field_label: 'Bad Actor', old_value: dbAsset.bad_actor ? 'Yes' : 'No', new_value: bad_actor ? 'Yes' : 'No' });
      updateData.bad_actor = bad_actor;
    }

    // --- In Transit ---
    if (in_transit !== undefined && in_transit !== dbAsset.in_transit) {
      changes.push(`In Transit: ${dbAsset.in_transit ? 'Yes' : 'No'} → ${in_transit ? 'Yes' : 'No'}`);
      historyChanges.push({ field: 'in_transit', field_label: 'In Transit', old_value: dbAsset.in_transit ? 'Yes' : 'No', new_value: in_transit ? 'Yes' : 'No' });
      updateData.in_transit = in_transit;
      // If setting in_transit to false, clear shipping info
      if (!in_transit) {
        updateData.shipper = null;
        updateData.tcn = null;
        updateData.ship_date = null;
      }
    }

    // --- Carrier/Shipper ---
    if (carrier !== undefined && carrier !== (dbAsset.shipper || '')) {
      changes.push(`Carrier: ${dbAsset.shipper || '(none)'} → ${carrier || '(none)'}`);
      historyChanges.push({ field: 'carrier', field_label: 'Carrier', old_value: dbAsset.shipper || '(none)', new_value: carrier || '(none)' });
      updateData.shipper = carrier || null;
    }

    // --- Tracking Number (TCN) ---
    if (tracking_number !== undefined && tracking_number !== (dbAsset.tcn || '')) {
      changes.push(`Tracking Number: ${dbAsset.tcn || '(none)'} → ${tracking_number || '(none)'}`);
      historyChanges.push({ field: 'tracking_number', field_label: 'Tracking Number', old_value: dbAsset.tcn || '(none)', new_value: tracking_number || '(none)' });
      updateData.tcn = tracking_number || null;
    }

    // --- Ship Date ---
    if (ship_date !== undefined) {
      const oldShip = dbAsset.ship_date ? dbAsset.ship_date.toISOString().split('T')[0] : '(none)';
      const newShip = ship_date || '(none)';
      if (oldShip !== newShip) {
        changes.push(`Ship Date: ${oldShip} → ${newShip}`);
        historyChanges.push({ field: 'ship_date', field_label: 'Ship Date', old_value: oldShip, new_value: newShip });
        updateData.ship_date = ship_date ? new Date(ship_date) : null;
      }
    }

    // --- Active ---
    if (active !== undefined && active !== dbAsset.active) {
      changes.push(`Active: ${dbAsset.active ? 'Yes' : 'No'} → ${active ? 'Yes' : 'No'}`);
      historyChanges.push({ field: 'active', field_label: 'Active', old_value: dbAsset.active ? 'Yes' : 'No', new_value: active ? 'Yes' : 'No' });
      updateData.active = active;
    }

    // --- Assigned Location (loc_ida) ---
    const newLocIda = loc_ida !== undefined ? loc_ida : (admin_loc !== undefined ? admin_loc : undefined);
    if (newLocIda !== undefined) {
      const locId = typeof newLocIda === 'number' ? newLocIda : parseInt(newLocIda, 10);
      if (!isNaN(locId) && locId !== dbAsset.loc_ida) {
        const newLoc = await prisma.location.findUnique({ where: { loc_id: locId }, select: { display_name: true } });
        if (!newLoc) {
          return res.status(400).json({ error: 'Invalid assigned location' });
        }
        const oldLocName = dbAsset.assignedLocation?.display_name || '(none)';
        changes.push(`Assigned Location: ${oldLocName} → ${newLoc.display_name}`);
        historyChanges.push({ field: 'loc_ida', field_label: 'Assigned Location', old_value: oldLocName, new_value: newLoc.display_name || String(locId) });
        updateData.loc_ida = locId;
      }
    }

    // --- Current Location (loc_idc) ---
    const newLocIdc = loc_idc !== undefined ? loc_idc : (cust_loc !== undefined ? cust_loc : undefined);
    if (newLocIdc !== undefined) {
      const locId = typeof newLocIdc === 'number' ? newLocIdc : parseInt(newLocIdc, 10);
      if (!isNaN(locId) && locId !== dbAsset.loc_idc) {
        const newLoc = await prisma.location.findUnique({ where: { loc_id: locId }, select: { display_name: true } });
        if (!newLoc) {
          return res.status(400).json({ error: 'Invalid current location' });
        }
        const oldLocName = dbAsset.currentLocation?.display_name || '(none)';
        changes.push(`Current Location: ${oldLocName} → ${newLoc.display_name}`);
        historyChanges.push({ field: 'loc_idc', field_label: 'Current Location', old_value: oldLocName, new_value: newLoc.display_name || String(locId) });
        updateData.loc_idc = locId;
      }
    }

    // No changes detected
    if (changes.length === 0) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    // Persist to database
    const updatedAsset = await prisma.asset.update({
      where: { asset_id: assetId },
      data: updateData,
      include: {
        part: { select: { partno: true, noun: true, pgm_id: true, program: { select: { pgm_cd: true, pgm_name: true } } } },
        assignedLocation: { select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true } },
        currentLocation: { select: { loc_id: true, display_name: true, majcom_cd: true, site_cd: true, unit_cd: true } },
      }
    });

    // Log to asset history
    if (historyChanges.length > 0) {
      addAssetHistory(
        assetId,
        user,
        'update',
        historyChanges,
        `Updated asset ${dbAsset.serno}: ${changes.join('; ')}`
      );
    }

    // Helper to format location display
    const formatLocation = (loc: { display_name: string; majcom_cd?: string | null; site_cd?: string | null; unit_cd?: string | null } | null) => {
      if (!loc) return 'Unknown';
      const majcom = resolveCodeId(loc.majcom_cd, codes);
      const site = resolveCodeId(loc.site_cd, codes);
      const unit = resolveCodeId(loc.unit_cd, codes);
      const parts = [majcom, site, unit].filter(Boolean);
      if (parts.length > 0) return parts.join('/');
      if (loc.display_name && !loc.display_name.match(/^\d+\/\d+\/\d+$/)) return loc.display_name;
      return 'Unknown';
    };

    const resolvedStatusCd = resolveCodeId(updatedAsset.status_cd, codes) || updatedAsset.status_cd;

    // Build audit log
    const now = new Date();
    const newActivity: ActivityLogEntry = {
      activity_id: 1000 + dynamicActivityLog.length + 1,
      timestamp: now.toISOString(),
      user_id: user.user_id,
      username: user.username,
      user_full_name: `${user.first_name} ${user.last_name}`,
      action_type: 'update',
      entity_type: 'asset',
      entity_id: assetId,
      entity_name: dbAsset.serno,
      description: `Updated asset ${dbAsset.serno}: ${changes.join('; ')}`,
      pgm_id: dbAsset.part?.pgm_id || 1,
    };
    dynamicActivityLog.push(newActivity);

    // Log the audit to database
    const oldValues: any = {
      status_cd: currentStatusCd,
      uii: dbAsset.uii,
      next_ndi_date: dbAsset.next_ndi_date,
      remarks: dbAsset.remarks,
      bad_actor: dbAsset.bad_actor,
      in_transit: dbAsset.in_transit,
      shipper: dbAsset.shipper,
      tcn: dbAsset.tcn,
      ship_date: dbAsset.ship_date,
      active: dbAsset.active,
      loc_ida: dbAsset.loc_ida,
      loc_idc: dbAsset.loc_idc,
    };
    const newValues: any = { ...oldValues, ...updateData };
    delete newValues.chg_date;
    delete newValues.chg_by;

    await logAuditAction(
      user.user_id,
      'UPDATE',
      'asset',
      assetId,
      oldValues,
      newValues,
      req
    );

    console.log(`[ASSETS-DB] Asset updated by ${user.username}: ${dbAsset.serno} (ID: ${assetId})`);
    console.log(`[ASSETS-DB] Changes: ${changes.join(', ')}`);

    // Return updated asset in frontend-expected format
    res.json({
      message: 'Asset updated successfully',
      asset: {
        asset_id: updatedAsset.asset_id,
        serno: updatedAsset.serno,
        partno: updatedAsset.part?.partno || '',
        part_name: updatedAsset.part?.noun || '',
        name: updatedAsset.part?.noun || '',
        pgm_id: updatedAsset.part?.pgm_id || 1,
        status_cd: resolvedStatusCd || 'FMC',
        status_name: getStatusName(resolvedStatusCd),
        active: updatedAsset.active,
        admin_loc: formatLocation(updatedAsset.assignedLocation),
        admin_loc_name: formatLocation(updatedAsset.assignedLocation),
        cust_loc: formatLocation(updatedAsset.currentLocation),
        cust_loc_name: formatLocation(updatedAsset.currentLocation),
        location: formatLocation(updatedAsset.assignedLocation) || formatLocation(updatedAsset.currentLocation) || 'Unknown',
        loc_type: 'depot' as const,
        in_transit: updatedAsset.in_transit || false,
        bad_actor: updatedAsset.bad_actor || false,
        eti_hours: updatedAsset.eti ? Number(updatedAsset.eti) : null,
        remarks: updatedAsset.remarks,
        notes: updatedAsset.remarks || '',
        uii: updatedAsset.uii,
        mfg_date: updatedAsset.mfg_date?.toISOString().split('T')[0] || null,
        acceptance_date: updatedAsset.accept_date?.toISOString().split('T')[0] || null,
        next_ndi_date: updatedAsset.next_ndi_date?.toISOString().split('T')[0] || null,
        nha_asset_id: updatedAsset.nha_asset_id,
        carrier: updatedAsset.shipper,
        tracking_number: updatedAsset.tcn,
        ship_date: updatedAsset.ship_date?.toISOString().split('T')[0] || null,
        created_date: updatedAsset.ins_date?.toISOString() || new Date().toISOString(),
        modified_date: updatedAsset.chg_date?.toISOString() || null,
        program_cd: updatedAsset.part?.program?.pgm_cd || 'UNKNOWN',
        program_name: updatedAsset.part?.program?.pgm_name || 'Unknown Program',
      },
      changes,
      audit: newActivity,
    });
  } catch (error) {
    console.error('[ASSETS-DB] Error updating asset:', error);
    res.status(500).json({ error: 'Failed to update asset' });
  }
});

// POST /api/assets/mass-update - Mass update multiple assets (requires authentication and depot_manager/admin role)
app.post('/api/assets/mass-update', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN and DEPOT_MANAGER can update assets
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to modify assets' });
  }

  const { asset_ids, field, value } = req.body;

  // Validate inputs
  if (!asset_ids || !Array.isArray(asset_ids) || asset_ids.length === 0) {
    return res.status(400).json({ error: 'asset_ids must be a non-empty array' });
  }

  if (!field || !value) {
    return res.status(400).json({ error: 'field and value are required' });
  }

  // Validate field name (only allow specific fields to be mass updated)
  const allowedFields = ['status_cd', 'admin_loc', 'cust_loc'];
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: `Field '${field}' cannot be mass updated. Allowed fields: ${allowedFields.join(', ')}` });
  }

  // Validate value based on field
  if (field === 'status_cd') {
    const validStatuses = assetStatusCodes.map(s => s.status_cd);
    if (!validStatuses.includes(value)) {
      return res.status(400).json({ error: 'Invalid status code' });
    }
  } else if (field === 'admin_loc') {
    const validAdminLocs = assignedLocationations.map(l => l.loc_cd);
    if (!validAdminLocs.includes(value)) {
      return res.status(400).json({ error: 'Invalid administrative location' });
    }
  } else if (field === 'cust_loc') {
    const validCustLocs = currentLocationations.map(l => l.loc_cd);
    if (!validCustLocs.includes(value)) {
      return res.status(400).json({ error: 'Invalid custodial location' });
    }
  }

  // Track results
  let updated_count = 0;
  const failed_updates: Array<{ asset_id: number; reason: string }> = [];

  // Get user's program IDs for access check
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Update each asset
  asset_ids.forEach((assetId: number) => {
    const assetIndex = mockAssets.findIndex(a => a.asset_id === assetId);

    if (assetIndex === -1) {
      failed_updates.push({ asset_id: assetId, reason: 'Asset not found' });
      return;
    }

    const asset = mockAssets[assetIndex];

    // Check if user has access to this asset's program
    if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
      failed_updates.push({ asset_id: assetId, reason: 'Access denied to this asset' });
      return;
    }

    // Check if this is an active asset (don't update deleted assets)
    if (!asset.active) {
      failed_updates.push({ asset_id: assetId, reason: 'Asset is inactive/deleted' });
      return;
    }

    // Get old value for logging
    let oldValue = asset[field as keyof typeof asset];
    let fieldLabel = '';
    let oldValueDisplay = '';
    let newValueDisplay = '';

    // Apply the update
    if (field === 'status_cd') {
      const oldStatus = assetStatusCodes.find(s => s.status_cd === asset.status_cd);
      const newStatus = assetStatusCodes.find(s => s.status_cd === value);
      fieldLabel = 'Status';
      oldValueDisplay = oldStatus?.status_name || asset.status_cd;
      newValueDisplay = newStatus?.status_name || value;
      asset.status_cd = value;

      // Update detailed assets if present
      const detailedAsset = detailedAssets.find(a => a.asset_id === assetId);
      if (detailedAsset) {
        detailedAsset.status_cd = value;
        detailedAsset.status_name = newStatus?.status_name || value;
      }
    } else if (field === 'admin_loc') {
      const oldLoc = assignedLocationations.find(l => l.loc_cd === asset.admin_loc);
      const newLoc = assignedLocationations.find(l => l.loc_cd === value);
      fieldLabel = 'Admin Location';
      oldValueDisplay = oldLoc?.loc_name || asset.admin_loc;
      newValueDisplay = newLoc?.loc_name || value;
      asset.admin_loc = value;

      // Update detailed assets if present
      const detailedAsset = detailedAssets.find(a => a.asset_id === assetId);
      if (detailedAsset) {
        detailedAsset.admin_loc = value;
        detailedAsset.admin_loc_name = newLoc?.loc_name || value;
      }
    } else if (field === 'cust_loc') {
      const oldLoc = currentLocationations.find(l => l.loc_cd === asset.cust_loc);
      const newLoc = currentLocationations.find(l => l.loc_cd === value);
      fieldLabel = 'Custodial Location';
      oldValueDisplay = oldLoc?.loc_name || asset.cust_loc;
      newValueDisplay = newLoc?.loc_name || value;
      asset.cust_loc = value;

      // Update detailed assets if present
      const detailedAsset = detailedAssets.find(a => a.asset_id === assetId);
      if (detailedAsset) {
        detailedAsset.cust_loc = value;
        detailedAsset.cust_loc_name = newLoc?.loc_name || value;
      }
    }

    // Add to asset history
    const historyChange: AssetHistoryChange = {
      field: field,
      field_label: fieldLabel,
      old_value: oldValueDisplay,
      new_value: newValueDisplay,
    };

    addAssetHistory(
      assetId,
      user,
      'update',
      [historyChange],
      `Mass update: ${fieldLabel}: ${oldValueDisplay} → ${newValueDisplay}`
    );

    // Add to activity log
    const now = new Date();
    const newActivity: ActivityLogEntry = {
      activity_id: 1000 + dynamicActivityLog.length + 1,
      timestamp: now.toISOString(),
      user_id: user.user_id,
      username: user.username,
      user_full_name: `${user.first_name} ${user.last_name}`,
      action_type: 'update',
      entity_type: 'asset',
      entity_id: assetId,
      entity_name: asset.serno,
      description: `Mass update: ${fieldLabel} changed from ${oldValueDisplay} to ${newValueDisplay}`,
      pgm_id: asset.pgm_id,
    };
    dynamicActivityLog.push(newActivity);

    updated_count++;
  });

  console.log(`[ASSETS] Mass update by ${user.username}: Updated ${updated_count} asset(s), ${failed_updates.length} failed`);

  res.json({
    message: `Successfully updated ${updated_count} asset(s)`,
    updated_count,
    failed_count: failed_updates.length,
    failed_updates: failed_updates.length > 0 ? failed_updates : undefined,
  });
});

// POST /api/assets/bulk-delete - Delete multiple assets (requires authentication and depot_manager/admin role)
app.post('/api/assets/bulk-delete', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN and DEPOT_MANAGER can delete assets
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to delete assets' });
  }

  const { asset_ids } = req.body;

  // Validate inputs
  if (!asset_ids || !Array.isArray(asset_ids) || asset_ids.length === 0) {
    return res.status(400).json({ error: 'asset_ids must be a non-empty array' });
  }

  // Track results
  let deleted_count = 0;
  const failed_deletes: Array<{ asset_id: number; reason: string }> = [];

  // Get user's program IDs for access check
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Delete each asset
  asset_ids.forEach((assetId: number) => {
    const assetIndex = mockAssets.findIndex(a => a.asset_id === assetId);

    if (assetIndex === -1) {
      failed_deletes.push({ asset_id: assetId, reason: 'Asset not found' });
      return;
    }

    const asset = mockAssets[assetIndex];

    // Check if user has access to this asset's program
    if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
      failed_deletes.push({ asset_id: assetId, reason: 'Access denied to this asset' });
      return;
    }

    // Check if this is an active asset (don't delete already deleted assets)
    if (!asset.active) {
      failed_deletes.push({ asset_id: assetId, reason: 'Asset is already inactive/deleted' });
      return;
    }

    // Soft delete the asset
    asset.active = false;

    // Update detailed assets if present
    const detailedAsset = detailedAssets.find(a => a.asset_id === assetId);
    if (detailedAsset) {
      detailedAsset.active = false;
    }

    // Add to asset history
    const historyChange: AssetHistoryChange = {
      field: 'active',
      field_label: 'Active Status',
      old_value: 'true',
      new_value: 'false',
    };

    addAssetHistory(
      assetId,
      user,
      'delete',
      [historyChange],
      `Asset deleted via bulk delete`
    );

    // Add to activity log
    const now = new Date();
    const newActivity: ActivityLogEntry = {
      activity_id: 1000 + dynamicActivityLog.length + 1,
      timestamp: now.toISOString(),
      user_id: user.user_id,
      username: user.username,
      user_full_name: `${user.first_name} ${user.last_name}`,
      action_type: 'delete',
      entity_type: 'asset',
      entity_id: assetId,
      entity_name: asset.serno,
      description: `Bulk deleted asset ${asset.serno}`,
      pgm_id: asset.pgm_id,
    };
    dynamicActivityLog.push(newActivity);

    deleted_count++;
  });

  console.log(`[ASSETS] Bulk delete by ${user.username}: Deleted ${deleted_count} asset(s), ${failed_deletes.length} failed`);

  res.json({
    message: `Successfully deleted ${deleted_count} asset(s)`,
    deleted_count,
    failed_count: failed_deletes.length,
    failed_deletes: failed_deletes.length > 0 ? failed_deletes : undefined,
  });
});

// POST /api/assets - Create a new asset (requires authentication and depot_manager/admin role)
app.post('/api/assets', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN and DEPOT_MANAGER can create assets
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to create assets' });
  }

  const { partno, serno, name, status_cd, admin_loc, cust_loc, notes, pgm_id } = req.body;

  // Validate required fields
  if (!partno || !serno || !status_cd || !admin_loc || !cust_loc || !pgm_id) {
    return res.status(400).json({ error: 'Part number, serial number, status, administrative location, custodial location, and program are required' });
  }

  // Check if user has access to this program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this program' });
  }

  // Validate status code
  const validStatuses = assetStatusCodes.map(s => s.status_cd);
  if (!validStatuses.includes(status_cd)) {
    return res.status(400).json({ error: 'Invalid status code' });
  }

  // Validate admin location
  const validAdminLocs = assignedLocationations.map(l => l.loc_cd);
  if (!validAdminLocs.includes(admin_loc)) {
    return res.status(400).json({ error: 'Invalid administrative location' });
  }

  // Validate custodial location
  const validCustLocs = currentLocationations.map(l => l.loc_cd);
  if (!validCustLocs.includes(cust_loc)) {
    return res.status(400).json({ error: 'Invalid custodial location' });
  }

  // FEATURE #409: Validate locations against program-location mapping
  try {
    // Get valid locations for this program
    const programLocations = await prisma.programLocation.findMany({
      where: {
        pgm_id: pgm_id,
        active: true,
      },
      select: {
        loc_id: true,
      },
    });

    const validLocationIds = new Set(programLocations.map(pl => pl.loc_id));

    // Get location IDs for admin_loc and cust_loc
    const assignedLocationInfo = assignedLocationations.find(l => l.loc_cd === admin_loc);
    const custLocInfo = currentLocationations.find(l => l.loc_cd === cust_loc);

    if (!assignedLocationInfo || !custLocInfo) {
      return res.status(400).json({ error: 'Invalid location code provided' });
    }

    // Validate admin location is valid for this program
    if (!validLocationIds.has(assignedLocationInfo.loc_id)) {
      return res.status(400).json({
        error: `Administrative location '${assignedLocationInfo.loc_name}' is not valid for the selected program. Please select a location that is assigned to this program.`
      });
    }

    // Validate custodial location is valid for this program
    if (!validLocationIds.has(custLocInfo.loc_id)) {
      return res.status(400).json({
        error: `Custodial location '${custLocInfo.loc_name}' is not valid for the selected program. Please select a location that is assigned to this program.`
      });
    }

    console.log(`[ASSET-CREATE] Validated locations for program ${pgm_id}: admin=${admin_loc}, custodial=${cust_loc}`);
  } catch (error) {
    console.error('[ASSET-CREATE] Error validating program-location mapping:', error);
    return res.status(500).json({ error: 'Failed to validate location assignments' });
  }

  // Check for duplicate serial number + part number combination (within same program)
  const existingAsset = mockAssets.find(a =>
    a.serno.toLowerCase() === serno.toLowerCase() &&
    a.partno.toLowerCase() === partno.toLowerCase() &&
    a.pgm_id === pgm_id
  );
  if (existingAsset) {
    return res.status(400).json({ error: `An asset with serial number '${serno}' and part number '${partno}' already exists in this program` });
  }

  // Create asset in DB first to get real ID
  let newAssetId: number;
  try {
    // Find partno_id for the given partno + pgm_id
    const partRecord = await prisma.partList.findFirst({ where: { partno, pgm_id } });
    if (!partRecord) {
      return res.status(400).json({ error: `Part number '${partno}' not found for this program` });
    }
    // Resolve location IDs
    const adminLocRecord = await prisma.location.findFirst({ where: { display_name: { contains: admin_loc } } });
    const custLocRecord = await prisma.location.findFirst({ where: { display_name: { contains: cust_loc } } });
    
    const dbAsset = await prisma.asset.create({
      data: {
        partno_id: partRecord.partno_id,
        serno,
        status_cd,
        loc_ida: adminLocRecord?.loc_id || null,
        loc_idc: custLocRecord?.loc_id || null,
        active: true,
        remarks: notes || null,
        ins_by: user.username,
      },
    });
    newAssetId = dbAsset.asset_id;
    console.log(`[ASSET-CREATE] Created in DB with ID ${newAssetId}`);
  } catch (dbError) {
    console.error('[ASSET-CREATE] DB create failed:', dbError);
    // Fallback to in-memory ID
    newAssetId = Math.max(...mockAssets.map(a => a.asset_id), 0) + 1;
  }

  // Create the new asset
  const newAsset: Asset = {
    asset_id: newAssetId,
    serno,
    partno,
    name: name || `${partno} - ${serno}`,
    pgm_id,
    status_cd,
    admin_loc,
    cust_loc,
    notes: notes || '',
    active: true,
    created_date: new Date().toISOString().split('T')[0],
  };

  // Add to mock data array
  mockAssets.push(newAsset);

  // Get program and location info for response
  const program = allPrograms.find(p => p.pgm_id === pgm_id);
  const assignedLocationInfo = assignedLocationations.find(l => l.loc_cd === admin_loc);
  const custLocInfo = currentLocationations.find(l => l.loc_cd === cust_loc);
  const statusInfo = assetStatusCodes.find(s => s.status_cd === status_cd);

  // Also add to detailedAssets for GET endpoint to show the new asset
  const createdTimestamp = new Date().toISOString();
  const newDetailedAsset: AssetDetails = {
    asset_id: newAssetId,
    serno,
    partno,
    part_name: name || `${partno} - ${serno}`,
    pgm_id,
    status_cd,
    status_name: statusInfo?.status_name || status_cd,
    active: true,
    location: assignedLocationInfo?.loc_name || admin_loc,
    loc_type: assignedLocationInfo?.loc_type as 'depot' | 'field' || 'depot',
    in_transit: false,
    bad_actor: false,
    last_maint_date: null,
    next_pmi_date: null,
    eti_hours: 0,
    remarks: notes || null,
    uii: null,
    mfg_date: null,
    acceptance_date: null,
    admin_loc: admin_loc,
    admin_loc_name: assignedLocationInfo?.loc_name || admin_loc,
    cust_loc: cust_loc,
    cust_loc_name: custLocInfo?.loc_name || cust_loc,
    nha_asset_id: null,
    carrier: null,
    tracking_number: null,
    ship_date: null,
    meter_type: null,
    cycles_count: null,
    created_date: createdTimestamp,
    modified_date: null,
  };
  detailedAssets.push(newDetailedAsset);
  // Refresh from DB to ensure cache matches
  await refreshAssetInMemory(newAssetId).catch(() => {});

  // Add creation to asset history
  const createChanges: AssetHistoryChange[] = [
    { field: 'serno', field_label: 'Serial Number', old_value: null, new_value: serno },
    { field: 'partno', field_label: 'Part Number', old_value: null, new_value: partno },
    { field: 'name', field_label: 'Name', old_value: null, new_value: name || `${partno} - ${serno}` },
    { field: 'status_cd', field_label: 'Status', old_value: null, new_value: statusInfo?.status_name || status_cd },
    { field: 'admin_loc', field_label: 'Admin Location', old_value: null, new_value: assignedLocationInfo?.loc_name || admin_loc },
    { field: 'cust_loc', field_label: 'Custodial Location', old_value: null, new_value: custLocInfo?.loc_name || cust_loc },
  ];
  if (notes) {
    createChanges.push({ field: 'notes', field_label: 'Notes', old_value: null, new_value: notes });
  }

  addAssetHistory(
    newAssetId,
    user,
    'create',
    createChanges,
    `Asset ${serno} created`
  );

  // Log to audit trail
  logAuditAction(
    user.user_id,
    'CREATE',
    'asset',
    newAssetId,
    null,
    {
      serno,
      partno,
      name: name || `${partno} - ${serno}`,
      status_cd,
      admin_loc,
      cust_loc,
      notes: notes || '',
      pgm_id,
    },
    req
  );

  console.log(`[ASSETS] New asset created by ${user.username}: ${serno} (ID: ${newAssetId}, Program: ${program?.pgm_cd})`);

  res.status(201).json({
    message: 'Asset created successfully',
    asset: {
      ...newAsset,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
      admin_loc_name: assignedLocationInfo?.loc_name || admin_loc,
      cust_loc_name: custLocInfo?.loc_name || cust_loc,
      status_name: statusInfo?.status_name || status_cd,
    }
  });
});

// DELETE /api/assets/:id - Delete an asset (requires authentication and admin role)
app.delete('/api/assets/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN can delete assets
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can delete assets' });
  }

  const assetId = parseInt(req.params.id, 10);
  const assetIndex = detailedAssets.findIndex(a => a.asset_id === assetId);

  if (assetIndex === -1) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  const asset = detailedAssets[assetIndex];

  // Check if asset is already deleted (idempotency check)
  if (asset.active === false) {
    return res.status(404).json({ error: 'Asset not found or already deleted' });
  }

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Store asset info before deletion for logging
  const deletedAssetInfo = {
    asset_id: asset.asset_id,
    serno: asset.serno,
    partno: asset.partno,
    name: asset.part_name,
    pgm_id: asset.pgm_id,
  };

  // Soft delete: set active = false (allows recovery)
  detailedAssets[assetIndex].active = false;
  await prisma.asset.update({ where: { asset_id: assetId }, data: { active: false, chg_date: new Date() } }).catch(e => console.error('[ASSET] DB deactivate failed:', e));

  // Log the deletion
  console.log(`[ASSETS] Asset soft deleted by ${user.username}: ${deletedAssetInfo.serno} (ID: ${assetId})`);

  // Add to activity log (audit trail)
  const now = new Date();
  const newActivity: ActivityLogEntry = {
    activity_id: 1000 + dynamicActivityLog.length + 1,
    timestamp: now.toISOString(),
    user_id: user.user_id,
    username: user.username,
    user_full_name: `${user.first_name} ${user.last_name}`,
    action_type: 'delete',
    entity_type: 'asset',
    entity_id: assetId,
    entity_name: deletedAssetInfo.serno,
    description: `Soft deleted asset ${deletedAssetInfo.serno} (${deletedAssetInfo.name})`,
    pgm_id: deletedAssetInfo.pgm_id,
  };
  dynamicActivityLog.push(newActivity);

  res.json({
    message: `Asset "${deletedAssetInfo.serno}" deleted successfully (soft delete - can be recovered)`,
    deleted_asset: deletedAssetInfo,
    audit: newActivity,
  });
});

// POST /api/assets/:id/reactivate - Reactivate a soft-deleted asset (requires authentication and admin role)
app.post('/api/assets/:id/reactivate', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN can reactivate assets
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can reactivate assets' });
  }

  const assetId = parseInt(req.params.id, 10);
  const assetIndex = detailedAssets.findIndex(a => a.asset_id === assetId);

  if (assetIndex === -1) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  const asset = detailedAssets[assetIndex];

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Check if asset is already active
  if (asset.active) {
    return res.status(400).json({ error: 'Asset is already active' });
  }

  // Reactivate: set active = true
  detailedAssets[assetIndex].active = true;
    await prisma.asset.update({ where: { asset_id: assetId }, data: { active: true, chg_date: new Date() } }).catch(e => console.error('[ASSET] DB reactivate failed:', e));

  // Log the reactivation
  console.log(`[ASSETS] Asset reactivated by ${user.username}: ${asset.serno} (ID: ${assetId})`);

  // Add to activity log (audit trail)
  const now = new Date();
  const newActivity: ActivityLogEntry = {
    activity_id: 1000 + dynamicActivityLog.length + 1,
    timestamp: now.toISOString(),
    user_id: user.user_id,
    username: user.username,
    user_full_name: `${user.first_name} ${user.last_name}`,
    action_type: 'update',
    entity_type: 'asset',
    entity_id: assetId,
    entity_name: asset.serno,
    description: `Reactivated asset ${asset.serno} (${asset.part_name})`,
    pgm_id: asset.pgm_id,
  };
  dynamicActivityLog.push(newActivity);

  res.json({
    message: `Asset "${asset.serno}" reactivated successfully`,
    asset: {
      asset_id: asset.asset_id,
      serno: asset.serno,
      partno: asset.partno,
      part_name: asset.part_name,
      active: asset.active,
    },
    audit: newActivity,
  });
});

// DELETE /api/assets/:id/permanent - Permanently delete an asset (hard delete, requires authentication and admin role)
app.delete('/api/assets/:id/permanent', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - only ADMIN can permanently delete assets
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can permanently delete assets' });
  }

  const assetId = parseInt(req.params.id, 10);
  const assetIndex = detailedAssets.findIndex(a => a.asset_id === assetId);

  if (assetIndex === -1) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  const asset = detailedAssets[assetIndex];

  // Check if user has access to this asset's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(asset.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  // Store asset info before deletion for logging
  const deletedAssetInfo = {
    asset_id: asset.asset_id,
    serno: asset.serno,
    partno: asset.partno,
    name: asset.part_name,
    pgm_id: asset.pgm_id,
  };

  // Hard delete: completely remove from array
  detailedAssets.splice(assetIndex, 1);
    await prisma.asset.delete({ where: { asset_id: assetId } }).catch(e => console.error('[ASSET] DB delete failed:', e));

  // Log the permanent deletion
  console.log(`[ASSETS] Asset PERMANENTLY deleted by ${user.username}: ${deletedAssetInfo.serno} (ID: ${assetId})`);

  // Add to activity log (audit trail)
  const now = new Date();
  const newActivity: ActivityLogEntry = {
    activity_id: 1000 + dynamicActivityLog.length + 1,
    timestamp: now.toISOString(),
    user_id: user.user_id,
    username: user.username,
    user_full_name: `${user.first_name} ${user.last_name}`,
    action_type: 'delete',
    entity_type: 'asset',
    entity_id: assetId,
    entity_name: deletedAssetInfo.serno,
    description: `PERMANENTLY deleted asset ${deletedAssetInfo.serno} (${deletedAssetInfo.name}) - CANNOT BE RECOVERED`,
    pgm_id: deletedAssetInfo.pgm_id,
  };
  dynamicActivityLog.push(newActivity);

  res.json({
    message: `Asset "${deletedAssetInfo.serno}" permanently deleted - CANNOT BE RECOVERED`,
    deleted_asset: deletedAssetInfo,
    audit: newActivity,
  });
});

// GET /api/reference/locations - Get available locations for asset forms
app.get('/api/reference/locations', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  try {
    const programId = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;
    const majcomFilter = req.query.majcom ? (req.query.majcom as string) : null;

    let locations;

    // If program_id is provided, filter locations by program-location mapping
    if (programId) {
      const programLocations = await prisma.programLocation.findMany({
        where: {
          pgm_id: programId,
          active: true,
        },
        include: {
          location: {
            where: majcomFilter ? { majcom_cd: majcomFilter } : undefined,
            select: {
              loc_id: true,
              majcom_cd: true,
              site_cd: true,
              unit_cd: true,
              squad_cd: true,
              description: true,
              geoloc: true,
              display_name: true,
              active: true,
            }
          },
        },
      });

      locations = programLocations
        .map(pl => pl.location)
        .filter(loc => loc.active);

      console.log(`[REFERENCE-LOCATIONS] Filtered locations for program ${programId}${majcomFilter ? ` and MAJCOM ${majcomFilter}` : ''}: ${locations.length} valid locations`);
    } else {
      // If no program_id, return all active locations
      const whereClause: any = { active: true };
      if (majcomFilter) {
        whereClause.majcom_cd = majcomFilter;
      }

      locations = await prisma.location.findMany({
        where: whereClause,
        select: {
          loc_id: true,
          majcom_cd: true,
          site_cd: true,
          unit_cd: true,
          squad_cd: true,
          description: true,
          geoloc: true,
          display_name: true,
          active: true,
        },
      });

      console.log(`[REFERENCE-LOCATIONS] Returning active locations${majcomFilter ? ` for MAJCOM ${majcomFilter}` : ''}: ${locations.length}`);
    }

    // Get distinct MAJCOMs for filter dropdown
    const distinctMajcoms = Array.from(
      new Set(
        locations
          .map(loc => loc.majcom_cd)
          .filter((majcom): majcom is string => majcom !== null && majcom !== undefined)
      )
    ).sort();

    // For backwards compatibility, return both admin and custodial as the same list
    // In the new system, all locations can be used for both purposes
    res.json({
      admin_locations: locations,
      custodial_locations: locations,
      majcoms: distinctMajcoms, // Add list of available MAJCOMs for filtering
    });
  } catch (error) {
    console.error('[REFERENCE-LOCATIONS] Error fetching locations:', error);
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

// POST /api/reference/locations - Create a new location
app.post('/api/reference/locations', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Only admins can create locations
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can create locations' });
  }

  const { type, loc_cd, loc_name } = req.body;

  if (!type || !loc_cd || !loc_name) {
    return res.status(400).json({ error: 'Missing required fields: type, loc_cd, loc_name' });
  }

  if (type !== 'admin' && type !== 'custodial') {
    return res.status(400).json({ error: 'Type must be "admin" or "custodial"' });
  }

  const targetArray = type === 'admin' ? assignedLocationations : currentLocationations;

  // Check if location code already exists
  if (targetArray.find(l => l.loc_cd === loc_cd)) {
    return res.status(400).json({ error: 'Location code already exists' });
  }

  const newLocation = {
    loc_id: Math.max(...targetArray.map(l => l.loc_id), 0) + 1,
    loc_cd,
    loc_name,
    active: true,
  };

  targetArray.push(newLocation);

  res.status(201).json(newLocation);
});

// DELETE /api/reference/locations/:type/:loc_cd - Delete (mark inactive) a location
app.delete('/api/reference/locations/:type/:loc_cd', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Only admins can delete locations
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can delete locations' });
  }

  const { type, loc_cd } = req.params;

  if (type !== 'admin' && type !== 'custodial') {
    return res.status(400).json({ error: 'Type must be "admin" or "custodial"' });
  }

  const targetArray = type === 'admin' ? assignedLocationations : currentLocationations;
  const location = targetArray.find(l => l.loc_cd === loc_cd);

  if (!location) {
    return res.status(404).json({ error: 'Location not found' });
  }

  // Mark as inactive instead of actually deleting
  location.active = false;

  console.log(`[LOCATION] Deleted ${type} location ${loc_cd} (${location.loc_name}) by ${user.username}`);

  res.json({ message: 'Location deleted successfully', location });
});

// GET /api/reference/asset-statuses - Get available asset status codes
app.get('/api/reference/asset-statuses', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  res.json({
    statuses: assetStatusCodes,
    transitionRules: statusTransitionRules,
  });
});

// GET /api/reference/software-versions - Get available software versions for a program
app.get('/api/reference/software-versions', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get program ID from query parameter
  const programId = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Filter software by user's programs
  let filteredSoftware = softwareCatalog.filter(sw => {
    // Check program access
    if (user.role === 'ADMIN') {
      // Admin can see all, but filter by programId if specified
      if (programId !== null) {
        return sw.pgm_id === programId && sw.active;
      }
      return sw.active;
    } else {
      // Non-admin users only see software for their assigned programs
      if (programId !== null) {
        return sw.pgm_id === programId && userProgramIds.includes(sw.pgm_id) && sw.active;
      }
      return userProgramIds.includes(sw.pgm_id) && sw.active;
    }
  });

  // Sort by revision date (newest first)
  filteredSoftware.sort((a, b) => new Date(b.revision_date).getTime() - new Date(a.revision_date).getTime());

  // Map to simplified format for dropdowns
  const versions = filteredSoftware.map(sw => ({
    sw_version_id: sw.sw_id,
    sw_version: sw.revision,
    sw_name: sw.sw_title,
    sw_number: sw.sw_number,
    sw_type: sw.sw_type,
    description: sw.sw_desc,
    active: sw.active,
    pgm_id: sw.pgm_id,
  }));

  res.json({
    versions,
    total: versions.length,
  });
});

// Get all parts orders (list)
app.get('/api/parts-orders', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get user's location IDs
  const userLocationIds = user.locations?.map(l => l.loc_id) || [];

  // Get all orders (use persistent array)
  const allOrders = partsOrders;

  // Filter by user's accessible programs
  let filteredOrders = allOrders.filter(order => userProgramIds.includes(order.pgm_id));

  // SECURITY: Filter by location - parts orders must involve locations the user has access to
  // Show orders where EITHER the requesting location OR the fulfilling location matches user's locations
  // This ensures:
  // - Field techs see orders they requested from their location
  // - Depot managers see orders they need to fulfill from their depot location
  // - Admin users with multiple locations see all relevant orders
  if (userLocationIds.length > 0) {
    filteredOrders = filteredOrders.filter(order => {
      const matchesRequestingLocation = order.requesting_loc_id !== null && userLocationIds.includes(order.requesting_loc_id);
      const matchesFulfillingLocation = order.fulfilling_loc_id !== null && userLocationIds.includes(order.fulfilling_loc_id);
      return matchesRequestingLocation || matchesFulfillingLocation;
    });
  }

  // Apply filters from query parameters
  const statusFilter = req.query.status as string | undefined;
  const priorityFilter = req.query.priority as string | undefined;
  const searchQuery = req.query.search as string | undefined;
  const pqdrFilter = req.query.pqdr as string | undefined;
  const startDate = req.query.start_date as string | undefined;
  const endDate = req.query.end_date as string | undefined;

  if (statusFilter) {
    filteredOrders = filteredOrders.filter(order => order.status === statusFilter);
  }

  if (priorityFilter) {
    filteredOrders = filteredOrders.filter(order => order.priority === priorityFilter);
  }

  if (pqdrFilter === 'true') {
    filteredOrders = filteredOrders.filter(order => order.pqdr === true);
  }

  if (searchQuery) {
    const query = searchQuery.toLowerCase().trim();
    if (query) {
      filteredOrders = filteredOrders.filter(order =>
        order.order_id.toString().includes(query) ||
        order.part_no.toLowerCase().includes(query) ||
        order.part_name.toLowerCase().includes(query) ||
        order.nsn.toLowerCase().includes(query) ||
        (order.asset_sn && order.asset_sn.toLowerCase().includes(query)) ||
        (order.job_no && order.job_no.toLowerCase().includes(query))
      );
    }
  }

  // Apply date range filter
  if (startDate) {
    const startDateTime = new Date(startDate).getTime();
    filteredOrders = filteredOrders.filter(order => {
      const orderDate = new Date(order.order_date).getTime();
      return orderDate >= startDateTime;
    });
  }

  if (endDate) {
    const endDateTime = new Date(endDate).getTime() + 86400000; // Add 24 hours to include the entire end date
    filteredOrders = filteredOrders.filter(order => {
      const orderDate = new Date(order.order_date).getTime();
      return orderDate < endDateTime;
    });
  }

  // Add program info for display
  const ordersWithProgram = filteredOrders.map(order => {
    const program = allPrograms.find(p => p.pgm_id === order.pgm_id);
    return {
      ...order,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    };
  });

  // Sort by order date (newest first)
  ordersWithProgram.sort((a, b) => new Date(b.order_date).getTime() - new Date(a.order_date).getTime());

  // Pagination
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const offset = (page - 1) * limit;
  const paginatedOrders = ordersWithProgram.slice(offset, offset + limit);

  console.log(`[PARTS ORDERS] List request by ${user.username} - Total: ${ordersWithProgram.length}, Page: ${page}`);

  res.json({
    orders: paginatedOrders,
    total: ordersWithProgram.length,
    page,
    limit,
    totalPages: Math.ceil(ordersWithProgram.length / limit),
  });
});

// Get single parts order by ID
app.get('/api/parts-orders/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const orderId = parseInt(req.params.id, 10);
  const order = partsOrders.find(o => o.order_id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Parts order not found' });
  }

  // Check if user has access to this order's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(order.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this parts order' });
  }

  // Add program info for display
  const program = allPrograms.find(p => p.pgm_id === order.pgm_id);

  res.json({
    order: {
      ...order,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    }
  });
});

// Acknowledge parts order (DEPOT maintenance level only)
// In legacy RIMSS, only DEPOT (D-level) users could acknowledge orders
app.patch('/api/parts-orders/:id/acknowledge', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check maintenance level - only DEPOT level users can acknowledge
  // ADMIN role bypasses this check
  const allowedLevels = user.allowedMaintenanceLevels || [];
  const canAcknowledge = user.role === 'ADMIN' || allowedLevels.includes('DEPOT');

  if (!canAcknowledge) {
    return res.status(403).json({ error: 'Only DEPOT maintenance level users can acknowledge parts orders. SHOP users can request parts but cannot fulfill them.' });
  }

  const orderId = parseInt(req.params.id, 10);
  const order = partsOrders.find(o => o.order_id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Parts order not found' });
  }

  // Check if user has access to this order's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(order.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this parts order' });
  }

  // Check if order is in pending status
  if (order.status !== 'pending') {
    return res.status(400).json({ error: `Cannot acknowledge order with status: ${order.status}` });
  }

  // Update order status to acknowledged
  order.status = 'acknowledged';
  order.acknowledged_date = new Date().toISOString();
  order.acknowledged_by = user.user_id;
  order.acknowledged_by_name = `${user.first_name} ${user.last_name}`;

  // Log history entry
  addPartsOrderHistory(
    order.order_id,
    user,
    'acknowledge',
    'acknowledged',
    `Order acknowledged by depot`,
    {
      acknowledged_date: order.acknowledged_date,
    }
  );

  console.log(`[PARTS] Order #${orderId} acknowledged by ${user.first_name} ${user.last_name} (${user.role}, levels: ${user.allowedMaintenanceLevels?.join(',') || 'none'})`);

  // Return updated order with program info
  const program = allPrograms.find(p => p.pgm_id === order.pgm_id);

  res.json({
    success: true,
    order: {
      ...order,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    }
  });
});

// Fill parts order with replacement spare (DEPOT maintenance level only)
// In legacy RIMSS, only DEPOT (D-level) users could fill orders with replacement parts
app.patch('/api/parts-orders/:id/fill', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check maintenance level - only DEPOT level users can fill orders
  // ADMIN role bypasses this check
  const allowedLevels = user.allowedMaintenanceLevels || [];
  const canFill = user.role === 'ADMIN' || allowedLevels.includes('DEPOT');

  if (!canFill) {
    return res.status(403).json({ error: 'Only DEPOT maintenance level users can fill parts orders. SHOP users can request parts but cannot fulfill them.' });
  }

  const orderId = parseInt(req.params.id, 10);
  const order = partsOrders.find(o => o.order_id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Parts order not found' });
  }

  // Check if user has access to this order's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(order.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this parts order' });
  }

  // Check if order is in acknowledged status
  if (order.status !== 'acknowledged') {
    return res.status(400).json({ error: `Cannot fill order with status: ${order.status}. Order must be acknowledged first.` });
  }

  // Validate request body
  const {
    replacement_asset_id,
    replacement_serno,
    shipper,
    tracking_number,
    ship_date
  } = req.body;

  if (!replacement_asset_id || !replacement_serno) {
    return res.status(400).json({ error: 'Replacement part information is required' });
  }

  if (!shipper || !tracking_number || !ship_date) {
    return res.status(400).json({ error: 'Shipping information (shipper, tracking number, ship date) is required' });
  }

  // Update order status to shipped (filled)
  order.status = 'shipped';
  order.filled_date = new Date().toISOString();
  order.filled_by = user.user_id;
  order.filled_by_name = `${user.first_name} ${user.last_name}`;
  order.replacement_asset_id = replacement_asset_id;
  order.replacement_serno = replacement_serno;
  order.shipper = shipper;
  order.shipping_tracking = tracking_number;
  order.ship_date = ship_date;

  // Log history entry
  addPartsOrderHistory(
    order.order_id,
    user,
    'fill',
    'shipped',
    `Order filled with replacement part ${replacement_serno}`,
    {
      filled_date: order.filled_date,
      replacement_serno,
      shipper,
      tracking_number,
      ship_date,
    }
  );

  console.log(`[PARTS] Order #${orderId} filled by ${user.first_name} ${user.last_name} (${user.role}) - Replacement: ${replacement_serno}`);

  // Return updated order with program info
  const program = allPrograms.find(p => p.pgm_id === order.pgm_id);

  res.json({
    success: true,
    order: {
      ...order,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    }
  });
});

// Deliver/Receive parts order (field technician acknowledges receipt)
app.patch('/api/parts-orders/:id/deliver', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - field technicians, depot managers, and admins can receive parts
  if (user.role !== 'FIELD_TECHNICIAN' && user.role !== 'DEPOT_MANAGER' && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only field technicians can receive parts orders' });
  }

  const orderId = parseInt(req.params.id, 10);
  const order = partsOrders.find(o => o.order_id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Parts order not found' });
  }

  // Check if user has access to this order's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(order.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this parts order' });
  }

  // Check if order is in shipped status
  if (order.status !== 'shipped') {
    return res.status(400).json({ error: `Cannot receive order with status: ${order.status}. Order must be shipped first.` });
  }

  // Update order status to received (delivered)
  order.status = 'received';
  order.received_date = new Date().toISOString();
  order.received_by = user.user_id;
  order.received_by_name = `${user.first_name} ${user.last_name}`;
  order.qty_received = order.qty_ordered; // Mark full quantity as received

  // Log history entry
  addPartsOrderHistory(
    order.order_id,
    user,
    'deliver',
    'received',
    `Parts received and order completed`,
    {
      received_date: order.received_date,
      qty_received: order.qty_received,
    }
  );

  console.log(`[PARTS] Order #${orderId} received by ${user.first_name} ${user.last_name} (${user.role})`);

  // Return updated order with program info
  const program = allPrograms.find(p => p.pgm_id === order.pgm_id);

  res.json({
    success: true,
    order: {
      ...order,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    }
  });
});

// Toggle PQDR flag on parts order
app.patch('/api/parts-orders/:id/pqdr', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - field technicians, depot managers, and admins can toggle PQDR
  if (user.role !== 'FIELD_TECHNICIAN' && user.role !== 'DEPOT_MANAGER' && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const orderId = parseInt(req.params.id, 10);
  const order = partsOrders.find(o => o.order_id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Parts order not found' });
  }

  // Check if user has access to this order's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(order.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this parts order' });
  }

  // Toggle PQDR flag
  const { pqdr } = req.body;
  order.pqdr = pqdr !== undefined ? pqdr : !order.pqdr;

  console.log(`[PARTS] Order #${orderId} PQDR flag ${order.pqdr ? 'set' : 'cleared'} by ${user.first_name} ${user.last_name} (${user.role})`);

  // Return updated order with program info
  const program = allPrograms.find(p => p.pgm_id === order.pgm_id);

  res.json({
    success: true,
    order: {
      ...order,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    }
  });
});

// Create new parts order (request replacement)
app.post('/api/parts-orders', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Validate request body
  const {
    part_no,
    part_name,
    nsn,
    qty_ordered,
    asset_sn,
    asset_name,
    job_no,
    priority,
    pgm_id,
    notes,
  } = req.body;

  // Validate required fields
  if (!part_no && !part_name) {
    return res.status(400).json({ error: 'Either part_no or part_name is required' });
  }

  if (!qty_ordered || qty_ordered < 1) {
    return res.status(400).json({ error: 'qty_ordered must be at least 1' });
  }

  if (!priority || !['routine', 'urgent', 'critical'].includes(priority)) {
    return res.status(400).json({ error: 'Valid priority is required (routine, urgent, critical)' });
  }

  if (!pgm_id) {
    return res.status(400).json({ error: 'pgm_id is required' });
  }

  // Check if user has access to this program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this program' });
  }

  // Get user's default location for the requesting location
  const userDefaultLocation = user.locations?.find(l => l.is_default) || user.locations?.[0];
  const requestingLocationId = userDefaultLocation?.loc_id || null;

  // Fulfilling location defaults to depot location (154) or can be specified
  const fulfillingLocationId = 154; // Default depot location

  // Create new parts order
  const newOrder: PartsOrder = {
    order_id: nextPartsOrderId++,
    part_no: part_no || '',
    part_name: part_name || '',
    nsn: nsn || '',
    qty_ordered: parseInt(qty_ordered, 10),
    qty_received: 0,
    unit_price: 0, // Will be set by depot when acknowledging
    order_date: new Date().toISOString().split('T')[0],
    request_date: new Date().toISOString(),
    status: 'pending',
    requestor_id: user.user_id,
    requestor_name: user.username,
    requesting_loc_id: requestingLocationId,
    fulfilling_loc_id: fulfillingLocationId,
    asset_sn: asset_sn || null,
    asset_name: asset_name || null,
    job_no: job_no || null,
    priority: priority,
    pgm_id: pgm_id,
    notes: notes || '',
    shipping_tracking: null,
    estimated_delivery: null,
    acknowledged_date: null,
    acknowledged_by: null,
    acknowledged_by_name: null,
    filled_date: null,
    filled_by: null,
    filled_by_name: null,
    replacement_asset_id: null,
    replacement_serno: null,
    shipper: null,
    ship_date: null,
    received_date: null,
    received_by: null,
    received_by_name: null,
    pqdr: false,
  };

  // Add to parts orders array
  partsOrders.push(newOrder);

  console.log(`[PARTS ORDERS] New order created by ${user.username} - Order #${newOrder.order_id} - Part: ${newOrder.part_name || newOrder.part_no}`);

  res.status(201).json({
    message: 'Parts order created successfully',
    order: newOrder,
  });
});

// Get history for a specific parts order
app.get('/api/parts-orders/:id/history', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const orderId = parseInt(req.params.id, 10);
  const order = partsOrders.find(o => o.order_id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Parts order not found' });
  }

  // Check if user has access to this order's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(order.pgm_id)) {
    return res.status(403).json({ error: 'Access denied to this parts order' });
  }

  // Get all history entries for this order, sorted by timestamp (oldest first)
  const orderHistory = partsOrderHistory
    .filter(h => h.order_id === orderId)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  res.json({
    history: orderHistory,
    total: orderHistory.length,
  });
});

// =====================================
// CONFIGURATIONS (cfg_set) ENDPOINTS
// =====================================

// Configuration set interface
interface ConfigurationSet {
  cfg_set_id: number;
  cfg_name: string;
  cfg_type: string;
  pgm_id: number;
  partno_id: number | null;
  partno: string | null;
  part_name: string | null;
  description: string | null;
  active: boolean;
  ins_by: string;
  ins_date: string;
  chg_by: string | null;
  chg_date: string | null;
  // Computed fields
  bom_item_count: number;
  asset_count: number;
}

// BOM (Bill of Materials) item interface
interface BOMItem {
  list_id: number;
  cfg_set_id: number;
  partno_p: string;  // Parent part number (configuration's base part)
  partno_c: string;  // Child part number (this item's part number)
  part_name_c: string;  // Child part name
  sort_order: number;
  qpa: number;  // Quantity per assembly
  active: boolean;
  nha_partno_c: string | null;  // NHA (Next Higher Assembly) - parent part within BOM hierarchy
  is_sra: boolean;  // Is this a Sub-Replaceable Assembly (has an NHA parent)?
}

// Initialize mock configuration data
function initializeConfigurations(): ConfigurationSet[] {
  const today = new Date();
  const subtractDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString();
  };

  return [
    // CRIIS program configurations (pgm_id: 1)
    {
      cfg_set_id: 1,
      cfg_name: 'Camera System X Configuration',
      cfg_type: 'ASSEMBLY',
      pgm_id: 1,
      partno_id: 4,
      partno: 'PN-CAMERA-X',
      part_name: 'Camera System X',
      description: 'Standard camera system configuration including sensor units and mounting hardware',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(365),
      chg_by: 'depot_mgr',
      chg_date: subtractDays(30),
      bom_item_count: 3,
      asset_count: 2,
    },
    {
      cfg_set_id: 2,
      cfg_name: 'Radar Unit Configuration',
      cfg_type: 'ASSEMBLY',
      pgm_id: 1,
      partno_id: 6,
      partno: 'PN-RADAR-01',
      part_name: 'Radar Unit 01',
      description: 'Complete radar unit configuration with power supply and antenna assembly',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(400),
      chg_by: null,
      chg_date: null,
      bom_item_count: 4,
      asset_count: 2,
    },
    {
      cfg_set_id: 3,
      cfg_name: 'Communication System Config',
      cfg_type: 'SYSTEM',
      pgm_id: 1,
      partno_id: 8,
      partno: 'PN-COMM-SYS',
      part_name: 'Communication System',
      description: 'Field communication system configuration with encryption modules',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(300),
      chg_by: 'depot_mgr',
      chg_date: subtractDays(15),
      bom_item_count: 5,
      asset_count: 2,
    },
    {
      cfg_set_id: 4,
      cfg_name: 'Navigation Unit Standard',
      cfg_type: 'COMPONENT',
      pgm_id: 1,
      partno_id: 10,
      partno: 'PN-NAV-UNIT',
      part_name: 'Navigation Unit',
      description: 'GPS-enabled navigation unit with inertial backup',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(250),
      chg_by: null,
      chg_date: null,
      bom_item_count: 2,
      asset_count: 1,
    },
    // ACTS program configurations (pgm_id: 2)
    {
      cfg_set_id: 5,
      cfg_name: 'Targeting System A Config',
      cfg_type: 'ASSEMBLY',
      pgm_id: 2,
      partno_id: 11,
      partno: 'PN-TARGET-A',
      part_name: 'Targeting System A',
      description: 'Primary targeting system with laser designator and optical sight',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(350),
      chg_by: 'depot_mgr',
      chg_date: subtractDays(45),
      bom_item_count: 4,
      asset_count: 2,
    },
    {
      cfg_set_id: 6,
      cfg_name: 'Targeting System B Config',
      cfg_type: 'ASSEMBLY',
      pgm_id: 2,
      partno_id: 13,
      partno: 'PN-TARGET-B',
      part_name: 'Targeting System B',
      description: 'Advanced targeting system with thermal imaging',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(280),
      chg_by: null,
      chg_date: null,
      bom_item_count: 3,
      asset_count: 1,
    },
    {
      cfg_set_id: 7,
      cfg_name: 'Laser Designator Config',
      cfg_type: 'COMPONENT',
      pgm_id: 2,
      partno_id: 14,
      partno: 'PN-LASER-SYS',
      part_name: 'Laser Designator',
      description: 'High-power laser designator module configuration',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(200),
      chg_by: null,
      chg_date: null,
      bom_item_count: 2,
      asset_count: 2,
    },
    // ARDS program configurations (pgm_id: 3)
    {
      cfg_set_id: 8,
      cfg_name: 'Data Processor Configuration',
      cfg_type: 'SYSTEM',
      pgm_id: 3,
      partno_id: 17,
      partno: 'PN-DATA-SYS',
      part_name: 'Data Processor',
      description: 'High-performance data processor with reconnaissance camera and data link',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(320),
      chg_by: 'depot_mgr',
      chg_date: subtractDays(60),
      bom_item_count: 5,
      asset_count: 2,
    },
    {
      cfg_set_id: 9,
      cfg_name: 'Reconnaissance Camera Config',
      cfg_type: 'COMPONENT',
      pgm_id: 3,
      partno_id: 19,
      partno: 'PN-RECON-CAM',
      part_name: 'Reconnaissance Camera',
      description: 'Multi-spectrum reconnaissance camera with IR capability',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(180),
      chg_by: null,
      chg_date: null,
      bom_item_count: 3,
      asset_count: 2,
    },
    {
      cfg_set_id: 10,
      cfg_name: 'Data Link System Config',
      cfg_type: 'COMPONENT',
      pgm_id: 3,
      partno_id: 21,
      partno: 'PN-LINK-SYS',
      part_name: 'Data Link System',
      description: 'Encrypted data link for real-time transmission',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(150),
      chg_by: null,
      chg_date: null,
      bom_item_count: 2,
      asset_count: 1,
    },
    // Program 236 configurations (pgm_id: 4)
    {
      cfg_set_id: 11,
      cfg_name: 'Special System Alpha Config',
      cfg_type: 'SYSTEM',
      pgm_id: 4,
      partno_id: 22,
      partno: 'PN-SPEC-001',
      part_name: 'Special System Alpha',
      description: 'Classified system configuration - access restricted',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(400),
      chg_by: 'admin',
      chg_date: subtractDays(90),
      bom_item_count: 4,
      asset_count: 2,
    },
    {
      cfg_set_id: 12,
      cfg_name: 'Special System Beta Config',
      cfg_type: 'COMPONENT',
      pgm_id: 4,
      partno_id: 24,
      partno: 'PN-SPEC-002',
      part_name: 'Special System Beta',
      description: 'Secondary classified system module',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(220),
      chg_by: null,
      chg_date: null,
      bom_item_count: 2,
      asset_count: 1,
    },
    // Inactive configuration for testing
    {
      cfg_set_id: 13,
      cfg_name: 'Legacy Sensor Config (Deprecated)',
      cfg_type: 'COMPONENT',
      pgm_id: 1,
      partno_id: null,
      partno: 'PN-SENSOR-OLD',
      part_name: 'Legacy Sensor Unit',
      description: 'Deprecated configuration - do not use for new installations',
      active: false,
      ins_by: 'admin',
      ins_date: subtractDays(800),
      chg_by: 'admin',
      chg_date: subtractDays(500),
      bom_item_count: 0,
      asset_count: 0,
    },
  ];
}

// Mutable array of configurations
const configurations: ConfigurationSet[] = initializeConfigurations();

// Initialize BOM (Bill of Materials) mock data with NHA/SRA hierarchy
function initializeBOMItems(): BOMItem[] {
  return [
    // Config 1: Camera System X Configuration (cfg_set_id: 1, partno: PN-CAMERA-X)
    // NHA hierarchy: PN-SENSOR-A is an NHA (assembly), PN-MOUNT-KIT and PN-CABLE-CAM are SRAs under it
    { list_id: 1, cfg_set_id: 1, partno_p: 'PN-CAMERA-X', partno_c: 'PN-SENSOR-A', part_name_c: 'Sensor Unit Alpha', sort_order: 1, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 2, cfg_set_id: 1, partno_p: 'PN-CAMERA-X', partno_c: 'PN-MOUNT-KIT', part_name_c: 'Universal Mounting Kit', sort_order: 2, qpa: 2, active: true, nha_partno_c: 'PN-SENSOR-A', is_sra: true },
    { list_id: 3, cfg_set_id: 1, partno_p: 'PN-CAMERA-X', partno_c: 'PN-CABLE-CAM', part_name_c: 'Camera Cable Assembly', sort_order: 3, qpa: 3, active: true, nha_partno_c: 'PN-SENSOR-A', is_sra: true },

    // Config 2: Radar Unit Configuration (cfg_set_id: 2, partno: PN-RADAR-01)
    // NHA hierarchy: PN-ANTENNA-RADAR is NHA with PSU and CONTROL-PCB as SRAs
    { list_id: 4, cfg_set_id: 2, partno_p: 'PN-RADAR-01', partno_c: 'PN-ANTENNA-RADAR', part_name_c: 'Radar Antenna Assembly', sort_order: 1, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 5, cfg_set_id: 2, partno_p: 'PN-RADAR-01', partno_c: 'PN-PSU-RADAR', part_name_c: 'Radar Power Supply Unit', sort_order: 2, qpa: 1, active: true, nha_partno_c: 'PN-ANTENNA-RADAR', is_sra: true },
    { list_id: 6, cfg_set_id: 2, partno_p: 'PN-RADAR-01', partno_c: 'PN-WAVEGUIDE', part_name_c: 'Waveguide Assembly', sort_order: 3, qpa: 2, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 7, cfg_set_id: 2, partno_p: 'PN-RADAR-01', partno_c: 'PN-CONTROL-PCB', part_name_c: 'Radar Control Board', sort_order: 4, qpa: 1, active: true, nha_partno_c: 'PN-ANTENNA-RADAR', is_sra: true },

    // Config 3: Communication System Config (cfg_set_id: 3, partno: PN-COMM-SYS)
    // NHA hierarchy: PN-RADIO-TX is NHA with ENCRYPT-MOD as SRA
    { list_id: 8, cfg_set_id: 3, partno_p: 'PN-COMM-SYS', partno_c: 'PN-RADIO-TX', part_name_c: 'Radio Transmitter Module', sort_order: 1, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 9, cfg_set_id: 3, partno_p: 'PN-COMM-SYS', partno_c: 'PN-RADIO-RX', part_name_c: 'Radio Receiver Module', sort_order: 2, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 10, cfg_set_id: 3, partno_p: 'PN-COMM-SYS', partno_c: 'PN-ENCRYPT-MOD', part_name_c: 'Encryption Module', sort_order: 3, qpa: 1, active: true, nha_partno_c: 'PN-RADIO-TX', is_sra: true },
    { list_id: 11, cfg_set_id: 3, partno_p: 'PN-COMM-SYS', partno_c: 'PN-ANTENNA-COMM', part_name_c: 'Communication Antenna', sort_order: 4, qpa: 2, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 12, cfg_set_id: 3, partno_p: 'PN-COMM-SYS', partno_c: 'PN-CABLE-COAX', part_name_c: 'Coaxial Cable Assembly', sort_order: 5, qpa: 4, active: true, nha_partno_c: 'PN-ANTENNA-COMM', is_sra: true },

    // Config 4: Navigation Unit Standard (cfg_set_id: 4, partno: PN-NAV-UNIT)
    { list_id: 13, cfg_set_id: 4, partno_p: 'PN-NAV-UNIT', partno_c: 'PN-GPS-RECV', part_name_c: 'GPS Receiver Module', sort_order: 1, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 14, cfg_set_id: 4, partno_p: 'PN-NAV-UNIT', partno_c: 'PN-INERTIAL-MOD', part_name_c: 'Inertial Navigation Module', sort_order: 2, qpa: 1, active: true, nha_partno_c: null, is_sra: false },

    // Config 5: Targeting System A Config (cfg_set_id: 5, partno: PN-TARGET-A)
    // NHA hierarchy: PN-LASER-DES and PN-OPTICAL-SIGHT are NHAs with SERVO-MOUNT as SRA under OPTICAL-SIGHT
    { list_id: 15, cfg_set_id: 5, partno_p: 'PN-TARGET-A', partno_c: 'PN-LASER-DES', part_name_c: 'Laser Designator Unit', sort_order: 1, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 16, cfg_set_id: 5, partno_p: 'PN-TARGET-A', partno_c: 'PN-OPTICAL-SIGHT', part_name_c: 'Optical Sight Assembly', sort_order: 2, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 17, cfg_set_id: 5, partno_p: 'PN-TARGET-A', partno_c: 'PN-SERVO-MOUNT', part_name_c: 'Servo Mount System', sort_order: 3, qpa: 1, active: true, nha_partno_c: 'PN-OPTICAL-SIGHT', is_sra: true },
    { list_id: 18, cfg_set_id: 5, partno_p: 'PN-TARGET-A', partno_c: 'PN-CONTROL-UNIT', part_name_c: 'Targeting Control Unit', sort_order: 4, qpa: 1, active: true, nha_partno_c: null, is_sra: false },

    // Config 6: Targeting System B Config (cfg_set_id: 6, partno: PN-TARGET-B)
    // NHA hierarchy: PN-THERMAL-CAM is NHA with IMAGE-PROC and COOLING-SYS as SRAs
    { list_id: 19, cfg_set_id: 6, partno_p: 'PN-TARGET-B', partno_c: 'PN-THERMAL-CAM', part_name_c: 'Thermal Imaging Camera', sort_order: 1, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 20, cfg_set_id: 6, partno_p: 'PN-TARGET-B', partno_c: 'PN-IMAGE-PROC', part_name_c: 'Image Processing Unit', sort_order: 2, qpa: 1, active: true, nha_partno_c: 'PN-THERMAL-CAM', is_sra: true },
    { list_id: 21, cfg_set_id: 6, partno_p: 'PN-TARGET-B', partno_c: 'PN-COOLING-SYS', part_name_c: 'Thermal Cooling System', sort_order: 3, qpa: 1, active: true, nha_partno_c: 'PN-THERMAL-CAM', is_sra: true },

    // Config 7: Laser Designator Config (cfg_set_id: 7, partno: PN-LASER-SYS)
    { list_id: 22, cfg_set_id: 7, partno_p: 'PN-LASER-SYS', partno_c: 'PN-LASER-DIODE', part_name_c: 'High-Power Laser Diode', sort_order: 1, qpa: 1, active: true, nha_partno_c: null, is_sra: false },
    { list_id: 23, cfg_set_id: 7, partno_p: 'PN-LASER-SYS', partno_c: 'PN-OPTICS-ASM', part_name_c: 'Beam Optics Assembly', sort_order: 2, qpa: 1, active: true, nha_partno_c: 'PN-LASER-DIODE', is_sra: true },
  ];
}

// Mutable array of BOM items
let bomItems: BOMItem[] = initializeBOMItems();

// =====================================
// SOFTWARE VERSION TRACKING
// =====================================

// Software catalog interface
interface Software {
  sw_id: number;
  sw_number: string;
  sw_type: string;
  sys_id: string;
  revision: string;
  revision_date: string;
  sw_title: string;
  sw_desc: string | null;
  eff_date: string;
  cpin_flag: boolean;
  active: boolean;
  pgm_id: number;
}

// Configuration-Software association interface
interface ConfigurationSoftware {
  cfg_sw_id: number;
  cfg_set_id: number;
  sw_id: number;
  eff_date: string;
  ins_by: string;
  ins_date: string;
}

// Configuration Meter Tracking interface
interface ConfigurationMeter {
  cfg_meter_id: number;
  cfg_set_id: number;
  meter_type: string; // 'eti', 'cycles', 'landings', etc.
  tracking_interval: number | null; // Hours/cycles between checks (optional)
  tracking_unit: string | null; // 'hours', 'cycles', 'landings', etc.
  description: string | null;
  active: boolean;
  ins_by: string;
  ins_date: string;
  chg_by: string | null;
  chg_date: string | null;
}

// Initialize mock software catalog data
function initializeSoftware(): Software[] {
  const today = new Date();
  const subtractDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
  };

  return [
    // CRIIS program software (pgm_id: 1)
    {
      sw_id: 1,
      sw_number: 'SW-CAM-CTRL-001',
      sw_type: 'FIRMWARE',
      sys_id: 'CRIIS-CAMERA',
      revision: '2.1.5',
      revision_date: subtractDays(30),
      sw_title: 'Camera Control Software',
      sw_desc: 'Primary camera control firmware for image capture and processing',
      eff_date: subtractDays(30),
      cpin_flag: true,
      active: true,
      pgm_id: 1,
    },
    {
      sw_id: 2,
      sw_number: 'SW-CAM-CTRL-002',
      sw_type: 'FIRMWARE',
      sys_id: 'CRIIS-CAMERA',
      revision: '2.0.8',
      revision_date: subtractDays(120),
      sw_title: 'Camera Control Software (Legacy)',
      sw_desc: 'Previous version of camera control firmware',
      eff_date: subtractDays(120),
      cpin_flag: true,
      active: true,
      pgm_id: 1,
    },
    {
      sw_id: 3,
      sw_number: 'SW-RADAR-DSP-001',
      sw_type: 'DSP',
      sys_id: 'CRIIS-RADAR',
      revision: '3.4.2',
      revision_date: subtractDays(45),
      sw_title: 'Radar Signal Processing',
      sw_desc: 'Digital signal processing software for radar systems',
      eff_date: subtractDays(45),
      cpin_flag: true,
      active: true,
      pgm_id: 1,
    },
    {
      sw_id: 4,
      sw_number: 'SW-COMM-ENC-001',
      sw_type: 'APPLICATION',
      sys_id: 'CRIIS-COMM',
      revision: '4.0.1',
      revision_date: subtractDays(15),
      sw_title: 'Communication Encryption Module',
      sw_desc: 'Secure communication encryption software',
      eff_date: subtractDays(15),
      cpin_flag: true,
      active: true,
      pgm_id: 1,
    },
    {
      sw_id: 5,
      sw_number: 'SW-NAV-GPS-001',
      sw_type: 'FIRMWARE',
      sys_id: 'CRIIS-NAV',
      revision: '1.8.3',
      revision_date: subtractDays(90),
      sw_title: 'GPS Navigation Software',
      sw_desc: 'GPS positioning and navigation algorithms',
      eff_date: subtractDays(90),
      cpin_flag: false,
      active: true,
      pgm_id: 1,
    },
    {
      sw_id: 6,
      sw_number: 'SW-NAV-INS-001',
      sw_type: 'FIRMWARE',
      sys_id: 'CRIIS-NAV',
      revision: '2.2.1',
      revision_date: subtractDays(60),
      sw_title: 'Inertial Navigation Software',
      sw_desc: 'Inertial navigation system integration software',
      eff_date: subtractDays(60),
      cpin_flag: false,
      active: true,
      pgm_id: 1,
    },
    // ACTS program software (pgm_id: 2)
    {
      sw_id: 7,
      sw_number: 'SW-TGT-CTRL-001',
      sw_type: 'APPLICATION',
      sys_id: 'ACTS-TARGET',
      revision: '5.1.0',
      revision_date: subtractDays(20),
      sw_title: 'Targeting Control Software',
      sw_desc: 'Primary targeting system control software',
      eff_date: subtractDays(20),
      cpin_flag: true,
      active: true,
      pgm_id: 2,
    },
    {
      sw_id: 8,
      sw_number: 'SW-LASER-CAL-001',
      sw_type: 'FIRMWARE',
      sys_id: 'ACTS-LASER',
      revision: '1.3.7',
      revision_date: subtractDays(75),
      sw_title: 'Laser Calibration Firmware',
      sw_desc: 'Laser designator calibration and control firmware',
      eff_date: subtractDays(75),
      cpin_flag: true,
      active: true,
      pgm_id: 2,
    },
    {
      sw_id: 9,
      sw_number: 'SW-THERM-IMG-001',
      sw_type: 'DSP',
      sys_id: 'ACTS-THERMAL',
      revision: '2.5.4',
      revision_date: subtractDays(50),
      sw_title: 'Thermal Imaging Processor',
      sw_desc: 'Thermal image processing and enhancement software',
      eff_date: subtractDays(50),
      cpin_flag: false,
      active: true,
      pgm_id: 2,
    },
    // ARDS program software (pgm_id: 3)
    {
      sw_id: 10,
      sw_number: 'SW-RECON-DATA-001',
      sw_type: 'APPLICATION',
      sys_id: 'ARDS-RECON',
      revision: '3.0.2',
      revision_date: subtractDays(35),
      sw_title: 'Reconnaissance Data Handler',
      sw_desc: 'Data handling and transmission software for reconnaissance systems',
      eff_date: subtractDays(35),
      cpin_flag: true,
      active: true,
      pgm_id: 3,
    },
  ];
}

// Initialize mock configuration-software associations
function initializeConfigSoftware(): ConfigurationSoftware[] {
  const today = new Date();
  const subtractDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString();
  };

  return [
    // Camera System X Configuration (cfg_set_id: 1) has SW-CAM-CTRL-001
    { cfg_sw_id: 1, cfg_set_id: 1, sw_id: 1, eff_date: subtractDays(30).split('T')[0], ins_by: 'admin', ins_date: subtractDays(30) },
    // Radar Unit Configuration (cfg_set_id: 2) has SW-RADAR-DSP-001
    { cfg_sw_id: 2, cfg_set_id: 2, sw_id: 3, eff_date: subtractDays(45).split('T')[0], ins_by: 'admin', ins_date: subtractDays(45) },
    // Communication System Config (cfg_set_id: 3) has SW-COMM-ENC-001
    { cfg_sw_id: 3, cfg_set_id: 3, sw_id: 4, eff_date: subtractDays(15).split('T')[0], ins_by: 'depot_mgr', ins_date: subtractDays(15) },
    // Navigation Unit Standard (cfg_set_id: 4) has SW-NAV-GPS-001 and SW-NAV-INS-001
    { cfg_sw_id: 4, cfg_set_id: 4, sw_id: 5, eff_date: subtractDays(90).split('T')[0], ins_by: 'admin', ins_date: subtractDays(90) },
    { cfg_sw_id: 5, cfg_set_id: 4, sw_id: 6, eff_date: subtractDays(60).split('T')[0], ins_by: 'admin', ins_date: subtractDays(60) },
  ];
}

// Asset-Software association interface
interface AssetSoftware {
  assoc_id: number;
  asset_id: number;
  sw_id: number;
  effective_date: string;
  end_date: string | null;
  created_by: string;
  created_date: string;
}

// Initialize mock asset-software associations
function initializeAssetSoftware(): AssetSoftware[] {
  const today = new Date().toISOString().split('T')[0];
  const subtractDays = (days: number): string => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
  };

  return [
    // CRIIS-001 (Sensor Unit A) has Camera Control Software
    {
      assoc_id: 1,
      asset_id: 1,
      sw_id: 1, // Camera Control Software 2.1.5
      effective_date: subtractDays(30),
      end_date: null,
      created_by: 'admin',
      created_date: subtractDays(30),
    },
    // CRIIS-003 (Sensor Unit B) has legacy Camera Control Software
    {
      assoc_id: 2,
      asset_id: 3,
      sw_id: 2, // Camera Control Software (Legacy) 2.0.8
      effective_date: subtractDays(120),
      end_date: null,
      created_by: 'admin',
      created_date: subtractDays(120),
    },
    // CRIIS-007 (Radar Unit 01) has Radar Signal Processing
    {
      assoc_id: 3,
      asset_id: 7,
      sw_id: 3, // Radar Signal Processing 3.4.2
      effective_date: subtractDays(45),
      end_date: null,
      created_by: 'depot_mgr',
      created_date: subtractDays(45),
    },
    // CRIIS-008 (Communication System) has Communication Encryption Module
    {
      assoc_id: 4,
      asset_id: 8,
      sw_id: 4, // Communication Encryption Module 4.0.1
      effective_date: subtractDays(15),
      end_date: null,
      created_by: 'depot_mgr',
      created_date: subtractDays(15),
    },
  ];
}

// Initialize mock configuration meter tracking data
function initializeConfigurationMeters(): ConfigurationMeter[] {
  const today = new Date();
  const subtractDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString();
  };

  return [
    // Camera System X Configuration - tracks ETI (operating hours)
    {
      cfg_meter_id: 1,
      cfg_set_id: 1, // Camera System X Configuration
      meter_type: 'eti',
      tracking_interval: 500,
      tracking_unit: 'hours',
      description: 'Track operating hours for camera system - check every 500 hours',
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(300),
      chg_by: null,
      chg_date: null,
    },
    // Radar Unit Configuration - tracks cycles
    {
      cfg_meter_id: 2,
      cfg_set_id: 2, // Radar Unit Configuration
      meter_type: 'cycles',
      tracking_interval: 1000,
      tracking_unit: 'cycles',
      description: 'Track radar power cycles - maintenance required every 1000 cycles',
      active: true,
      ins_by: 'depot_mgr',
      ins_date: subtractDays(200),
      chg_by: 'depot_mgr',
      chg_date: subtractDays(50),
    },
  ];
}

// Mutable arrays for software tracking
let softwareCatalog: Software[] = initializeSoftware();
let nextSwId = 11; // Next ID for new software (10 exist in initialization)
let assetSoftware: AssetSoftware[] = initializeAssetSoftware();
let nextAssetSwId = 5; // Next ID for new asset-software associations
let configSoftware: ConfigurationSoftware[] = initializeConfigSoftware();
let nextCfgSwId = 6; // Next ID for new configuration-software associations
let configurationMeters: ConfigurationMeter[] = initializeConfigurationMeters();
let nextCfgMeterId = 3; // Next ID for new configuration meter entries

// ============================================================================
// NOTIFICATIONS API
// ============================================================================

// Notification interface
interface Notification {
  msg_id: number;
  pgm_id: number;
  loc_id: number | null;
  msg_text: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  start_date: string;
  stop_date: string | null;
  from_user: string | null;
  to_user: string | null;
  acknowledged: boolean;
  ack_by: string | null;
  ack_date: string | null;
  active: boolean;
  ins_by: string;
  ins_date: string;
}

// Initialize mock notifications data
function initializeNotifications(): Notification[] {
  const today = new Date();
  const subtractDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString();
  };
  const addDays = (days: number): string => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date.toISOString();
  };

  return [
    {
      msg_id: 1,
      pgm_id: 1, // CRIIS
      loc_id: null,
      msg_text: 'System maintenance scheduled for January 25th, 2026 from 02:00-04:00 UTC. System will be unavailable during this period.',
      priority: 'HIGH',
      start_date: subtractDays(2),
      stop_date: addDays(5),
      from_user: 'admin',
      to_user: null, // Broadcast to all users
      acknowledged: false,
      ack_by: null,
      ack_date: null,
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(2),
    },
    {
      msg_id: 2,
      pgm_id: 1, // CRIIS
      loc_id: null,
      msg_text: 'New PMI requirements effective immediately. All Camera System X units must undergo additional inspection. See Technical Order 1A-CR-001.',
      priority: 'CRITICAL',
      start_date: subtractDays(5),
      stop_date: addDays(30),
      from_user: 'depot_mgr',
      to_user: null,
      acknowledged: false,
      ack_by: null,
      ack_date: null,
      active: true,
      ins_by: 'depot_mgr',
      ins_date: subtractDays(5),
    },
    {
      msg_id: 3,
      pgm_id: 2, // ACTS
      loc_id: null,
      msg_text: 'Parts ordering system updated with new tracking features. You can now view real-time shipment status.',
      priority: 'MEDIUM',
      start_date: subtractDays(10),
      stop_date: addDays(10),
      from_user: 'admin',
      to_user: null,
      acknowledged: true,
      ack_by: 'depot_mgr',
      ack_date: subtractDays(8),
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(10),
    },
    {
      msg_id: 4,
      pgm_id: 1, // CRIIS
      loc_id: null,
      msg_text: 'Reminder: All field technicians must complete annual safety training by end of month.',
      priority: 'MEDIUM',
      start_date: subtractDays(15),
      stop_date: addDays(15),
      from_user: 'admin',
      to_user: null,
      acknowledged: false,
      ack_by: null,
      ack_date: null,
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(15),
    },
    {
      msg_id: 5,
      pgm_id: 3, // ARDS
      loc_id: null,
      msg_text: 'New software version 3.0.0 available for Radar Signal Processing units. Update at next maintenance opportunity.',
      priority: 'LOW',
      start_date: subtractDays(20),
      stop_date: addDays(60),
      from_user: 'depot_mgr',
      to_user: null,
      acknowledged: false,
      ack_by: null,
      ack_date: null,
      active: true,
      ins_by: 'depot_mgr',
      ins_date: subtractDays(20),
    },
    {
      msg_id: 6,
      pgm_id: 1, // CRIIS
      loc_id: 154, // Depot Alpha - visible to admin and depot_mgr
      msg_text: 'Depot Alpha: Scheduled facility maintenance on Feb 1st. Depot will operate at reduced capacity.',
      priority: 'HIGH',
      start_date: subtractDays(1),
      stop_date: addDays(10),
      from_user: 'depot_mgr',
      to_user: null,
      acknowledged: false,
      ack_by: null,
      ack_date: null,
      active: true,
      ins_by: 'depot_mgr',
      ins_date: subtractDays(1),
    },
    {
      msg_id: 7,
      pgm_id: 1, // CRIIS
      loc_id: 394, // Field Site Bravo - visible to field_tech
      msg_text: 'Field Site Bravo: New parts shipment arriving tomorrow. Coordinate with warehouse for pickup.',
      priority: 'MEDIUM',
      start_date: subtractDays(1),
      stop_date: addDays(3),
      from_user: 'admin',
      to_user: null,
      acknowledged: false,
      ack_by: null,
      ack_date: null,
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(1),
    },
    {
      msg_id: 8,
      pgm_id: 2, // ACTS
      loc_id: 437, // ACTS location - visible to acts_user
      msg_text: 'ACTS Site: Critical firmware update required for all Targeting Control units by end of week.',
      priority: 'CRITICAL',
      start_date: subtractDays(2),
      stop_date: addDays(5),
      from_user: 'admin',
      to_user: null,
      acknowledged: false,
      ack_by: null,
      ack_date: null,
      active: true,
      ins_by: 'admin',
      ins_date: subtractDays(2),
    },
  ];
}

// Mutable array for notifications tracking
let notifications: Notification[] = initializeNotifications();
let nextMsgId = 9; // Next ID for new notifications

// GET /api/notifications - List all notifications for user's program(s)
app.get('/api/notifications', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get user's location IDs for location-based filtering
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Filter notifications by program access, location, and active status
  const now = new Date().toISOString();
  let userNotifications = notifications.filter(n => {
    // Check program access
    const hasAccess = userProgramIds.includes(n.pgm_id) || user.role === 'ADMIN';
    if (!hasAccess) return false;

    // Check active status
    if (!n.active) return false;

    // Check date range (only show if current date is within start_date and stop_date)
    const isInDateRange = n.start_date <= now && (n.stop_date === null || n.stop_date >= now);
    if (!isInDateRange) return false;

    // SECURITY: Filter by location
    // - If notification has loc_id null: it's a broadcast message (visible to all locations)
    // - If notification has loc_id set: only show to users with access to that location
    // - Admin users bypass location filtering (see all notifications)
    if (n.loc_id !== null && user.role !== 'ADMIN') {
      // Non-admin users: check if notification's location matches user's locations
      if (userLocationIds.length > 0 && !userLocationIds.includes(n.loc_id)) {
        return false;
      }
    }

    return true;
  });

  // Sort by priority (CRITICAL > HIGH > MEDIUM > LOW) then by date (newest first)
  const priorityOrder: Record<string, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
  };

  userNotifications.sort((a, b) => {
    const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.start_date).getTime() - new Date(a.start_date).getTime();
  });

  // Add program name to each notification
  const notificationsWithProgram = userNotifications.map(n => {
    const program = allPrograms.find(p => p.pgm_id === n.pgm_id);
    return {
      ...n,
      program_cd: program?.pgm_cd,
      program_name: program?.pgm_name,
    };
  });

  console.log(`[NOTIFICATIONS] Retrieved ${notificationsWithProgram.length} notifications for user ${user.username} (locations: ${userLocationIds.join(', ') || 'all'})`);
  res.json(notificationsWithProgram);
});

// POST /api/notifications - Create a new notification (admin only)
app.post('/api/notifications', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin can create notifications
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Insufficient permissions to create notifications' });
  }

  const { pgm_id, msg_text, priority, start_date, stop_date, to_user } = req.body;

  // Validate required fields
  if (!pgm_id || !msg_text || !priority || !start_date) {
    return res.status(400).json({ error: 'Missing required fields: pgm_id, msg_text, priority, start_date' });
  }

  // Validate priority
  if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority. Must be: LOW, MEDIUM, HIGH, or CRITICAL' });
  }

  // Validate program exists
  const program = allPrograms.find(p => p.pgm_id === pgm_id);
  if (!program) {
    return res.status(404).json({ error: 'Program not found' });
  }

  // Create new notification
  const newNotification: Notification = {
    msg_id: nextMsgId++,
    pgm_id,
    loc_id: null,
    msg_text,
    priority,
    start_date,
    stop_date: stop_date || null,
    from_user: user.username,
    to_user: to_user || null,
    acknowledged: false,
    ack_by: null,
    ack_date: null,
    active: true,
    ins_by: user.username,
    ins_date: new Date().toISOString(),
  };

  notifications.push(newNotification);

  console.log(`[NOTIFICATIONS] Created notification #${newNotification.msg_id} by ${user.username} for program ${program.pgm_cd}`);

  res.status(201).json({
    message: 'Notification created successfully',
    notification: {
      ...newNotification,
      program_cd: program.pgm_cd,
      program_name: program.pgm_name,
    },
  });
});

// PUT /api/notifications/:id/acknowledge - Acknowledge a notification
app.put('/api/notifications/:id/acknowledge', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const msgId = parseInt(req.params.id, 10);
  if (isNaN(msgId)) {
    return res.status(400).json({ error: 'Invalid notification ID' });
  }

  // Find the notification
  const notification = notifications.find(n => n.msg_id === msgId);
  if (!notification) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(notification.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this notification' });
  }

  // Check if already acknowledged
  if (notification.acknowledged) {
    return res.status(400).json({ error: 'Notification already acknowledged' });
  }

  // Acknowledge the notification
  notification.acknowledged = true;
  notification.ack_by = user.username;
  notification.ack_date = new Date().toISOString();

  console.log(`[NOTIFICATIONS] Notification #${msgId} acknowledged by ${user.username}`);

  const program = allPrograms.find(p => p.pgm_id === notification.pgm_id);
  res.json({
    message: 'Notification acknowledged successfully',
    notification: {
      ...notification,
      program_cd: program?.pgm_cd,
      program_name: program?.pgm_name,
    },
  });
});

// GET /api/notifications/unread-count - Get count of unread notifications for current user
app.get('/api/notifications/unread-count', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Filter notifications by program access, active status, and acknowledged status
  const now = new Date().toISOString();
  const unreadCount = notifications.filter(n => {
    // Check program access
    const hasAccess = userProgramIds.includes(n.pgm_id) || user.role === 'ADMIN';
    if (!hasAccess) return false;

    // Check active status
    if (!n.active) return false;

    // Check date range (only show if current date is within start_date and stop_date)
    const isInDateRange = n.start_date <= now && (n.stop_date === null || n.stop_date >= now);
    if (!isInDateRange) return false;

    // Check if unread
    if (n.acknowledged) return false;

    return true;
  }).length;

  res.json({ count: unreadCount });
});

// GET /api/software - List all software for a program (requires authentication)
app.get('/api/software', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get optional query parameters
  const programId = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;
  const search = (req.query.search as string || '').trim();
  const swType = req.query.type as string || '';

  // Filter software by user's programs and optional filters
  let filteredSoftware = softwareCatalog.filter(sw => {
    // Program access check
    if (user.role === 'ADMIN') {
      // Admin can see all, but filter by programId if specified
      if (programId && sw.pgm_id !== programId) return false;
    } else {
      if (programId) {
        if (!userProgramIds.includes(programId) || sw.pgm_id !== programId) return false;
      } else {
        if (!userProgramIds.includes(sw.pgm_id)) return false;
      }
    }

    // Search filter (case-insensitive)
    if (search) {
      const searchLower = search.toLowerCase();
      const matchesSearch =
        sw.sw_number.toLowerCase().includes(searchLower) ||
        sw.sw_title.toLowerCase().includes(searchLower) ||
        sw.revision.toLowerCase().includes(searchLower) ||
        (sw.sw_desc && sw.sw_desc.toLowerCase().includes(searchLower));
      if (!matchesSearch) return false;
    }

    // Type filter
    if (swType && sw.sw_type !== swType) return false;

    // Only active software
    if (!sw.active) return false;

    return true;
  });

  // Add program info and transform field names for frontend
  const softwareWithProgram = filteredSoftware.map(sw => {
    const program = allPrograms.find(p => p.pgm_id === sw.pgm_id);
    return {
      sw_id: sw.sw_id,
      sw_number: sw.sw_number,
      sw_title: sw.sw_title,
      sw_type: sw.sw_type,
      revision: sw.revision,
      revision_date: sw.revision_date,
      effective_date: sw.eff_date, // Transform: eff_date -> effective_date
      cpin: sw.cpin_flag ? 'Yes' : null, // Transform: cpin_flag -> cpin
      sw_desc: sw.sw_desc,
      pgm_id: sw.pgm_id,
      active: sw.active,
      program: {
        pgm_id: program?.pgm_id || sw.pgm_id,
        pgm_cd: program?.pgm_cd || 'UNKNOWN',
        pgm_name: program?.pgm_name || 'Unknown Program',
      },
    };
  });

  res.json({
    software: softwareWithProgram,
    total: softwareWithProgram.length,
  });
});

// POST /api/software - Create new software version (admin only)
app.post('/api/software', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Only admins can create software
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can create software versions' });
  }

  // Extract and validate required fields
  const {
    sw_number,
    sw_type,
    revision,
    sw_title,
    sw_desc,
    effective_date,
    cpin,
    pgm_id,
  } = req.body;

  // Validate required fields
  if (!sw_number || typeof sw_number !== 'string' || sw_number.trim() === '') {
    return res.status(400).json({ error: 'Software number is required' });
  }

  if (!sw_type || typeof sw_type !== 'string' || sw_type.trim() === '') {
    return res.status(400).json({ error: 'Software type is required' });
  }

  if (!revision || typeof revision !== 'string' || revision.trim() === '') {
    return res.status(400).json({ error: 'Revision is required' });
  }

  if (!sw_title || typeof sw_title !== 'string' || sw_title.trim() === '') {
    return res.status(400).json({ error: 'Title is required' });
  }

  if (!effective_date || typeof effective_date !== 'string') {
    return res.status(400).json({ error: 'Effective date is required' });
  }

  if (pgm_id === undefined || typeof pgm_id !== 'number') {
    return res.status(400).json({ error: 'Program ID is required' });
  }

  // Validate program exists
  const program = allPrograms.find(p => p.pgm_id === pgm_id);
  if (!program) {
    return res.status(400).json({ error: 'Invalid program ID' });
  }

  // Check for duplicate software number
  const existingSoftware = softwareCatalog.find(
    sw => sw.sw_number === sw_number.trim() && sw.active
  );
  if (existingSoftware) {
    return res.status(400).json({ error: 'Software number already exists' });
  }

  // Create new software record
  const newSoftware: Software = {
    sw_id: nextSwId++,
    sw_number: sw_number.trim(),
    sw_type: sw_type.trim(),
    sys_id: '', // System ID can be optional or derived
    revision: revision.trim(),
    revision_date: new Date().toISOString().split('T')[0], // Today's date as revision date
    sw_title: sw_title.trim(),
    sw_desc: sw_desc && typeof sw_desc === 'string' ? sw_desc.trim() : null,
    eff_date: effective_date,
    cpin_flag: cpin === true || cpin === 'true',
    active: true,
    pgm_id: pgm_id,
  };

  // Add to catalog
  softwareCatalog.push(newSoftware);

  console.log(`[SOFTWARE] Created new software version ${newSoftware.sw_number} (ID: ${newSoftware.sw_id}) by ${user.username}`);

  // Return the created software with transformed field names for frontend
  res.status(201).json({
    sw_id: newSoftware.sw_id,
    sw_number: newSoftware.sw_number,
    sw_title: newSoftware.sw_title,
    sw_type: newSoftware.sw_type,
    revision: newSoftware.revision,
    revision_date: newSoftware.revision_date,
    effective_date: newSoftware.eff_date,
    cpin: newSoftware.cpin_flag ? 'Yes' : null,
    sw_desc: newSoftware.sw_desc,
    pgm_id: newSoftware.pgm_id,
    active: newSoftware.active,
    program: {
      pgm_id: program.pgm_id,
      pgm_cd: program.pgm_cd,
      pgm_name: program.pgm_name,
    },
  });
});

// PUT /api/software/:id - Update software version (admin only)
app.put('/api/software/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Only admins can update software
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can update software versions' });
  }

  const swId = parseInt(req.params.id, 10);
  if (isNaN(swId)) {
    return res.status(400).json({ error: 'Invalid software ID' });
  }

  // Find existing software
  const softwareIndex = softwareCatalog.findIndex(sw => sw.sw_id === swId);
  if (softwareIndex === -1) {
    return res.status(404).json({ error: 'Software not found' });
  }

  const existingSoftware = softwareCatalog[softwareIndex];

  // Extract and validate fields
  const {
    sw_number,
    sw_type,
    revision,
    sw_title,
    sw_desc,
    effective_date,
    cpin,
    pgm_id,
  } = req.body;

  // Validate required fields
  if (!sw_number || typeof sw_number !== 'string' || sw_number.trim() === '') {
    return res.status(400).json({ error: 'Software number is required' });
  }

  if (!sw_type || typeof sw_type !== 'string' || sw_type.trim() === '') {
    return res.status(400).json({ error: 'Software type is required' });
  }

  if (!revision || typeof revision !== 'string' || revision.trim() === '') {
    return res.status(400).json({ error: 'Revision is required' });
  }

  if (!sw_title || typeof sw_title !== 'string' || sw_title.trim() === '') {
    return res.status(400).json({ error: 'Title is required' });
  }

  if (!effective_date || typeof effective_date !== 'string') {
    return res.status(400).json({ error: 'Effective date is required' });
  }

  if (pgm_id === undefined || typeof pgm_id !== 'number') {
    return res.status(400).json({ error: 'Program ID is required' });
  }

  // Validate program exists
  const program = allPrograms.find(p => p.pgm_id === pgm_id);
  if (!program) {
    return res.status(400).json({ error: 'Invalid program ID' });
  }

  // Check for duplicate software number (excluding current software)
  const duplicateSoftware = softwareCatalog.find(
    sw => sw.sw_number === sw_number.trim() && sw.active && sw.sw_id !== swId
  );
  if (duplicateSoftware) {
    return res.status(400).json({ error: 'Software number already exists' });
  }

  // Update software record
  const updatedSoftware: Software = {
    ...existingSoftware,
    sw_number: sw_number.trim(),
    sw_type: sw_type.trim(),
    revision: revision.trim(),
    revision_date: new Date().toISOString().split('T')[0], // Update revision date to today
    sw_title: sw_title.trim(),
    sw_desc: sw_desc && typeof sw_desc === 'string' ? sw_desc.trim() : null,
    eff_date: effective_date,
    cpin_flag: cpin === true || cpin === 'true',
    pgm_id: pgm_id,
  };

  // Replace in catalog
  softwareCatalog[softwareIndex] = updatedSoftware;

  console.log(`[SOFTWARE] Updated software version ${updatedSoftware.sw_number} (ID: ${updatedSoftware.sw_id}) by ${user.username}`);

  // Return the updated software with transformed field names for frontend
  res.status(200).json({
    sw_id: updatedSoftware.sw_id,
    sw_number: updatedSoftware.sw_number,
    sw_title: updatedSoftware.sw_title,
    sw_type: updatedSoftware.sw_type,
    revision: updatedSoftware.revision,
    revision_date: updatedSoftware.revision_date,
    effective_date: updatedSoftware.eff_date,
    cpin: updatedSoftware.cpin_flag ? 'Yes' : null,
    sw_desc: updatedSoftware.sw_desc,
    pgm_id: updatedSoftware.pgm_id,
    active: updatedSoftware.active,
    program: {
      pgm_id: program.pgm_id,
      pgm_cd: program.pgm_cd,
      pgm_name: program.pgm_name,
    },
  });
});

// GET /api/configurations/:id/software - Get software associations for a configuration
app.get('/api/configurations/:id/software', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const configId = parseInt(req.params.id, 10);
  if (isNaN(configId)) {
    return res.status(400).json({ error: 'Invalid configuration ID' });
  }

  // Find the configuration
  const config = configurations.find(c => c.cfg_set_id === configId);
  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Get software associations for this configuration
  const associations = configSoftware.filter(cs => cs.cfg_set_id === configId);

  // Map associations to include full software details
  const softwareList = associations.map(assoc => {
    const sw = softwareCatalog.find(s => s.sw_id === assoc.sw_id);
    if (!sw) return null;
    return {
      cfg_sw_id: assoc.cfg_sw_id,
      sw_id: sw.sw_id,
      sw_number: sw.sw_number,
      sw_type: sw.sw_type,
      revision: sw.revision,
      revision_date: sw.revision_date,
      sw_title: sw.sw_title,
      sw_desc: sw.sw_desc,
      cpin_flag: sw.cpin_flag,
      eff_date: assoc.eff_date,
      ins_by: assoc.ins_by,
      ins_date: assoc.ins_date,
    };
  }).filter(Boolean);

  res.json({
    configuration: {
      cfg_set_id: config.cfg_set_id,
      cfg_name: config.cfg_name,
    },
    software: softwareList,
    total: softwareList.length,
  });
});

// POST /api/configurations/:id/software - Add software to a configuration
app.post('/api/configurations/:id/software', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can add software associations
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to modify configuration software' });
  }

  const configId = parseInt(req.params.id, 10);
  if (isNaN(configId)) {
    return res.status(400).json({ error: 'Invalid configuration ID' });
  }

  // Validate request body
  const { sw_id, eff_date } = req.body;
  if (!sw_id || typeof sw_id !== 'number') {
    return res.status(400).json({ error: 'Software ID is required' });
  }
  if (!eff_date) {
    return res.status(400).json({ error: 'Effective date is required' });
  }

  // Find the configuration
  const config = configurations.find(c => c.cfg_set_id === configId);
  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Find the software
  const sw = softwareCatalog.find(s => s.sw_id === sw_id);
  if (!sw) {
    return res.status(404).json({ error: 'Software not found' });
  }

  // Check if association already exists
  const existingAssoc = configSoftware.find(cs => cs.cfg_set_id === configId && cs.sw_id === sw_id);
  if (existingAssoc) {
    return res.status(400).json({ error: 'This software is already associated with this configuration' });
  }

  // Create new association
  const newAssociation: ConfigurationSoftware = {
    cfg_sw_id: nextCfgSwId++,
    cfg_set_id: configId,
    sw_id: sw_id,
    eff_date: eff_date,
    ins_by: user.username,
    ins_date: new Date().toISOString(),
  };

  configSoftware.push(newAssociation);

  console.log(`[CONFIG-SW] Added software "${sw.sw_number}" (${sw.sw_title}) to config "${config.cfg_name}" (ID: ${configId}) by ${user.username}`);

  res.status(201).json({
    message: 'Software added to configuration successfully',
    association: {
      cfg_sw_id: newAssociation.cfg_sw_id,
      sw_id: sw.sw_id,
      sw_number: sw.sw_number,
      sw_type: sw.sw_type,
      revision: sw.revision,
      sw_title: sw.sw_title,
      eff_date: newAssociation.eff_date,
      ins_by: newAssociation.ins_by,
      ins_date: newAssociation.ins_date,
    },
  });
});

// DELETE /api/configurations/:id/software/:swAssocId - Remove software from a configuration
app.delete('/api/configurations/:id/software/:swAssocId', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can remove software associations
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to modify configuration software' });
  }

  const configId = parseInt(req.params.id, 10);
  const swAssocId = parseInt(req.params.swAssocId, 10);

  if (isNaN(configId) || isNaN(swAssocId)) {
    return res.status(400).json({ error: 'Invalid configuration ID or software association ID' });
  }

  // Find the configuration
  const config = configurations.find(c => c.cfg_set_id === configId);
  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check program access
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Find the association
  const assocIndex = configSoftware.findIndex(cs => cs.cfg_sw_id === swAssocId && cs.cfg_set_id === configId);
  if (assocIndex === -1) {
    return res.status(404).json({ error: 'Software association not found' });
  }

  // Get association details before removing
  const removedAssoc = configSoftware[assocIndex];
  const sw = softwareCatalog.find(s => s.sw_id === removedAssoc.sw_id);

  // Remove the association
  configSoftware.splice(assocIndex, 1);

  console.log(`[CONFIG-SW] Removed software "${sw?.sw_number || 'unknown'}" from config "${config.cfg_name}" (ID: ${configId}) by ${user.username}`);

  res.json({
    message: 'Software removed from configuration successfully',
    removed: {
      cfg_sw_id: removedAssoc.cfg_sw_id,
      sw_id: removedAssoc.sw_id,
      sw_number: sw?.sw_number,
      sw_title: sw?.sw_title,
    },
  });
});

// GET /api/configurations - List all configurations for a program (requires authentication)
// Now queries the database instead of using mock data
// Supports location filtering: only shows configs used by assets at the selected location
app.get('/api/configurations', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    // Get user's program IDs
    const userProgramIds = user.programs.map(p => p.pgm_id);

    // Get program filter from query string (required or use default)
    let programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

    // If no program specified, use user's default program
    if (!programIdFilter) {
      const defaultProgram = user.programs.find(p => p.is_default);
      programIdFilter = defaultProgram?.pgm_id || user.programs[0]?.pgm_id || 1;
    }

    // Check if user has access to this program
    if (!userProgramIds.includes(programIdFilter) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this program' });
    }

    // Get location filter - 0 or null means "All Locations"
    const locationIdRaw = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;
    const locationIdFilter = locationIdRaw === 0 ? null : locationIdRaw;

    // Get other filters
    const showInactive = req.query.include_inactive === 'true';
    const typeFilter = req.query.type as string | undefined;
    const sysTypeFilter = req.query.sys_type as string | undefined; // System category: AIRBORNE, ECU, GROUND, SUPPORT EQUIPMENT
    const searchQuery = (req.query.search as string)?.toLowerCase().trim() || null;
    const sortBy = (req.query.sort_by as string) || 'cfg_name';
    const sortOrder = (req.query.sort_order as string) || 'asc';
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 100);
    const offset = (page - 1) * limit;

    // Build Prisma where clause
    const whereClause: Prisma.CfgSetWhereInput = {
      pgm_id: programIdFilter,
    };

    // Apply active filter
    if (!showInactive) {
      whereClause.active = true;
    }

    // Apply type filter
    if (typeFilter) {
      whereClause.cfg_type = typeFilter;
    }

    // Apply system type filter
    // The sys_type field stores CODE_IDs (numeric) but users may filter by CODE_VALUE (text)
    // Map common CODE_VALUEs to their CODE_IDs for filtering
    if (sysTypeFilter) {
      // Individual sys_type code mappings (CODE_VALUE -> [CODE_ID, CODE_VALUE])
      const sysTypeCodeMap: Record<string, string[]> = {
        'POD': ['10', 'POD'],
        'TE': ['17', 'TE'],
        'SE': ['16', 'SE'],
        'ECU': ['38725', 'ECU'],
        'GSS': ['38726', 'GSS'],
        'IM': ['38727', 'IM'],
        'CCS': ['1', 'CCS'],
        'DLG': ['2', 'DLG'],
        'DS': ['3', 'DS'],
        'INTERFACE': ['4', 'INTERFACE'],
        'MRG': ['5', 'MRG'],
        'NRC': ['6', 'NRC'],
        'PART': ['7', 'PART'],
        'PGS': ['8', 'PGS'],
        'PLT': ['9', 'PLT'],
        'RAP': ['11', 'RAP'],
        'REM': ['12', 'REM'],
        'RR': ['13', 'RR'],
        'RRU': ['14', 'RRU'],
        'SC': ['15', 'SC'],
        'TGS': ['18', 'TGS'],
        'TIS': ['19', 'TIS'],
        'UNKN': ['20', 'UNKN'],
      };

      // Category mappings - broader categories that group multiple sys_types
      // These match the legacy RIMSS system categories
      const categoryMap: Record<string, string[]> = {
        // AIRBORNE: Airborne platforms and pod systems
        'AIRBORNE': ['10', 'POD', '38727', 'IM', '11', 'RAP', '9', 'PLT'],
        // GROUND: Ground-based support systems
        'GROUND': ['38726', 'GSS'],
        // SUPPORT EQUIPMENT: Support, test equipment, shipping containers
        'SUPPORT EQUIPMENT': ['16', 'SE', '17', 'TE', '15', 'SC'],
      };

      // Check if filter is a category first, then fall back to individual sys_type
      const upperFilter = sysTypeFilter.toUpperCase();
      const filterValues = categoryMap[upperFilter] || sysTypeCodeMap[upperFilter] || [sysTypeFilter];

      whereClause.part = {
        sys_type: { in: filterValues },
      };
    }

    // Apply search filter
    if (searchQuery) {
      whereClause.OR = [
        { cfg_name: { contains: searchQuery, mode: 'insensitive' } },
        { description: { contains: searchQuery, mode: 'insensitive' } },
        { part: { partno: { contains: searchQuery, mode: 'insensitive' } } },
        { part: { noun: { contains: searchQuery, mode: 'insensitive' } } },
      ];
    }

    // Apply location filter: only show configs used by assets at this location
    // For non-admin users or when a specific location is selected
    if (locationIdFilter && locationIdFilter > 0) {
      whereClause.assets = {
        some: {
          OR: [
            { loc_ida: locationIdFilter },
            { loc_idc: locationIdFilter },
          ],
          active: true,
        },
      };
    } else if (user.role !== 'ADMIN' && user.locations && user.locations.length > 0) {
      // Non-admin users can only see configs for their assigned locations
      const userLocationIds = user.locations.map(l => l.loc_id);
      whereClause.assets = {
        some: {
          OR: [
            { loc_ida: { in: userLocationIds } },
            { loc_idc: { in: userLocationIds } },
          ],
          active: true,
        },
      };
    }
    // ADMIN with no location filter sees all configs for the program

    // Build orderBy clause
    const orderDirection: Prisma.SortOrder = sortOrder === 'desc' ? 'desc' : 'asc';

    // Determine if we need post-query sorting (for computed fields like counts)
    // Prisma doesn't support orderBy on _count relations with filters directly
    // So we handle those with post-query sorting
    let needsPostSort = false;
    let postSortField: string | null = null;
    let orderByClause: Prisma.CfgSetOrderByWithRelationInput | Prisma.CfgSetOrderByWithRelationInput[] = { cfg_name: 'asc' };

    switch (sortBy) {
      case 'cfg_name':
        orderByClause = { cfg_name: orderDirection };
        break;
      case 'cfg_type':
        orderByClause = { cfg_type: orderDirection };
        break;
      case 'ins_date':
        orderByClause = { ins_date: orderDirection };
        break;
      case 'partno':
        // Sort by related part's partno field
        orderByClause = { part: { partno: orderDirection } };
        break;
      case 'bom_item_count':
      case 'asset_count':
        // For count-based sorting, we need to:
        // 1. Fetch all matching records (within a reasonable limit)
        // 2. Sort in memory
        // This is a trade-off due to Prisma limitations with filtered _count ordering
        needsPostSort = true;
        postSortField = sortBy;
        orderByClause = { cfg_name: 'asc' }; // Default order for initial fetch
        break;
      default:
        orderByClause = { cfg_name: orderDirection };
    }

    // Get total count for pagination
    const totalCount = await prisma.cfgSet.count({ where: whereClause });

    // Build the asset count filter - should match the location filtering applied to configs
    // This ensures the asset count reflects only assets at the selected location
    let assetCountFilter: Prisma.AssetWhereInput = { active: true };

    if (locationIdFilter && locationIdFilter > 0) {
      // Specific location selected - count only assets at this location
      assetCountFilter = {
        active: true,
        OR: [
          { loc_ida: locationIdFilter },
          { loc_idc: locationIdFilter },
        ],
      };
    } else if (user.role !== 'ADMIN' && user.locations && user.locations.length > 0) {
      // Non-admin user - count only assets at their assigned locations
      const userLocationIds = user.locations.map(l => l.loc_id);
      assetCountFilter = {
        active: true,
        OR: [
          { loc_ida: { in: userLocationIds } },
          { loc_idc: { in: userLocationIds } },
        ],
      };
    }
    // ADMIN with no location filter counts all active assets

    // Query configurations from database
    let dbConfigs;

    if (needsPostSort) {
      // For count-based sorting, fetch all matching records then sort and paginate in memory
      // This is necessary because Prisma can't ORDER BY _count with WHERE clauses on relations
      const allConfigs = await prisma.cfgSet.findMany({
        where: whereClause,
        include: {
          part: {
            select: {
              partno_id: true,
              partno: true,
              noun: true,
              sys_type: true,
            },
          },
          _count: {
            select: {
              cfgLists: { where: { active: true } },
              assets: { where: assetCountFilter },
            },
          },
        },
      });

      // Sort in memory by the count field
      allConfigs.sort((a, b) => {
        let aVal: number, bVal: number;
        if (postSortField === 'bom_item_count') {
          aVal = a._count.cfgLists;
          bVal = b._count.cfgLists;
        } else {
          aVal = a._count.assets;
          bVal = b._count.assets;
        }
        return orderDirection === 'asc' ? aVal - bVal : bVal - aVal;
      });

      // Apply pagination
      dbConfigs = allConfigs.slice(offset, offset + limit);
    } else {
      // Standard database-level sorting with pagination
      dbConfigs = await prisma.cfgSet.findMany({
        where: whereClause,
        include: {
          part: {
            select: {
              partno_id: true,
              partno: true,
              noun: true,
              sys_type: true,
            },
          },
          _count: {
            select: {
              cfgLists: { where: { active: true } },
              assets: { where: assetCountFilter },
            },
          },
        },
        orderBy: orderByClause,
        skip: offset,
        take: limit,
      });
    }

    // Get program info
    const program = await prisma.program.findUnique({
      where: { pgm_id: programIdFilter },
      select: { pgm_id: true, pgm_cd: true, pgm_name: true },
    });

    // Transform to API response format
    const configurations = dbConfigs.map(cfg => ({
      cfg_set_id: cfg.cfg_set_id,
      cfg_name: cfg.cfg_name,
      cfg_type: cfg.cfg_type || 'ASSEMBLY',
      pgm_id: cfg.pgm_id,
      partno_id: cfg.partno_id,
      partno: cfg.part?.partno || null,
      part_name: cfg.part?.noun || null,
      sys_type: cfg.part?.sys_type || null, // System category: AIRBORNE, ECU, GROUND, SUPPORT EQUIPMENT
      description: cfg.description,
      active: cfg.active,
      ins_by: cfg.ins_by || 'SYSTEM',
      ins_date: cfg.ins_date.toISOString(),
      chg_by: cfg.chg_by,
      chg_date: cfg.chg_date?.toISOString() || null,
      bom_item_count: cfg._count.cfgLists,
      asset_count: cfg._count.assets,
    }));

    console.log(`[CONFIGS] Database query by ${user.username} for program ${program?.pgm_cd}, location ${locationIdFilter || 'ALL'}, sys_type ${sysTypeFilter || 'ALL'} - Total: ${totalCount}, Page: ${page}`);

    res.json({
      configurations,
      pagination: {
        page,
        limit,
        total: totalCount,
        total_pages: Math.ceil(totalCount / limit),
      },
      program: {
        pgm_id: program?.pgm_id || programIdFilter,
        pgm_cd: program?.pgm_cd || 'UNKNOWN',
        pgm_name: program?.pgm_name || 'Unknown Program',
      },
    });
  } catch (error) {
    console.error('[CONFIGS] Database error:', error);
    res.status(500).json({ error: 'Failed to fetch configurations from database' });
  }
});

// GET /api/configurations/:id - Get single configuration by ID (requires authentication)
// Now queries the database instead of mock data
app.get('/api/configurations/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const configId = parseInt(req.params.id, 10);

    // Get configuration from database
    const config = await prisma.cfgSet.findUnique({
      where: { cfg_set_id: configId },
      include: {
        part: {
          select: { partno_id: true, partno: true, noun: true },
        },
        program: {
          select: { pgm_id: true, pgm_cd: true, pgm_name: true },
        },
        _count: {
          select: {
            cfgLists: { where: { active: true } },
            assets: { where: { active: true } },
          },
        },
      },
    });

    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Check if user has access to this configuration's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this configuration' });
    }

    console.log(`[CONFIGS] Detail request for config ${config.cfg_name} by ${user.username}`);

    res.json({
      configuration: {
        cfg_set_id: config.cfg_set_id,
        cfg_name: config.cfg_name,
        cfg_type: config.cfg_type || 'ASSEMBLY',
        pgm_id: config.pgm_id,
        partno_id: config.partno_id,
        partno: config.part?.partno || null,
        part_name: config.part?.noun || null,
        description: config.description,
        active: config.active,
        ins_by: config.ins_by || 'SYSTEM',
        ins_date: config.ins_date.toISOString(),
        chg_by: config.chg_by,
        chg_date: config.chg_date?.toISOString() || null,
        bom_item_count: config._count.cfgLists,
        asset_count: config._count.assets,
        program_cd: config.program.pgm_cd,
        program_name: config.program.pgm_name,
      },
    });
  } catch (error) {
    console.error('[CONFIGS] Database error fetching configuration:', error);
    res.status(500).json({ error: 'Failed to fetch configuration from database' });
  }
});

// GET /api/configurations/:id/bom - Get BOM (Bill of Materials) for a configuration (requires authentication)
// Now queries cfg_list from database with part lookups
app.get('/api/configurations/:id/bom', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const configId = parseInt(req.params.id, 10);

    // Get configuration from database
    const config = await prisma.cfgSet.findUnique({
      where: { cfg_set_id: configId },
      include: {
        part: {
          select: { partno_id: true, partno: true, noun: true },
        },
      },
    });

    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Check if user has access to this configuration's program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this configuration' });
    }

    // Get BOM items from cfg_list table, sorted by sort_order
    const dbBomItems = await prisma.cfgList.findMany({
      where: {
        cfg_set_id: configId,
        active: true,
      },
      include: {
        parentPart: {
          select: { partno_id: true, partno: true, noun: true },
        },
        childPart: {
          select: { partno_id: true, partno: true, noun: true },
        },
      },
      orderBy: { sort_order: 'asc' },
    });

    // Transform to API response format with graceful handling of missing part references
    const bomItems = dbBomItems.map(item => {
      // Handle missing part references gracefully - log warning but don't crash
      const hasParentPart = item.parentPart !== null;
      const hasChildPart = item.childPart !== null;

      if (!hasParentPart) {
        console.warn(`[CONFIGS] BOM item ${item.list_id} references missing parent part (partno_p: ${item.partno_p})`);
      }
      if (!hasChildPart) {
        console.warn(`[CONFIGS] BOM item ${item.list_id} references missing child part (partno_c: ${item.partno_c})`);
      }

      return {
        list_id: item.list_id,
        cfg_set_id: item.cfg_set_id,
        partno_p: item.partno_p,
        parent_partno: hasParentPart ? item.parentPart.partno : `UNKNOWN-${item.partno_p}`,
        parent_noun: hasParentPart ? item.parentPart.noun : 'Unknown Part (Reference Missing)',
        partno_c: item.partno_c,
        child_partno: hasChildPart ? item.childPart.partno : `UNKNOWN-${item.partno_c}`,
        child_noun: hasChildPart ? item.childPart.noun : 'Unknown Part (Reference Missing)',
        sort_order: item.sort_order,
        qpa: item.qpa,
        active: item.active,
        ins_by: item.ins_by,
        ins_date: item.ins_date.toISOString(),
        chg_by: item.chg_by,
        chg_date: item.chg_date?.toISOString() || null,
        // Flag to indicate orphaned references for UI handling
        has_missing_references: !hasParentPart || !hasChildPart,
      };
    });

    console.log(`[CONFIGS] BOM database query for config ${config.cfg_name} by ${user.username} - ${bomItems.length} items`);

    res.json({
      bom_items: bomItems,
      total: bomItems.length,
      configuration: {
        cfg_set_id: config.cfg_set_id,
        cfg_name: config.cfg_name,
        partno: config.part?.partno || null,
      },
    });
  } catch (error) {
    console.error('[CONFIGS] BOM database error:', error);
    res.status(500).json({ error: 'Failed to fetch BOM from database' });
  }
});

// GET /api/configurations/:id/meters - Get meter tracking requirements for a configuration
app.get('/api/configurations/:id/meters', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const configId = parseInt(req.params.id, 10);
  const config = configurations.find(c => c.cfg_set_id === configId);

  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check if user has access to this configuration's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Get meter tracking requirements for this configuration
  const configMeters = configurationMeters
    .filter(m => m.cfg_set_id === configId && m.active)
    .sort((a, b) => a.cfg_meter_id - b.cfg_meter_id);

  console.log(`[CONFIGS] Meters request for config ${config.cfg_name} by ${user.username} - ${configMeters.length} meters`);

  res.json({
    meters: configMeters,
    total: configMeters.length,
    configuration: {
      cfg_set_id: config.cfg_set_id,
      cfg_name: config.cfg_name,
      partno: config.partno,
    },
  });
});

// POST /api/configurations/:id/meters - Add meter tracking requirement (requires depot_manager or admin)
app.post('/api/configurations/:id/meters', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - Only DEPOT_MANAGER and ADMIN can add meter requirements
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to manage meter tracking' });
  }

  const configId = parseInt(req.params.id, 10);
  const config = configurations.find(c => c.cfg_set_id === configId);

  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check if user has access to this configuration's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  const { meter_type, tracking_interval, tracking_unit, description } = req.body;

  // Validate required fields
  if (!meter_type || meter_type.trim() === '') {
    return res.status(400).json({ error: 'Meter type is required' });
  }

  // Validate meter type
  const validMeterTypes = ['eti', 'cycles', 'landings', 'flight_hours', 'engine_starts', 'other'];
  if (!validMeterTypes.includes(meter_type)) {
    return res.status(400).json({ error: `Invalid meter type. Must be one of: ${validMeterTypes.join(', ')}` });
  }

  // Validate tracking interval if provided
  if (tracking_interval !== null && tracking_interval !== undefined) {
    const parsedInterval = parseFloat(tracking_interval);
    if (isNaN(parsedInterval) || parsedInterval <= 0) {
      return res.status(400).json({ error: 'Tracking interval must be a positive number' });
    }
  }

  // Create new meter tracking entry
  const newMeter: ConfigurationMeter = {
    cfg_meter_id: nextCfgMeterId++,
    cfg_set_id: configId,
    meter_type: meter_type.trim(),
    tracking_interval: tracking_interval ? parseFloat(tracking_interval) : null,
    tracking_unit: tracking_unit ? tracking_unit.trim() : null,
    description: description ? description.trim() : null,
    active: true,
    ins_by: user.username,
    ins_date: new Date().toISOString(),
    chg_by: null,
    chg_date: null,
  };

  configurationMeters.push(newMeter);

  console.log(`[CONFIGS] Meter tracking added to config ${config.cfg_name} by ${user.username} - Type: ${meter_type}`);

  res.status(201).json({
    message: 'Meter tracking requirement added successfully',
    meter: newMeter,
  });
});

// DELETE /api/configurations/:id/meters/:meterId - Remove meter tracking requirement (requires depot_manager or admin)
app.delete('/api/configurations/:id/meters/:meterId', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role - Only DEPOT_MANAGER and ADMIN can remove meter requirements
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to manage meter tracking' });
  }

  const configId = parseInt(req.params.id, 10);
  const meterId = parseInt(req.params.meterId, 10);

  const config = configurations.find(c => c.cfg_set_id === configId);
  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check if user has access to this configuration's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  const meterIndex = configurationMeters.findIndex(m => m.cfg_meter_id === meterId && m.cfg_set_id === configId);
  if (meterIndex === -1) {
    return res.status(404).json({ error: 'Meter tracking requirement not found' });
  }

  const meter = configurationMeters[meterIndex];

  // Check if meter is already deleted (idempotency check)
  if (meter.active === false) {
    return res.status(404).json({ error: 'Meter tracking requirement not found or already deleted' });
  }

  // Soft delete by setting active to false
  configurationMeters[meterIndex].active = false;
  configurationMeters[meterIndex].chg_by = user.username;
  configurationMeters[meterIndex].chg_date = new Date().toISOString();

  console.log(`[CONFIGS] Meter tracking removed from config ${config.cfg_name} by ${user.username} - ID: ${meterId}`);

  res.json({
    message: 'Meter tracking requirement removed successfully',
  });
});

// PUT /api/configurations/:id - Update configuration (requires depot_manager or admin)
app.put('/api/configurations/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can edit configurations
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to edit configurations' });
  }

  const configId = parseInt(req.params.id, 10);
  const configIndex = configurations.findIndex(c => c.cfg_set_id === configId);

  if (configIndex === -1) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  const config = configurations[configIndex];

  // Check if user has access to this configuration's program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Extract updatable fields from request body
  const { cfg_name, cfg_type, description, active } = req.body;

  // Validation
  if (cfg_name !== undefined && (typeof cfg_name !== 'string' || cfg_name.trim().length === 0)) {
    return res.status(400).json({ error: 'Configuration name cannot be empty' });
  }

  if (cfg_type !== undefined && !['ASSEMBLY', 'SYSTEM', 'COMPONENT'].includes(cfg_type)) {
    return res.status(400).json({ error: 'Invalid configuration type. Must be ASSEMBLY, SYSTEM, or COMPONENT' });
  }

  // Store old values for audit logging
  const oldValues = {
    cfg_name: config.cfg_name,
    cfg_type: config.cfg_type,
    description: config.description,
    active: config.active,
  };

  // Update fields
  if (cfg_name !== undefined) {
    config.cfg_name = cfg_name.trim();
  }
  if (cfg_type !== undefined) {
    config.cfg_type = cfg_type;
  }
  if (description !== undefined) {
    config.description = description?.trim() || null;
  }
  if (active !== undefined) {
    config.active = Boolean(active);
  }

  // Update audit fields
  config.chg_by = user.username;
  config.chg_date = new Date().toISOString();

  // Get program info
  const program = allPrograms.find(p => p.pgm_id === config.pgm_id);

  console.log(`[CONFIGS] Updated config ${config.cfg_name} (ID: ${configId}) by ${user.username}`);
  console.log(`[CONFIGS] Old values:`, oldValues);
  console.log(`[CONFIGS] New values:`, { cfg_name: config.cfg_name, cfg_type: config.cfg_type, description: config.description, active: config.active });

  res.json({
    message: 'Configuration updated successfully',
    configuration: {
      ...config,
      program_cd: program?.pgm_cd || 'UNKNOWN',
      program_name: program?.pgm_name || 'Unknown Program',
    },
  });
});

// GET /api/reference/parts - Get available part numbers for configuration forms
app.get('/api/reference/parts', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get program filter from query string
  let programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // If no program specified, use user's default program
  if (!programIdFilter) {
    const defaultProgram = user.programs.find(p => p.is_default);
    programIdFilter = defaultProgram?.pgm_id || user.programs[0]?.pgm_id || 1;
  }

  // Check if user has access to this program
  if (!userProgramIds.includes(programIdFilter) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this program' });
  }

  // Mock part numbers for the program (in real app, this would come from part_list table)
  const mockParts = [
    { partno_id: 1, partno: 'PN-SENSOR-A', name: 'Sensor Unit A', pgm_id: 1 },
    { partno_id: 2, partno: 'PN-SENSOR-B', name: 'Sensor Unit B', pgm_id: 1 },
    { partno_id: 3, partno: 'PN-SENSOR-C', name: 'Sensor Unit C', pgm_id: 1 },
    { partno_id: 4, partno: 'PN-CAMERA-X', name: 'Camera System X', pgm_id: 1 },
    { partno_id: 5, partno: 'PN-CAMERA-Y', name: 'Camera System Y', pgm_id: 1 },
    { partno_id: 6, partno: 'PN-RADAR-01', name: 'Radar Unit 01', pgm_id: 1 },
    { partno_id: 7, partno: 'PN-RADAR-02', name: 'Radar Unit 02', pgm_id: 1 },
    { partno_id: 8, partno: 'PN-COMM-SYS', name: 'Communication System', pgm_id: 1 },
    { partno_id: 9, partno: 'PN-POWER-MOD', name: 'Power Module', pgm_id: 1 },
    { partno_id: 10, partno: 'PN-NAV-UNIT', name: 'Navigation Unit', pgm_id: 1 },
    { partno_id: 11, partno: 'PN-TARGET-A', name: 'Targeting System A', pgm_id: 2 },
    { partno_id: 12, partno: 'PN-TARGET-B', name: 'Targeting System B', pgm_id: 2 },
    { partno_id: 13, partno: 'PN-TARGET-C', name: 'Targeting System C', pgm_id: 2 },
    { partno_id: 14, partno: 'PN-OPTICS-A', name: 'Optical System A', pgm_id: 2 },
    { partno_id: 15, partno: 'PN-LASER-01', name: 'Laser Designator 01', pgm_id: 2 },
    { partno_id: 16, partno: 'PN-RECON-A', name: 'Reconnaissance Unit A', pgm_id: 3 },
    { partno_id: 17, partno: 'PN-RECON-B', name: 'Reconnaissance Unit B', pgm_id: 3 },
    { partno_id: 18, partno: 'PN-DATA-SYS', name: 'Data Processing System', pgm_id: 3 },
    { partno_id: 19, partno: 'PN-236-CTRL', name: '236 Control Unit', pgm_id: 4 },
    { partno_id: 20, partno: 'PN-236-PROC', name: '236 Processor Module', pgm_id: 4 },
  ];

  // Filter parts by program
  const filteredParts = mockParts.filter(p => p.pgm_id === programIdFilter);

  res.json({
    parts: filteredParts,
    total: filteredParts.length,
  });
});

// POST /api/configurations - Create new configuration (requires depot_manager or admin)
app.post('/api/configurations', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can create configurations
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to create configurations' });
  }

  const { cfg_name, cfg_type, partno_id, description, pgm_id } = req.body;

  // Validation
  if (!cfg_name || typeof cfg_name !== 'string' || cfg_name.trim().length === 0) {
    return res.status(400).json({ error: 'Configuration name is required' });
  }

  if (!cfg_type || !['ASSEMBLY', 'SYSTEM', 'COMPONENT'].includes(cfg_type)) {
    return res.status(400).json({ error: 'Configuration type is required and must be ASSEMBLY, SYSTEM, or COMPONENT' });
  }

  // Determine program ID
  const targetPgmId = pgm_id || user.programs.find(p => p.is_default)?.pgm_id || user.programs[0]?.pgm_id || 1;

  // Check if user has access to target program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(targetPgmId) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this program' });
  }

  try {
    // Check for duplicate configuration name in same program
    const existingConfig = await prisma.cfgSet.findFirst({
      where: {
        cfg_name: { equals: cfg_name.trim(), mode: 'insensitive' },
        pgm_id: targetPgmId,
      },
    });
    if (existingConfig) {
      return res.status(400).json({ error: 'A configuration with this name already exists in this program' });
    }

    // Create new configuration in database
    const newConfig = await prisma.cfgSet.create({
      data: {
        cfg_name: cfg_name.trim(),
        cfg_type,
        pgm_id: targetPgmId,
        partno_id: partno_id || null,
        description: description?.trim() || null,
        active: true,
        ins_by: user.username,
        ins_date: new Date(),
      },
    });

    // Get program info
    const program = await prisma.program.findUnique({
      where: { pgm_id: targetPgmId },
      select: { pgm_cd: true, pgm_name: true },
    });

    // Get part info if partno_id was provided
    let partInfo = null;
    if (partno_id) {
      partInfo = await prisma.partList.findUnique({
        where: { partno_id: partno_id },
        select: { partno: true, noun: true },
      });
    }

    console.log(`[CONFIGS] Created new config "${newConfig.cfg_name}" (ID: ${newConfig.cfg_set_id}) by ${user.username} for program ${program?.pgm_cd}`);

    res.status(201).json({
      message: 'Configuration created successfully',
      configuration: {
        cfg_set_id: newConfig.cfg_set_id,
        cfg_name: newConfig.cfg_name,
        cfg_type: newConfig.cfg_type,
        pgm_id: newConfig.pgm_id,
        partno_id: newConfig.partno_id,
        partno: partInfo?.partno || null,
        part_name: partInfo?.noun || null,
        description: newConfig.description,
        active: newConfig.active,
        ins_by: newConfig.ins_by,
        ins_date: newConfig.ins_date.toISOString(),
        chg_by: null,
        chg_date: null,
        bom_item_count: 0,
        asset_count: 0,
        program_cd: program?.pgm_cd || 'UNKNOWN',
        program_name: program?.pgm_name || 'Unknown Program',
      },
    });
  } catch (error) {
    console.error('[CONFIGS] Error creating configuration:', error);
    res.status(500).json({ error: 'Failed to create configuration' });
  }
});

// DELETE /api/configurations/:id - Delete configuration (requires depot_manager or admin)
app.delete('/api/configurations/:id', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can delete configurations
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to delete configurations' });
  }

  const configId = parseInt(req.params.id, 10);
  if (isNaN(configId)) {
    return res.status(400).json({ error: 'Invalid configuration ID' });
  }

  const configIndex = configurations.findIndex(c => c.cfg_set_id === configId);
  if (configIndex === -1) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  const config = configurations[configIndex];

  // Check if user has access to this program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Check if configuration has linked assets
  if (config.asset_count > 0) {
    return res.status(400).json({
      error: `Cannot delete configuration with linked assets. This configuration has ${config.asset_count} asset(s) linked to it. Please unlink all assets before deleting.`
    });
  }

  // Remove from configurations array
  const deletedConfig = configurations.splice(configIndex, 1)[0];

  // Get program info
  const program = allPrograms.find(p => p.pgm_id === deletedConfig.pgm_id);

  console.log(`[CONFIGS] Deleted config "${deletedConfig.cfg_name}" (ID: ${configId}) by ${user.username} from program ${program?.pgm_cd}`);

  res.json({
    message: 'Configuration deleted successfully',
    configuration: {
      cfg_set_id: deletedConfig.cfg_set_id,
      cfg_name: deletedConfig.cfg_name,
      cfg_type: deletedConfig.cfg_type,
    },
  });
});

// POST /api/configurations/:id/bom - Add a part to configuration BOM
app.post('/api/configurations/:id/bom', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can add BOM items
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to modify BOM' });
  }

  const configId = parseInt(req.params.id, 10);
  if (isNaN(configId)) {
    return res.status(400).json({ error: 'Invalid configuration ID' });
  }

  // Find the configuration
  const config = configurations.find(c => c.cfg_set_id === configId);
  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check if user has access to this program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Validate request body
  const { partno_c, part_name_c, qpa, sort_order, nha_partno_c } = req.body;

  if (!partno_c || typeof partno_c !== 'string' || partno_c.trim() === '') {
    return res.status(400).json({ error: 'Child part number is required' });
  }

  if (!part_name_c || typeof part_name_c !== 'string' || part_name_c.trim() === '') {
    return res.status(400).json({ error: 'Child part name is required' });
  }

  const qpaValue = parseInt(qpa, 10);
  if (isNaN(qpaValue) || qpaValue < 1) {
    return res.status(400).json({ error: 'Quantity per assembly must be at least 1' });
  }

  const sortOrderValue = parseInt(sort_order, 10) || (bomItems.filter(b => b.cfg_set_id === configId).length + 1);

  // Validate NHA parent if provided
  let validatedNhaPartno: string | null = null;
  if (nha_partno_c && typeof nha_partno_c === 'string' && nha_partno_c.trim() !== '') {
    // VALIDATION 1: Check configuration type compatibility
    // COMPONENT type configurations should not have complex NHA hierarchies
    if (config.cfg_type === 'COMPONENT') {
      return res.status(400).json({
        error: 'Incompatible part type: COMPONENT configurations cannot have NHA parent relationships. Only ASSEMBLY and SYSTEM configurations support hierarchical BOM structures.',
        validation_type: 'incompatible_type'
      });
    }

    // Check if the NHA parent exists in this configuration's BOM
    const nhaParent = bomItems.find(
      item => item.cfg_set_id === configId && item.partno_c === nha_partno_c.trim()
    );
    if (!nhaParent) {
      return res.status(400).json({ error: 'NHA parent part not found in this configuration\'s BOM' });
    }

    // VALIDATION 2: Circular reference detection
    // Check if the proposed parent (nha_partno_c) is already a child of the new part (partno_c)
    // This would create a circular reference: A -> B -> A
    const checkCircularReference = (childPartno: string, potentialParentPartno: string, visited: Set<string> = new Set()): boolean => {
      // If we've already visited this part, we have a cycle
      if (visited.has(childPartno)) {
        return true;
      }
      visited.add(childPartno);

      // Find all parts that have this childPartno as their NHA parent
      const childrenOfChild = bomItems.filter(
        item => item.cfg_set_id === configId && item.nha_partno_c === childPartno
      );

      for (const child of childrenOfChild) {
        // If any of childPartno's children is the potentialParent, we have a circular reference
        if (child.partno_c === potentialParentPartno) {
          return true;
        }
        // Recursively check deeper levels
        if (checkCircularReference(child.partno_c, potentialParentPartno, visited)) {
          return true;
        }
      }

      return false;
    };

    // Check if the new part (partno_c) has any existing children that include the proposed parent
    // This handles the case where we're adding a new part with a parent, and the new part
    // would already have children that reference the parent (creating A -> B -> A)
    // Also check if the proposed parent has the new part as an ancestor
    const existingChildrenOfNewPart = bomItems.filter(
      item => item.cfg_set_id === configId && item.nha_partno_c === partno_c.trim()
    );

    // Check if nha_partno_c appears anywhere in the descendants of partno_c
    if (existingChildrenOfNewPart.length > 0) {
      // New part already exists and has children - check for circular ref
      if (checkCircularReference(partno_c.trim(), nha_partno_c.trim())) {
        return res.status(400).json({
          error: `Circular reference detected: Cannot set "${nha_partno_c.trim()}" as parent of "${partno_c.trim()}" because it would create a circular dependency in the assembly hierarchy.`,
          validation_type: 'circular_reference'
        });
      }
    }

    // Also check the reverse - if the proposed parent already has this part as an ancestor
    const checkAncestors = (partno: string, targetAncestor: string, visited: Set<string> = new Set()): boolean => {
      if (visited.has(partno)) return false;
      visited.add(partno);

      const item = bomItems.find(b => b.cfg_set_id === configId && b.partno_c === partno);
      if (!item || !item.nha_partno_c) return false;

      if (item.nha_partno_c === targetAncestor) return true;

      return checkAncestors(item.nha_partno_c, targetAncestor, visited);
    };

    // Check if nha_partno_c already has partno_c as an ancestor (would mean partno_c -> ... -> nha_partno_c -> partno_c)
    if (checkAncestors(nha_partno_c.trim(), partno_c.trim())) {
      return res.status(400).json({
        error: `Circular reference detected: "${partno_c.trim()}" is already an ancestor of "${nha_partno_c.trim()}" in the assembly hierarchy. Setting this parent relationship would create a circular dependency.`,
        validation_type: 'circular_reference'
      });
    }

    validatedNhaPartno = nha_partno_c.trim();
  }

  // Check for duplicate part in this configuration
  const existingItem = bomItems.find(
    item => item.cfg_set_id === configId && item.partno_c === partno_c.trim()
  );
  if (existingItem) {
    return res.status(400).json({ error: 'This part is already in the BOM for this configuration' });
  }

  // Generate new list_id
  const newListId = Math.max(...bomItems.map(b => b.list_id), 0) + 1;

  // Create new BOM item
  const newBomItem: BOMItem = {
    list_id: newListId,
    cfg_set_id: configId,
    partno_p: config.partno || config.cfg_name,
    partno_c: partno_c.trim(),
    part_name_c: part_name_c.trim(),
    sort_order: sortOrderValue,
    qpa: qpaValue,
    active: true,
    nha_partno_c: validatedNhaPartno,
    is_sra: validatedNhaPartno !== null,
  };

  // Add to bomItems array
  bomItems.push(newBomItem);

  // Update configuration bom_item_count
  config.bom_item_count = bomItems.filter(b => b.cfg_set_id === configId).length;

  console.log(`[BOM] Added part "${partno_c}" to config "${config.cfg_name}" (ID: ${configId}) by ${user.username}`);

  res.status(201).json({
    message: 'Part added to BOM successfully',
    bom_item: newBomItem,
    bom_item_count: config.bom_item_count,
  });
});

// PUT /api/configurations/:id/bom/:itemId - Update a BOM item (including NHA relationship)
app.put('/api/configurations/:id/bom/:itemId', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can update BOM items
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to modify BOM' });
  }

  const configId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);

  if (isNaN(configId) || isNaN(itemId)) {
    return res.status(400).json({ error: 'Invalid configuration ID or item ID' });
  }

  // Find the configuration
  const config = configurations.find(c => c.cfg_set_id === configId);
  if (!config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  // Check if user has access to this program
  const userProgramIds = user.programs.map(p => p.pgm_id);
  if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this configuration' });
  }

  // Find the BOM item
  const bomItem = bomItems.find(item => item.list_id === itemId && item.cfg_set_id === configId);
  if (!bomItem) {
    return res.status(404).json({ error: 'BOM item not found' });
  }

  // Extract updatable fields from request body
  const { nha_partno_c, qpa, sort_order } = req.body;

  // Update NHA relationship if provided
  if (nha_partno_c !== undefined) {
    if (nha_partno_c === null || nha_partno_c === '') {
      // Clear NHA relationship
      bomItem.nha_partno_c = null;
      bomItem.is_sra = false;
    } else {
      // Check if the NHA parent exists in this configuration's BOM
      const nhaParent = bomItems.find(
        item => item.cfg_set_id === configId && item.partno_c === nha_partno_c.trim() && item.list_id !== itemId
      );
      if (!nhaParent) {
        return res.status(400).json({ error: 'NHA parent part not found in this configuration\'s BOM' });
      }
      // Prevent circular references - check if the proposed parent is already a child of this item
      const isCircular = bomItems.some(
        item => item.cfg_set_id === configId && item.nha_partno_c === bomItem.partno_c && item.partno_c === nha_partno_c.trim()
      );
      if (isCircular) {
        return res.status(400).json({ error: 'Cannot set NHA parent: would create circular reference' });
      }
      bomItem.nha_partno_c = nha_partno_c.trim();
      bomItem.is_sra = true;
    }
  }

  // Update QPA if provided
  if (qpa !== undefined) {
    const qpaValue = parseInt(qpa, 10);
    if (isNaN(qpaValue) || qpaValue < 1) {
      return res.status(400).json({ error: 'Quantity per assembly must be at least 1' });
    }
    bomItem.qpa = qpaValue;
  }

  // Update sort order if provided
  if (sort_order !== undefined) {
    const sortOrderValue = parseInt(sort_order, 10);
    if (!isNaN(sortOrderValue) && sortOrderValue >= 1) {
      bomItem.sort_order = sortOrderValue;
    }
  }

  console.log(`[BOM] Updated item ${itemId} in config "${config.cfg_name}" (ID: ${configId}) by ${user.username}`);

  res.json({
    message: 'BOM item updated successfully',
    bom_item: bomItem,
  });
});

// DELETE /api/configurations/:id/bom/:itemId - Remove a part from configuration BOM
app.delete('/api/configurations/:id/bom/:itemId', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check authorization - only admin and depot_manager can remove BOM items
  if (!['ADMIN', 'DEPOT_MANAGER'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to modify BOM' });
  }

  const configId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);

  if (isNaN(configId) || isNaN(itemId)) {
    return res.status(400).json({ error: 'Invalid configuration ID or item ID' });
  }

  try {
    // Find the configuration
    const config = await prisma.cfgSet.findUnique({
      where: { cfg_set_id: configId },
      include: { program: true },
    });

    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Check if user has access to this program
    const userProgramIds = user.programs.map(p => p.pgm_id);
    if (!userProgramIds.includes(config.pgm_id) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied to this configuration' });
    }

    // Find the BOM item
    const bomItem = await prisma.cfgList.findUnique({
      where: { list_id: itemId },
      include: {
        childPart: {
          select: { partno: true, noun: true },
        },
      },
    });

    if (!bomItem || bomItem.cfg_set_id !== configId) {
      return res.status(404).json({ error: 'BOM item not found' });
    }

    // Remove the item
    await prisma.cfgList.delete({
      where: { list_id: itemId },
    });

    // Get updated BOM count
    const bomCount = await prisma.cfgList.count({
      where: { cfg_set_id: configId },
    });

    console.log(`[BOM] Removed part "${bomItem.childPart?.partno || bomItem.partno_c}" from config "${config.cfg_name}" (ID: ${configId}) by ${user.username}`);

    res.json({
      message: 'Part removed from BOM successfully',
      removed_item: {
        list_id: bomItem.list_id,
        cfg_set_id: bomItem.cfg_set_id,
        partno_c: bomItem.childPart?.partno || bomItem.partno_c,
        part_name_c: bomItem.childPart?.noun || bomItem.part_name_c,
        sort_order: bomItem.sort_order,
        qpa: bomItem.qpa,
      },
      bom_item_count: bomCount,
    });
  } catch (error) {
    console.error('[BOM] Error removing BOM item:', error);
    res.status(500).json({ error: 'Failed to remove part from BOM' });
  }
});

// ============================================
// SORTIE ENDPOINTS
// ============================================

// List sorties (requires authentication)
// GET /api/sorties - List sorties for a program - REAL DATABASE
app.get('/api/sorties', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const userProgramIds = user.programs.map(p => p.pgm_id);
    const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;
    const searchQuery = req.query.search ? String(req.query.search).toLowerCase().trim() : null;
    const startDate = req.query.start_date ? String(req.query.start_date) : null;
    const endDate = req.query.end_date ? String(req.query.end_date) : null;
    const tailNumber = req.query.tail_number ? String(req.query.tail_number).toLowerCase() : null;
    const sortieEffect = req.query.sortie_effect ? String(req.query.sortie_effect) : null;

    // Build Prisma where clause
    const where: any = {
      pgm_id: { in: userProgramIds },
    };

    if (programIdFilter && userProgramIds.includes(programIdFilter)) {
      where.pgm_id = programIdFilter;
    }

    if (searchQuery) {
      where.OR = [
        { mission_id: { contains: searchQuery, mode: 'insensitive' } },
        { serno: { contains: searchQuery, mode: 'insensitive' } },
        { ac_tailno: { contains: searchQuery, mode: 'insensitive' } },
      ];
    }

    if (startDate || endDate) {
      where.sortie_date = {};
      if (startDate) where.sortie_date.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999);
        where.sortie_date.lte = end;
      }
    }

    if (tailNumber) {
      where.ac_tailno = { contains: tailNumber, mode: 'insensitive' };
    }

    if (sortieEffect) {
      where.sortie_effect = sortieEffect;
    }

    const [dbSorties, total] = await Promise.all([
      prisma.sortie.findMany({
        where,
        include: {
          asset: { include: { part: true } },
          program: true,
        },
        orderBy: { sortie_date: 'desc' },
        take: 200,
      }),
      prisma.sortie.count({ where }),
    ]);

    // Map to V1 response shape
    const sorties = dbSorties.map(s => ({
      sortie_id: s.sortie_id,
      pgm_id: s.pgm_id,
      asset_id: s.asset_id,
      mission_id: s.mission_id || `SRT-${s.sortie_id}`,
      serno: s.serno || s.asset?.serno || '',
      ac_tailno: s.ac_tailno || null,
      sortie_date: s.sortie_date?.toISOString() || new Date().toISOString(),
      sortie_effect: s.sortie_effect || null,
      current_unit: s.current_unit || null,
      assigned_unit: s.assigned_unit || null,
      range: s.range || null,
      reason: s.reason || null,
      remarks: s.remarks || null,
      ac_type: s.ac_type || null,
      ac_station: s.ac_station || null,
      is_non_podded: s.is_non_podded,
      is_debrief: s.is_debrief,
      is_live_monitor: s.is_live_monitor,
      valid: s.valid,
      val_by: s.val_by,
      val_date: s.val_date?.toISOString() || null,
    }));

    console.log(`[SORTIES] DB query by ${user.username} - Total: ${total}`);
    res.json({ sorties, total });
  } catch (error: any) {
    console.error('[SORTIES] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sorties/pending-review - must be before :id route
app.get('/api/sorties/pending-review', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  try {
    const userProgramIds = user.programs.map(p => p.pgm_id);
    const programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

    const where: any = {
      pgm_id: programIdFilter && userProgramIds.includes(programIdFilter) ? programIdFilter : { in: userProgramIds },
      valid: false,
      OR: [
        { adjudication_status: null },
        { adjudication_status: 'PENDING' },
      ],
    };

    const [dbSorties, total] = await Promise.all([
      prisma.sortie.findMany({
        where,
        include: { asset: { include: { part: true } }, program: true },
        orderBy: { ins_date: 'desc' },
        take: 200,
      }),
      prisma.sortie.count({ where }),
    ]);

    const sorties = dbSorties.map(s => ({
      sortie_id: s.sortie_id,
      pgm_id: s.pgm_id,
      asset_id: s.asset_id,
      mission_id: s.mission_id || `SRT-${s.sortie_id}`,
      serno: s.serno || s.asset?.serno || '',
      ac_tailno: s.ac_tailno || null,
      sortie_date: s.sortie_date?.toISOString() || new Date().toISOString(),
      sortie_effect: s.sortie_effect || null,
      current_unit: s.current_unit || null,
      range: s.range || null,
      remarks: s.remarks || null,
      ac_category: (s as any).ac_category || null,
      adjudication_status: (s as any).adjudication_status || null,
      valid: s.valid,
      is_non_podded: s.is_non_podded,
    }));

    res.json({ sorties, total });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single sortie by ID - REAL DATABASE
app.get('/api/sorties/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  try {
    const sortieId = parseInt(req.params.id);
    const sortie = await prisma.sortie.findUnique({
      where: { sortie_id: sortieId },
      include: {
        asset: { include: { part: true, currentLocation: true, assignedLocation: true } },
        program: true,
        events: { include: { repairs: true } },
      },
    });

    if (!sortie) {
      return res.status(404).json({ error: 'Sortie not found' });
    }

    res.json({
      sortie_id: sortie.sortie_id,
      pgm_id: sortie.pgm_id,
      asset_id: sortie.asset_id,
      mission_id: sortie.mission_id || `SRT-${sortie.sortie_id}`,
      serno: sortie.serno || sortie.asset?.serno || '',
      ac_tailno: sortie.ac_tailno || null,
      sortie_date: sortie.sortie_date?.toISOString() || new Date().toISOString(),
      sortie_effect: sortie.sortie_effect || null,
      current_unit: sortie.current_unit || null,
      assigned_unit: sortie.assigned_unit || null,
      range: sortie.range || null,
      reason: sortie.reason || null,
      remarks: sortie.remarks || null,
      ac_type: sortie.ac_type || null,
      ac_station: sortie.ac_station || null,
      is_non_podded: sortie.is_non_podded,
      is_debrief: sortie.is_debrief,
      is_live_monitor: sortie.is_live_monitor,
      valid: sortie.valid,
      val_by: sortie.val_by,
      val_date: sortie.val_date?.toISOString() || null,
      asset: sortie.asset,
      program: sortie.program,
      events: sortie.events,
    });
  } catch (error: any) {
    console.error('[SORTIES] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Create new sortie - REAL DATABASE
app.post('/api/sorties', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const { asset_id, mission_id, sortie_date, sortie_effect, range, remarks, ac_tailno, ac_type, ac_station, current_unit, assigned_unit, reason, is_non_podded, is_debrief, is_live_monitor, serno } = req.body;

    // Find the asset to get program info
    let assetId = asset_id ? parseInt(asset_id) : null;
    let pgmId = user.programs[0]?.pgm_id || 1;
    let assetSerno = serno || '';

    if (assetId) {
      const asset = await prisma.asset.findUnique({
        where: { asset_id: assetId },
        include: { part: true },
      });
      if (asset) {
        pgmId = asset.part?.pgm_id || pgmId;
        assetSerno = asset.serno || assetSerno;
      }
    } else if (serno) {
      // Try to find asset by serial number
      const asset = await prisma.asset.findFirst({
        where: { serno, active: true },
        include: { part: true },
      });
      if (asset) {
        assetId = asset.asset_id;
        pgmId = asset.part?.pgm_id || pgmId;
        assetSerno = asset.serno || assetSerno;
      }
    }

    const sortie = await prisma.sortie.create({
      data: {
        pgm_id: pgmId,
        asset_id: assetId,
        mission_id: mission_id || null,
        serno: assetSerno,
        ac_tailno: ac_tailno || null,
        sortie_date: sortie_date ? new Date(sortie_date + 'T12:00:00Z') : new Date(),
        sortie_effect: sortie_effect || null,
        ac_station: ac_station || null,
        ac_type: ac_type || null,
        current_unit: current_unit || null,
        assigned_unit: assigned_unit || null,
        range: range || null,
        reason: reason || null,
        remarks: remarks || null,
        is_non_podded: is_non_podded === true,
        is_debrief: is_debrief === true,
        is_live_monitor: is_live_monitor === true,
        valid: false,
        ins_by: user.username,
        ins_date: new Date(),
      },
    });

    console.log(`[SORTIES] Created sortie ${sortie.sortie_id} by ${user.username}`);

    res.status(201).json({
      message: 'Sortie created',
      sortie: {
        sortie_id: sortie.sortie_id,
        pgm_id: sortie.pgm_id,
        asset_id: sortie.asset_id,
        mission_id: sortie.mission_id,
        serno: sortie.serno,
        ac_tailno: sortie.ac_tailno,
        sortie_date: sortie.sortie_date?.toISOString(),
        sortie_effect: sortie.sortie_effect,
        current_unit: sortie.current_unit,
        assigned_unit: sortie.assigned_unit,
        range: sortie.range,
        reason: sortie.reason,
        remarks: sortie.remarks,
      },
    });
  } catch (error: any) {
    console.error('[SORTIES] Create error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Update sortie - REAL DATABASE
app.put('/api/sorties/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const sortieId = parseInt(req.params.id);
    const { mission_id, sortie_date, sortie_effect, range, remarks, ac_tailno, ac_type, ac_station, current_unit, assigned_unit, reason, is_non_podded, is_debrief, is_live_monitor } = req.body;

    const sortie = await prisma.sortie.update({
      where: { sortie_id: sortieId },
      data: {
        ...(mission_id !== undefined && { mission_id }),
        ...(sortie_date !== undefined && { sortie_date: new Date(sortie_date + 'T12:00:00Z') }),
        ...(sortie_effect !== undefined && { sortie_effect }),
        ...(range !== undefined && { range }),
        ...(remarks !== undefined && { remarks }),
        ...(ac_tailno !== undefined && { ac_tailno }),
        ...(ac_type !== undefined && { ac_type }),
        ...(ac_station !== undefined && { ac_station }),
        ...(current_unit !== undefined && { current_unit }),
        ...(assigned_unit !== undefined && { assigned_unit }),
        ...(reason !== undefined && { reason }),
        ...(is_non_podded !== undefined && { is_non_podded }),
        ...(is_debrief !== undefined && { is_debrief }),
        ...(is_live_monitor !== undefined && { is_live_monitor }),
        chg_by: user.username,
        chg_date: new Date(),
      },
    });

    console.log(`[SORTIES] Updated sortie ${sortieId} by ${user.username}`);

    res.json({
      message: 'Sortie updated',
      sortie: {
        sortie_id: sortie.sortie_id,
        pgm_id: sortie.pgm_id,
        asset_id: sortie.asset_id,
        mission_id: sortie.mission_id,
        serno: sortie.serno,
        ac_tailno: sortie.ac_tailno,
        sortie_date: sortie.sortie_date?.toISOString(),
        sortie_effect: sortie.sortie_effect,
        current_unit: sortie.current_unit,
        assigned_unit: sortie.assigned_unit,
        range: sortie.range,
        reason: sortie.reason,
        remarks: sortie.remarks,
      },
    });
  } catch (error: any) {
    console.error('[SORTIES] Update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete sortie - REAL DATABASE
app.delete('/api/sorties/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (!['DEPOT_MANAGER', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    const sortieId = parseInt(req.params.id);

    // Check for linked events
    const linkedEvents = await prisma.event.count({ where: { sortie_id: sortieId } });
    if (linkedEvents > 0) {
      return res.status(400).json({ error: `Cannot delete sortie - linked to ${linkedEvents} maintenance event(s)` });
    }

    await prisma.sortie.delete({ where: { sortie_id: sortieId } });
    console.log(`[SORTIES] Deleted sortie ${sortieId} by ${user.username}`);
    res.json({ message: 'Sortie deleted' });
  } catch (error: any) {
    console.error('[SORTIES] Delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Bulk import sorties - REAL DATABASE
app.post('/api/sorties/bulk-import', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (!['DEPOT_MANAGER', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to bulk import sorties' });
  }

  const { sorties: importSorties, duplicateAction } = req.body;

  if (!importSorties || !Array.isArray(importSorties) || importSorties.length === 0) {
    return res.status(400).json({ error: 'Invalid import data: sorties array is required' });
  }

  try {
    const errors: string[] = [];
    const duplicates: any[] = [];
    const created: any[] = [];
    const updated: any[] = [];
    const skipped: string[] = [];
    const userProgramIds = user.programs.map(p => p.pgm_id);

    for (let index = 0; index < importSorties.length; index++) {
      const sortieData = importSorties[index];
      const rowNum = index + 2;

      // Validate required fields
      if (!sortieData.serno || !sortieData.mission_id || !sortieData.sortie_date) {
        errors.push(`Row ${rowNum}: Missing required fields (serno, mission_id, or sortie_date)`);
        continue;
      }

      // Validate date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(sortieData.sortie_date)) {
        errors.push(`Row ${rowNum}: Invalid date format for '${sortieData.sortie_date}' (use YYYY-MM-DD)`);
        continue;
      }

      // Find asset by serial number in DB (coerce to string for numeric-only sernos from Excel)
      const sernoStr = String(sortieData.serno).trim();
      const asset = await prisma.asset.findFirst({
        where: { serno: sernoStr, active: true },
        include: { part: true },
      });

      if (!asset) {
        errors.push(`Row ${rowNum}: Asset with serial number '${sortieData.serno}' not found`);
        continue;
      }

      const pgmId = asset.part?.pgm_id || 1;
      if (!userProgramIds.includes(pgmId)) {
        errors.push(`Row ${rowNum}: Access denied to asset '${sortieData.serno}' (program mismatch)`);
        continue;
      }

      // Check for duplicate mission_id in DB
      const missionId = sortieData.mission_id.trim();
      const existingSortie = await prisma.sortie.findFirst({
        where: {
          mission_id: { equals: missionId, mode: 'insensitive' },
          pgm_id: { in: userProgramIds },
        },
      });

      if (existingSortie) {
        duplicates.push({
          row: rowNum,
          mission_id: missionId,
          serno: sortieData.serno,
          sortie_date: sortieData.sortie_date,
          existing: {
            mission_id: existingSortie.mission_id,
            serno: existingSortie.serno,
            sortie_date: existingSortie.sortie_date?.toISOString().split('T')[0],
            sortie_effect: existingSortie.sortie_effect,
            range: existingSortie.range,
          },
          new: {
            mission_id: missionId,
            serno: sortieData.serno,
            sortie_date: sortieData.sortie_date,
            sortie_effect: sortieData.sortie_effect || null,
            range: sortieData.range || null,
          },
        });

        if (!duplicateAction) {
          continue;
        } else if (duplicateAction === 'skip') {
          skipped.push(`Row ${rowNum}: Skipped duplicate mission ID '${missionId}'`);
          continue;
        } else if (duplicateAction === 'update') {
          const updatedSortie = await prisma.sortie.update({
            where: { sortie_id: existingSortie.sortie_id },
            data: {
              sortie_date: new Date(sortieData.sortie_date + 'T12:00:00Z'),
              sortie_effect: sortieData.sortie_effect || existingSortie.sortie_effect,
              range: sortieData.range || existingSortie.range,
              remarks: sortieData.remarks || existingSortie.remarks,
              chg_by: user.username,
              chg_date: new Date(),
            },
          });
          updated.push(updatedSortie);
          continue;
        }
        // 'create' falls through to create below
      }

      // Create new sortie in DB
      const newSortie = await prisma.sortie.create({
        data: {
          pgm_id: pgmId,
          asset_id: asset.asset_id,
          mission_id: missionId,
          serno: asset.serno || sortieData.serno,
          ac_tailno: sortieData.ac_tailno || null,
          sortie_date: new Date(sortieData.sortie_date + 'T12:00:00Z'),
          sortie_effect: sortieData.sortie_effect || null,
          range: sortieData.range || null,
          remarks: sortieData.remarks || null,
          current_unit: null,
          assigned_unit: null,
          is_non_podded: false,
          is_debrief: false,
          is_live_monitor: false,
          valid: false,
          ins_by: user.username,
          ins_date: new Date(),
        },
      });
      created.push(newSortie);
    }

    // If there are duplicates and no action specified, return duplicate info
    if (duplicates.length > 0 && !duplicateAction) {
      return res.status(409).json({
        error: 'Duplicate mission IDs found',
        duplicates,
        message: 'Please review duplicates and choose an action: skip, update, or create',
      });
    }

    // If there are validation errors, don't import anything
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        errors,
        imported: 0,
      });
    }

    console.log(`[SORTIES] Bulk imported ${created.length} sortie(s), updated ${updated.length}, skipped ${skipped.length} by ${user.username}`);

    res.status(201).json({
      message: 'Sorties imported successfully',
      imported: created.length,
      updated: updated.length,
      skipped: skipped.length,
      warnings: skipped,
    });
  } catch (error: any) {
    console.error('[SORTIES] Bulk import error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sorties/:id/validate - Validate/approve a sortie - REAL DATABASE
app.post('/api/sorties/:id/validate', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  if (!['DEPOT_MANAGER', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    const sortieId = parseInt(req.params.id);
    const sortie = await prisma.sortie.update({
      where: { sortie_id: sortieId },
      data: {
        valid: true,
        val_by: user.username,
        val_date: new Date(),
        adjudication_status: 'APPROVED',
        adjudication_by: user.username,
        adjudication_date: new Date(),
        chg_by: user.username,
        chg_date: new Date(),
      },
    });
    console.log(`[SORTIES] Validated sortie ${sortieId} by ${user.username}`);
    res.json({ message: 'Sortie validated', sortie });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sorties/:id/adjudicate - Adjudicate a sortie (flag/reject/approve) - REAL DATABASE
app.post('/api/sorties/:id/adjudicate', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  if (!['DEPOT_MANAGER', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    const sortieId = parseInt(req.params.id);
    const { status, notes } = req.body;

    if (!['APPROVED', 'FLAGGED', 'REJECTED', 'DUPLICATE'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use: APPROVED, FLAGGED, REJECTED, DUPLICATE' });
    }

    const sortie = await prisma.sortie.update({
      where: { sortie_id: sortieId },
      data: {
        adjudication_status: status,
        adjudication_notes: notes || null,
        adjudication_by: user.username,
        adjudication_date: new Date(),
        valid: status === 'APPROVED',
        val_by: status === 'APPROVED' ? user.username : null,
        val_date: status === 'APPROVED' ? new Date() : null,
        chg_by: user.username,
        chg_date: new Date(),
      },
    });
    console.log(`[SORTIES] Adjudicated sortie ${sortieId} as ${status} by ${user.username}`);
    res.json({ message: `Sortie ${status.toLowerCase()}`, sortie });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/spares - List spare parts inventory (assets) for a program - REAL DATABASE
app.get('/api/spares', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get program filter from query string (required or use default)
  let programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  // If no program specified, use user's default program
  if (!programIdFilter) {
    const defaultProgram = user.programs.find(p => p.is_default);
    programIdFilter = defaultProgram?.pgm_id || user.programs[0]?.pgm_id || 1;
  }

  // Check if user has access to this program
  if (!userProgramIds.includes(programIdFilter) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this program' });
  }

  try {
    // Get pagination params
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 25, 100);
    const offset = (page - 1) * limit;

    // Build where clause - spares are assets belonging to the program via part.pgm_id
    const whereClause: Prisma.AssetWhereInput = {
      active: req.query.show_deleted === 'true' ? false : true,
      part: {
        pgm_id: programIdFilter,
      },
    };

    // Apply location filter if specified
    const locationIdFilter = req.query.location_id ? parseInt(req.query.location_id as string, 10) : null;
    if (locationIdFilter) {
      whereClause.OR = [
        { loc_ida: locationIdFilter },
        { loc_idc: locationIdFilter },
      ];
    }

    // Apply status filter
    const statusFilter = req.query.status as string;
    if (statusFilter) {
      whereClause.status_cd = statusFilter;
    }

    // Apply search filter
    const searchQuery = (req.query.search as string)?.trim() || null;
    if (searchQuery) {
      whereClause.OR = [
        { serno: { contains: searchQuery, mode: 'insensitive' } },
        { part: { partno: { contains: searchQuery, mode: 'insensitive' } } },
        { part: { noun: { contains: searchQuery, mode: 'insensitive' } } },
      ];
    }

    // Get total count
    const total = await prisma.asset.count({ where: whereClause });

    // Build orderBy
    const sortBy = (req.query.sort_by as string) || 'serno';
    const sortOrder = (req.query.sort_order as string) === 'desc' ? 'desc' : 'asc';
    let orderBy: any = { serno: sortOrder };
    if (sortBy === 'partno') orderBy = { part: { partno: sortOrder } };
    else if (sortBy === 'status_cd') orderBy = { status_cd: sortOrder };

    // Query real assets from database
    const assets = await prisma.asset.findMany({
      where: whereClause,
      include: {
        part: true,
        assignedLocation: true,
        currentLocation: true,
      },
      orderBy,
      skip: offset,
      take: limit,
    });

    // Transform to expected format
    const spares = assets.map(asset => ({
      asset_id: asset.asset_id,
      serno: asset.serno || '',
      partno: asset.part?.partno || '',
      part_name: asset.part?.noun || '',
      nsn: asset.part?.nsn || '',
      status_cd: asset.status_cd || 'FMC',
      loc_ida: asset.loc_ida,
      loc_idc: asset.loc_idc,
      location: asset.currentLocation?.display_name || asset.assignedLocation?.display_name || 'Unknown',
      assigned_location: asset.assignedLocation?.display_name || '',
      current_location: asset.currentLocation?.display_name || '',
      active: asset.active,
      pgm_id: asset.part?.pgm_id || programIdFilter,
    }));

    // Get program info
    const program = await prisma.program.findUnique({ where: { pgm_id: programIdFilter } });

    console.log(`[SPARES] List request by ${user.username} - Program: ${program?.pgm_cd}, Total: ${total}, Page: ${page}`);

    res.json({
      spares,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
      program: {
        pgm_id: programIdFilter,
        pgm_cd: program?.pgm_cd || 'UNKNOWN',
        pgm_name: program?.pgm_name || 'Unknown Program',
      },
    });
  } catch (error) {
    console.error('[SPARES] Error fetching spares:', error);
    res.status(500).json({ error: 'Failed to fetch spares' });
  }
});

// POST /api/spares - Create a new spare part record
app.post('/api/spares', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions (depot_manager or admin can create spares)
  if (user.role !== 'DEPOT_MANAGER' && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const { partno, serno, status, loc_id, warranty_exp, mfg_date, unit_price, remarks, pgm_id } = req.body;

  // Validation
  if (!partno || !serno) {
    return res.status(400).json({ error: 'Part number and serial number are required' });
  }

  // Use user's current program if not specified
  const programId = pgm_id || user.programs.find(p => p.is_default)?.pgm_id || user.programs[0]?.pgm_id;

  // Check if spare with same partno+serno already exists in mock data
  const existingAsset = mockAssets.find(a => a.partno === partno && a.serno === serno && a.active);
  const existingDetailed = detailedAssets.find(a => a.partno === partno && a.serno === serno && a.active);

  if (existingAsset || existingDetailed) {
    return res.status(409).json({ error: 'A spare with this part number and serial number already exists' });
  }

  // Generate new asset ID
  const newAssetId = Math.max(...mockAssets.map(a => a.asset_id), ...detailedAssets.map(a => a.asset_id)) + 1;

  // Get location details
  const location = assignedLocationations.find(l => l.loc_id === parseInt(loc_id || '0'));
  const program = allPrograms.find(p => p.pgm_id === programId);

  // Create new asset in mockAssets
  const newAsset = {
    asset_id: newAssetId,
    partno,
    serno,
    status_cd: status || 'FMC',
    loc_ida: loc_id ? parseInt(loc_id) : null,
    loc_idc: loc_id ? parseInt(loc_id) : null,
    admin_loc: location?.loc_cd || null,
    cust_loc: location?.loc_cd || null,
    active: true,
    valid: false,
    bad_actor: false,
    remarks: remarks || null,
    ins_by: user.username,
    ins_date: new Date().toISOString(),
    chg_by: null,
    chg_date: null,
  };

  // Create detailed asset record
  const newDetailedAsset = {
    asset_id: newAssetId,
    partno,
    serno,
    part_name: `Spare Part ${partno}`,
    pgm_id: programId,
    pgm_cd: program?.pgm_cd || 'UNKNOWN',
    pgm_name: program?.pgm_name || 'Unknown Program',
    status_cd: status || 'FMC',
    status_name: status === 'PMC' ? 'Partially Mission Capable' : status === 'NMCM' ? 'Not Mission Capable Maintenance' : status === 'NMCS' ? 'Not Mission Capable Supply' : status === 'CNDM' ? 'Condemned' : 'Fully Mission Capable',
    active: true,
    location: location?.display_name || 'No Location',
    loc_type: 'depot' as 'depot' | 'field',
    admin_loc: location?.loc_cd || '',
    cust_loc: location?.loc_cd || '',
    notes: remarks || null,
    in_transit: false,
    bad_actor: false,
    uii: null,
    mfg_date: mfg_date || null,
    remarks: remarks || null,
  };

  // Create in DB
  try {
    const partRecord = await prisma.partList.findFirst({ where: { partno, pgm_id: programId } });
    if (partRecord) {
      const dbAsset = await prisma.asset.create({
        data: {
          partno_id: partRecord.partno_id,
          serno,
          status_cd: status || 'FMC',
          loc_ida: loc_id ? parseInt(loc_id) : null,
          loc_idc: loc_id ? parseInt(loc_id) : null,
          active: true,
          remarks: remarks || null,
          ins_by: user.username,
        },
      });
      newAssetId = dbAsset.asset_id;
      newAsset.asset_id = newAssetId;
      newDetailedAsset.asset_id = newAssetId;
    }
  } catch (dbError) {
    console.error('[SPARES] DB create failed, using in-memory ID:', dbError);
  }

  // Add to in-memory arrays
  mockAssets.push(newAsset);
  detailedAssets.push(newDetailedAsset);
  await refreshAssetInMemory(newAssetId).catch(() => {});

  console.log(`[SPARES] Created spare ${newAssetId} (${partno}/${serno}) by ${user.username}`);

  res.status(201).json({
    spare_id: newAssetId,
    asset_id: newAssetId,
    partno,
    serno,
    status: status || 'AVAILABLE',
    location: location?.display_name || 'No Location',
    loc_id: loc_id ? parseInt(loc_id) : null,
    warranty_exp: warranty_exp || null,
    mfg_date: mfg_date || null,
    unit_price: unit_price ? parseFloat(unit_price) : null,
    remarks: remarks || null,
    pgm_id: programId,
    active: true,
    ins_date: new Date().toISOString(),
  });
});

// PUT /api/spares/:id - Update a spare part record
app.put('/api/spares/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions
  if (user.role !== 'DEPOT_MANAGER' && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    const spareId = parseInt(req.params.id, 10);
    const { partno, serno, status, loc_id, warranty_exp, mfg_date, unit_price, remarks } = req.body;

    // Check if spare exists
    const spare = await prisma.spare.findUnique({
      where: { spare_id: spareId },
    });

    if (!spare) {
      return res.status(404).json({ error: 'Spare not found' });
    }

    // Update spare
    const updatedSpare = await prisma.spare.update({
      where: { spare_id: spareId },
      data: {
        partno: partno || spare.partno,
        serno: serno || spare.serno,
        status: status || spare.status,
        loc_id: loc_id !== undefined ? (loc_id ? parseInt(loc_id) : null) : spare.loc_id,
        warranty_exp: warranty_exp !== undefined ? (warranty_exp ? new Date(warranty_exp) : null) : spare.warranty_exp,
        mfg_date: mfg_date !== undefined ? (mfg_date ? new Date(mfg_date) : null) : spare.mfg_date,
        unit_price: unit_price !== undefined ? (unit_price ? parseFloat(unit_price) : null) : spare.unit_price,
        remarks: remarks !== undefined ? remarks : spare.remarks,
        chg_by: user.username,
        chg_date: new Date(),
      },
      include: {
        program: true,
        location: true,
      },
    });

    console.log(`[SPARES] Updated spare ${updatedSpare.spare_id} by ${user.username}`);

    res.json({
      spare_id: updatedSpare.spare_id,
      partno: updatedSpare.partno,
      serno: updatedSpare.serno,
      status: updatedSpare.status,
      location: updatedSpare.location?.display_name || 'No Location',
      loc_id: updatedSpare.loc_id,
      warranty_exp: updatedSpare.warranty_exp?.toISOString() || null,
      mfg_date: updatedSpare.mfg_date?.toISOString() || null,
      unit_price: updatedSpare.unit_price ? parseFloat(updatedSpare.unit_price.toString()) : null,
      remarks: updatedSpare.remarks,
      pgm_id: updatedSpare.pgm_id,
      active: updatedSpare.active,
      ins_date: updatedSpare.ins_date.toISOString(),
    });
  } catch (error) {
    console.error('[SPARES] Error updating spare:', error);
    res.status(500).json({ error: 'Failed to update spare' });
  }
});

// DELETE /api/spares/:id - Delete (soft) a spare part record
app.delete('/api/spares/:id', async (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Check role permissions
  if (user.role !== 'DEPOT_MANAGER' && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    const spareId = parseInt(req.params.id, 10);

    // Check if spare exists
    const spare = await prisma.spare.findUnique({
      where: { spare_id: spareId },
    });

    if (!spare) {
      return res.status(404).json({ error: 'Spare not found' });
    }

    // Hard delete - actually remove from database
    await prisma.spare.delete({
      where: { spare_id: spareId },
    });

    console.log(`[SPARES] PERMANENTLY deleted spare ${spareId} by ${user.username}`);

    res.json({ message: 'Spare deleted successfully' });
  } catch (error) {
    console.error('[SPARES] Error deleting spare:', error);
    res.status(500).json({ error: 'Failed to delete spare' });
  }
});

// GET /api/reports/inventory - Inventory report grouped by system type
app.get('/api/reports/inventory', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Get user's program IDs
  const userProgramIds = user.programs.map(p => p.pgm_id);

  // Get program filter from query string or use user's default
  let programIdFilter = req.query.program_id ? parseInt(req.query.program_id as string, 10) : null;

  if (!programIdFilter) {
    const defaultProgram = user.programs.find(p => p.is_default);
    programIdFilter = defaultProgram?.pgm_id || user.programs[0]?.pgm_id || 1;
  }

  // Check if user has access to this program
  if (!userProgramIds.includes(programIdFilter) && user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access denied to this program' });
  }

  // Get user's location IDs for filtering
  const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];

  // Get all assets for the program (both in config and spares)
  let allAssets = detailedAssets.filter(asset =>
    asset.pgm_id === programIdFilter &&
    asset.active === true
  );

  // Apply location filtering for non-admin users
  // Assets are filtered if they match ANY of the user's assigned locations (loc_ida OR loc_idc)
  if (user.role !== 'ADMIN' && userLocationIds.length > 0) {
    allAssets = allAssets.filter(asset =>
      userLocationIds.includes(asset.loc_ida) || userLocationIds.includes(asset.loc_idc)
    );
  }

  // Helper function to extract system type from part name
  const extractSystemType = (partName: string): string => {
    const nameLower = partName.toLowerCase();

    // Match common system types
    if (nameLower.includes('sensor')) return 'Sensor Systems';
    if (nameLower.includes('camera') || nameLower.includes('optical')) return 'Camera/Optical Systems';
    if (nameLower.includes('radar')) return 'Radar Systems';
    if (nameLower.includes('communication') || nameLower.includes('comm')) return 'Communication Systems';
    if (nameLower.includes('navigation') || nameLower.includes('nav')) return 'Navigation Systems';
    if (nameLower.includes('targeting') || nameLower.includes('target')) return 'Targeting Systems';
    if (nameLower.includes('laser')) return 'Laser Systems';
    if (nameLower.includes('data') || nameLower.includes('processor')) return 'Data Processing Systems';
    if (nameLower.includes('reconnaissance') || nameLower.includes('recon')) return 'Reconnaissance Systems';
    if (nameLower.includes('link')) return 'Data Link Systems';
    if (nameLower.includes('special')) return 'Special Systems';

    return 'Other Systems';
  };

  // Group assets by system type
  const groupedBySystemType: Record<string, {
    system_type: string;
    total_count: number;
    status_breakdown: Record<string, number>;
    assets: AssetDetails[];
  }> = {};

  allAssets.forEach(asset => {
    const systemType = extractSystemType(asset.part_name);

    if (!groupedBySystemType[systemType]) {
      groupedBySystemType[systemType] = {
        system_type: systemType,
        total_count: 0,
        status_breakdown: {},
        assets: [],
      };
    }

    groupedBySystemType[systemType].total_count++;
    groupedBySystemType[systemType].assets.push(asset);

    // Track status breakdown
    const status = asset.status_name;
    if (!groupedBySystemType[systemType].status_breakdown[status]) {
      groupedBySystemType[systemType].status_breakdown[status] = 0;
    }
    groupedBySystemType[systemType].status_breakdown[status]++;
  });

  // Convert to array and sort by system type name
  const systemTypeGroups = Object.values(groupedBySystemType).sort((a, b) =>
    a.system_type.localeCompare(b.system_type)
  );

  // Get program info
  const program = allPrograms.find(p => p.pgm_id === programIdFilter);

  console.log(`[REPORTS] Inventory report by ${user.username} (${user.role}) - Program: ${program?.pgm_cd}, Locations: ${userLocationIds.length > 0 ? userLocationIds.join(',') : 'ALL'}, Total assets: ${allAssets.length}, System types: ${systemTypeGroups.length}`);

  res.json({
    program: {
      pgm_id: programIdFilter,
      pgm_cd: program?.pgm_cd || 'UNKNOWN',
      pgm_name: program?.pgm_name || 'Unknown Program',
    },
    total_assets: allAssets.length,
    system_types: systemTypeGroups,
    generated_at: new Date().toISOString(),
  });
});

// =============================================================================
// PMI Schedule Report Endpoint
// =============================================================================

// GET /api/reports/pmi-schedule - Get PMI schedule report
app.get('/api/reports/pmi-schedule', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const userProgramIds = user.programs.map(p => p.pgm_id);
    const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];
    const isAdmin = user.role === 'ADMIN';

    // Get all PMI records - generated + custom
    const generatedPMI = generateMockPMIData();
    const customPMIIds = new Set(customPMIRecords.map(p => p.pmi_id));
    const filteredGeneratedPMI = generatedPMI.filter(p => !customPMIIds.has(p.pmi_id));
    let allPMIs = [...filteredGeneratedPMI, ...customPMIRecords];

    // Filter by program unless admin
    if (!isAdmin && userProgramIds.length > 0) {
      allPMIs = allPMIs.filter((pmi) => {
        return userProgramIds.includes(pmi.pgm_id);
      });
    }

    // Apply location filtering for non-admin users
    // PMI records are tied to assets, so filter based on asset location
    if (!isAdmin && userLocationIds.length > 0) {
      allPMIs = allPMIs.filter((pmi) => {
        // Find the asset for this PMI
        const asset = detailedAssets.find(a => a.asset_id === pmi.asset_id);
        if (!asset) return false;
        // Include PMI if asset is at any of the user's locations (handle null values)
        return (asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida)) ||
               (asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc));
      });
    }

    // Calculate current status for each PMI
    const pmiData = allPMIs.map((pmi) => {
      const daysUntilDue = calculateDaysUntilDue(pmi.next_due_date);
      return {
        ...pmi,
        days_until_due: daysUntilDue,
        status: pmi.completed_date ? 'completed' as const : getPMIStatus(daysUntilDue),
      };
    });

    // Sort by due date (earliest first), then by status priority
    const statusPriority = { overdue: 0, due_soon: 1, upcoming: 2, completed: 3 };
    pmiData.sort((a, b) => {
      // First sort by status priority
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;

      // Then by days until due
      return a.days_until_due - b.days_until_due;
    });

    // Group by status
    const byStatus = {
      overdue: pmiData.filter((p) => p.status === 'overdue'),
      due_soon: pmiData.filter((p) => p.status === 'due_soon'),
      upcoming: pmiData.filter((p) => p.status === 'upcoming'),
      completed: pmiData.filter((p) => p.status === 'completed'),
    };

    // Get program info for display
    const programIds = [...new Set(pmiData.map((p) => p.pgm_id))];
    const programs = programIds.map((id) => allPrograms.find((p) => p.pgm_id === id)).filter(Boolean);

    res.json({
      program: programs.length === 1 ? programs[0] : null,
      programs: programs,
      total: pmiData.length,
      by_status: {
        overdue: byStatus.overdue.length,
        due_soon: byStatus.due_soon.length,
        upcoming: byStatus.upcoming.length,
        completed: byStatus.completed.length,
      },
      pmis: pmiData,
      grouped_by_status: byStatus,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error generating PMI schedule report:', error);
    res.status(500).json({ error: 'Failed to generate PMI schedule report' });
  }
});

// =============================================================================
// Bad Actor Report Endpoint
// =============================================================================

// GET /api/reports/bad-actors - Get bad actor report
app.get('/api/reports/bad-actors', (req, res) => {
  const payload = authenticateRequest(req, res);
  if (!payload) return;

  const user = mockUsers.find(u => u.user_id === payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    const userProgramIds = user.programs.map(p => p.pgm_id);
    const userLocationIds = user.locations?.map(loc => loc.loc_id) || [];
    const isAdmin = user.role === 'ADMIN';

    // Filter bad actors by user's program access
    let badActors = detailedAssets.filter(asset => asset.bad_actor === true);

    // Apply program filter unless admin
    if (!isAdmin && userProgramIds.length > 0) {
      badActors = badActors.filter(asset => userProgramIds.includes(asset.pgm_id));
    }

    // Apply location filtering for non-admin users
    if (!isAdmin && userLocationIds.length > 0) {
      badActors = badActors.filter(asset =>
        (asset.loc_ida !== null && userLocationIds.includes(asset.loc_ida)) ||
        (asset.loc_idc !== null && userLocationIds.includes(asset.loc_idc))
      );
    }

    // For each bad actor, gather failure history from maintenance events
    const badActorData = badActors.map(asset => {
      // Find all maintenance events for this asset
      const assetEvents = maintenanceEvents.filter(event => event.asset_id === asset.asset_id);

      // Count repairs and failures
      const totalEvents = assetEvents.length;
      const criticalEvents = assetEvents.filter(e => e.priority === 'Critical').length;
      const urgentEvents = assetEvents.filter(e => e.priority === 'Urgent').length;

      // Find most recent event
      const sortedEvents = assetEvents.sort((a, b) =>
        new Date(b.start_job).getTime() - new Date(a.start_job).getTime()
      );
      const lastFailureDate = sortedEvents[0]?.start_job || null;

      // Get program info
      const program = allPrograms.find(p => p.pgm_id === asset.pgm_id);

      return {
        asset_id: asset.asset_id,
        serno: asset.serno,
        partno: asset.partno,
        part_name: asset.part_name,
        system_type: asset.sys_type,
        status_cd: asset.status_cd,
        status_name: asset.status_name,
        location: asset.location,
        loc_type: asset.loc_type,
        program: program ? {
          pgm_id: program.pgm_id,
          pgm_cd: program.pgm_cd,
          pgm_name: program.pgm_name,
        } : null,
        failure_count: totalEvents,
        critical_failures: criticalEvents,
        urgent_failures: urgentEvents,
        last_failure_date: lastFailureDate,
        remarks: asset.remarks,
      };
    });

    // Sort by failure count (highest first)
    badActorData.sort((a, b) => b.failure_count - a.failure_count);

    // Calculate summary statistics
    const totalBadActors = badActorData.length;
    const totalFailures = badActorData.reduce((sum, ba) => sum + ba.failure_count, 0);
    const criticalFailures = badActorData.reduce((sum, ba) => sum + ba.critical_failures, 0);
    const urgentFailures = badActorData.reduce((sum, ba) => sum + ba.urgent_failures, 0);

    // Get program info for display
    const programIds = [...new Set(badActorData.map(ba => ba.program?.pgm_id).filter(Boolean))];
    const programs = programIds.map(id => allPrograms.find(p => p.pgm_id === id)).filter(Boolean);

    res.json({
      program: programs.length === 1 ? programs[0] : null,
      programs: programs,
      summary: {
        total_bad_actors: totalBadActors,
        total_failures: totalFailures,
        critical_failures: criticalFailures,
        urgent_failures: urgentFailures,
        average_failures_per_asset: totalBadActors > 0 ? (totalFailures / totalBadActors).toFixed(1) : 0,
      },
      bad_actors: badActorData,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error generating bad actor report:', error);
    res.status(500).json({ error: 'Failed to generate bad actor report' });
  }
});

// Test endpoint for timeout testing (Feature #255)
// This endpoint simulates a slow response to test timeout handling
app.get('/api/test/slow', (req, res) => {
  const delayMs = parseInt(req.query.delay as string) || 5000;

  console.log(`[TEST] Slow endpoint called with ${delayMs}ms delay`);

  setTimeout(() => {
    res.json({
      message: 'Slow response completed',
      delay: delayMs,
      timestamp: new Date().toISOString(),
    });
  }, delayMs);
});

// Test endpoint for database error simulation (Feature #447)
// This endpoint simulates a database connection failure to test error handling
app.get('/api/test/database-error', (req, res) => {
  // Optional delay before error (simulates timeout + failure)
  const delayMs = parseInt(req.query.delay as string) || 0;
  const errorType = req.query.type as string || 'connection';

  console.log(`[TEST] Database error simulation: type=${errorType}, delay=${delayMs}ms`);

  const sendError = () => {
    switch (errorType) {
      case 'connection':
        res.status(503).json({
          error: 'Database connection failed. The database server is not responding.',
          code: 'DB_CONNECTION_ERROR',
          canRetry: true,
          timestamp: new Date().toISOString(),
        });
        break;
      case 'timeout':
        res.status(504).json({
          error: 'Database query timed out. Please try again.',
          code: 'DB_TIMEOUT',
          canRetry: true,
          timestamp: new Date().toISOString(),
        });
        break;
      case 'unavailable':
        res.status(503).json({
          error: 'Database service temporarily unavailable. Please try again later.',
          code: 'DB_UNAVAILABLE',
          canRetry: true,
          timestamp: new Date().toISOString(),
        });
        break;
      default:
        res.status(500).json({
          error: 'An unexpected database error occurred.',
          code: 'DB_UNKNOWN_ERROR',
          canRetry: true,
          timestamp: new Date().toISOString(),
        });
    }
  };

  if (delayMs > 0) {
    setTimeout(sendError, delayMs);
  } else {
    sendError();
  }
});

// Test endpoint for simulating working database after errors (recovery testing)
app.get('/api/test/database-success', (_req, res) => {
  console.log('[TEST] Database success simulation (recovery test)');
  res.json({
    message: 'Database connection successful',
    status: 'connected',
    timestamp: new Date().toISOString(),
    data: {
      items: [
        { id: 1, name: 'Test Record 1' },
        { id: 2, name: 'Test Record 2' },
        { id: 3, name: 'Test Record 3' },
      ]
    }
  });
});

// Catch-all route: serve index.html for any unknown requests (for React Router)
// This must be after all API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start server
// Initialize assets from database before starting server
initializeAssetsFromDb().then(() => initializeMaintenanceEventsFromDb()).then(() => initializePMIFromDb()).then(() => {
  app.listen(PORT, () => {
  console.log(`
  ============================================
  RIMSS Backend Server
  ============================================
  Server running on: http://localhost:${PORT}
  Environment: ${process.env.NODE_ENV || 'development'}
  ============================================
  `)
})

}).catch(err => {
  console.error('[Startup] Failed to initialize assets:', err);
  process.exit(1);
});
export default app

