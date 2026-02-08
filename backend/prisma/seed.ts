/**
 * RIMSS Database Seed Script
 * 
 * Creates representative data for development and Railway cloud deployment.
 * Idempotent: safe to re-run (truncates + reseeds all data).
 * 
 * Data volumes (~1,560 assets, ~26K total records):
 *   - 4 programs: CRIIS, ACTS, ARDS, 236
 *   - 80 locations with assets (15 assets per location)
 *   - 52 unique part numbers across programs
 *   - Events, repairs, labors, sorties, meter history, inspections
 *   - 5 users with role-based access
 *   - Essential reference codes (STATUS, HOW_MAL, etc.)
 * 
 * Usage:
 *   npx tsx prisma/seed.ts
 *   # or via prisma:
 *   npx prisma db seed
 */

import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ============================================================
// DETERMINISTIC RANDOM (for reproducible seeds)
// ============================================================
let _seed = 42;
function rand(): number {
  _seed = (_seed * 16807) % 2147483647;
  return (_seed - 1) / 2147483646;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}
function randDate(startYear: number, endYear: number): Date {
  const start = new Date(startYear, 0, 1).getTime();
  const end = new Date(endYear, 11, 31).getTime();
  return new Date(start + rand() * (end - start));
}

// ============================================================
// REFERENCE DATA
// ============================================================

const PROGRAMS = [
  { pgm_id: 1, pgm_cd: 'CRIIS', pgm_name: 'CRIIS Program' },
  { pgm_id: 2, pgm_cd: 'ACTS',  pgm_name: 'ACTS Program' },
  { pgm_id: 3, pgm_cd: 'ARDS',  pgm_name: 'ARDS Program' },
  { pgm_id: 4, pgm_cd: '236',   pgm_name: 'Program 236' },
];

// Locations that have assets (80 locations)
// Each gets 15 assets. Program assignment based on real RIMSS data.
interface LocDef { loc_id: number; display_name: string; programs: number[] }
const LOCATIONS: LocDef[] = [
  // CRIIS locations (pgm 1) - 12 locations
  { loc_id: 10,  display_name: 'KEY WEST NAS',          programs: [1] },
  { loc_id: 507, display_name: 'CRIIS DEPOT A',         programs: [1] },
  { loc_id: 519, display_name: 'CRIIS DEPOT B',         programs: [1] },
  { loc_id: 528, display_name: 'CRIIS FIELD SITE 1',    programs: [1] },
  { loc_id: 529, display_name: 'CRIIS FIELD SITE 2',    programs: [1] },
  { loc_id: 530, display_name: 'CRIIS FIELD SITE 3',    programs: [1] },
  { loc_id: 531, display_name: 'CRIIS FIELD SITE 4',    programs: [1] },
  { loc_id: 537, display_name: 'CRIIS FIELD SITE 5',    programs: [1] },
  { loc_id: 549, display_name: 'CRIIS TEST RANGE',      programs: [1] },
  { loc_id: 572, display_name: 'CRIIS MAINT CENTER',    programs: [1] },
  { loc_id: 579, display_name: 'CRIIS STORAGE',         programs: [1] },
  { loc_id: 580, display_name: 'CRIIS CALIBRATION',     programs: [1] },

  // ACTS locations (pgm 2) - 61 locations
  { loc_id: 24,  display_name: 'LANGLEY AFB - 1 FW',           programs: [2] },
  { loc_id: 29,  display_name: 'JACKSONVILLE IAP - 125 FW',    programs: [2] },
  { loc_id: 31,  display_name: 'DULUTH IAP - 148 FW',          programs: [2] },
  { loc_id: 35,  display_name: 'KLAMATH FALLS - 173 FW',       programs: [2] },
  { loc_id: 40,  display_name: 'DANNELLY FIELD - 187 FW',      programs: [2] },
  { loc_id: 41,  display_name: 'SHAW AFB - 20 FW',             programs: [2] },
  { loc_id: 42,  display_name: 'ELMENDORF AFB - 3 WG',         programs: [2] },
  { loc_id: 43,  display_name: 'TYNDALL AFB - 325 FW',         programs: [2] },
  { loc_id: 45,  display_name: 'EIELSON AFB - 354 FW',         programs: [2, 3] },
  { loc_id: 46,  display_name: 'HILL AFB - 388 FW',            programs: [2] },
  { loc_id: 47,  display_name: 'EGLIN AFB - 46 TW',            programs: [2] },
  { loc_id: 48,  display_name: 'RAF LAKENHEATH - 48 FW',       programs: [2, 3] },
  { loc_id: 49,  display_name: 'HOMESTEAD AFB - 482 FW',       programs: [2] },
  { loc_id: 50,  display_name: 'LUKE AFB - 56 FW',             programs: [2] },
  { loc_id: 51,  display_name: 'NELLIS AFB - 57 FW',           programs: [2] },
  { loc_id: 53,  display_name: 'CRASH/CNDM',                   programs: [2, 3] },
  { loc_id: 62,  display_name: 'ALPENA IAP - CRTC ALPENA',     programs: [2] },
  { loc_id: 63,  display_name: 'GULFPORT IAP - CRTC GULFPORT', programs: [2] },
  { loc_id: 64,  display_name: 'SAVANNAH IAP - CRTC SAVANNAH', programs: [2] },
  { loc_id: 65,  display_name: 'VOLK FIELD - CRTC VOLK',       programs: [2] },
  { loc_id: 66,  display_name: 'BARKSDALE AFB',                programs: [2] },
  { loc_id: 78,  display_name: 'BOEING ST LOUIS',              programs: [2, 3] },
  { loc_id: 81,  display_name: 'DAVIS-MONTHAN AFB',            programs: [2] },
  { loc_id: 90,  display_name: 'EDWARDS AFB',                  programs: [2] },
  { loc_id: 95,  display_name: 'EGLIN AFB OL',                 programs: [2] },
  { loc_id: 108, display_name: 'FRESNO YOSEMITE IAP',          programs: [2] },
  { loc_id: 111, display_name: 'GEORGE AFB',                   programs: [2] },
  { loc_id: 113, display_name: 'GREAT FALLS IAP',              programs: [2] },
  { loc_id: 117, display_name: 'HECTOR IAP',                   programs: [2] },
  { loc_id: 118, display_name: 'HENDERSON',                    programs: [2] },
  { loc_id: 120, display_name: 'HOLLOMAN AFB',                 programs: [2] },
  { loc_id: 183, display_name: 'MCCHORD AFB',                  programs: [2] },
  { loc_id: 204, display_name: 'MOODY AFB',                    programs: [2] },
  { loc_id: 260, display_name: 'POPE AFB',                     programs: [2] },
  { loc_id: 265, display_name: 'RANDOLPH AFB',                 programs: [2] },
  { loc_id: 276, display_name: 'ROBINS AFB',                   programs: [2] },
  { loc_id: 283, display_name: 'SEYMOUR JOHNSON AFB',          programs: [2] },
  { loc_id: 285, display_name: 'SHEPPARD AFB',                 programs: [2] },
  { loc_id: 290, display_name: 'SPANGDAHLEM AB',               programs: [2] },
  { loc_id: 312, display_name: 'TINKER AFB',                   programs: [2] },
  { loc_id: 320, display_name: 'TULSA AIR LOGISTICS',          programs: [2] },
  { loc_id: 324, display_name: 'VANDENBERG AFB',               programs: [2] },
  { loc_id: 337, display_name: 'WHITEMAN AFB',                 programs: [2] },
  { loc_id: 340, display_name: 'WRIGHT-PATTERSON AFB',         programs: [2] },
  { loc_id: 390, display_name: 'KUNSAN AB',                    programs: [2] },
  { loc_id: 392, display_name: 'OSAN AB',                      programs: [2] },
  { loc_id: 394, display_name: 'MISAWA AB',                    programs: [2] },
  { loc_id: 403, display_name: 'AVIANO AB',                    programs: [2] },
  { loc_id: 434, display_name: 'CANNON AFB',                   programs: [2] },
  { loc_id: 457, display_name: 'JB PEARL HARBOR-HICKAM',       programs: [2] },
  { loc_id: 458, display_name: 'KADENA AB',                    programs: [2] },
  { loc_id: 464, display_name: 'MOUNTAIN HOME AFB',            programs: [2] },
  { loc_id: 472, display_name: 'RAF MILDENHALL',               programs: [2] },
  { loc_id: 473, display_name: 'RAMSTEIN AB',                  programs: [2] },
  { loc_id: 474, display_name: 'INCIRLIK AB',                  programs: [2] },
  { loc_id: 477, display_name: 'AL DHAFRA AB',                 programs: [2] },
  { loc_id: 479, display_name: 'PRINCE SULTAN AB',             programs: [2] },
  { loc_id: 480, display_name: 'AL UDEID AB',                  programs: [2] },
  { loc_id: 482, display_name: 'BAGRAM AIRFIELD',              programs: [2] },
  { loc_id: 483, display_name: 'THULE AB',                     programs: [2] },

  // ARDS locations (pgm 3) - 20 locations
  { loc_id: 581, display_name: 'ARDS DEPOT A',                 programs: [3] },
  { loc_id: 593, display_name: 'ARDS FIELD SITE 1',            programs: [3] },
  { loc_id: 597, display_name: 'ARDS FIELD SITE 2',            programs: [3] },
  { loc_id: 599, display_name: 'ARDS FIELD SITE 3',            programs: [3] },
  { loc_id: 608, display_name: 'ARDS FIELD SITE 4',            programs: [3] },
  { loc_id: 653, display_name: 'ARDS MAINT CENTER',            programs: [3] },
  { loc_id: 662, display_name: 'ARDS STORAGE',                 programs: [3] },
  { loc_id: 676, display_name: 'ARDS CALIBRATION',             programs: [3] },
  // Shared ARDS locations (45, 48, 53, 78 already listed above with [2,3])
  // Add 12 more ARDS-only locations to reach 20 total
  { loc_id: 700, display_name: 'ARDS TEST SITE ALPHA',         programs: [3] },
  { loc_id: 701, display_name: 'ARDS TEST SITE BRAVO',         programs: [3] },
  { loc_id: 702, display_name: 'ARDS LOGISTICS HUB',           programs: [3] },
  { loc_id: 703, display_name: 'ARDS REPAIR CENTER',           programs: [3] },

  // 236 locations (pgm 4) - 11 locations
  { loc_id: 800, display_name: '236 OPERATIONS CENTER A',      programs: [4] },
  { loc_id: 801, display_name: '236 OPERATIONS CENTER B',      programs: [4] },
  { loc_id: 802, display_name: '236 FIELD STATION 1',          programs: [4] },
  { loc_id: 803, display_name: '236 FIELD STATION 2',          programs: [4] },
  { loc_id: 804, display_name: '236 FIELD STATION 3',          programs: [4] },
  { loc_id: 805, display_name: '236 FIELD STATION 4',          programs: [4] },
  { loc_id: 806, display_name: '236 DEPOT',                    programs: [4] },
  { loc_id: 807, display_name: '236 TEST RANGE',               programs: [4] },
  { loc_id: 808, display_name: '236 MAINT FACILITY',           programs: [4] },
  { loc_id: 809, display_name: '236 CALIBRATION LAB',          programs: [4] },
  { loc_id: 810, display_name: '236 SECURE STORAGE',           programs: [4] },
];

// Also include spares location
const SPARES_LOC = { loc_id: 1, display_name: 'CENTRAL SPARES DEPOT' };

// Parts per program
interface PartDef { partno_id: number; partno: string; pgm_id: number; noun: string }
const PARTS: PartDef[] = [
  // CRIIS (pgm 1) - 15 parts
  { partno_id: 1,  partno: '717512542-019', pgm_id: 1, noun: 'SHAFT' },
  { partno_id: 2,  partno: '717512725-009', pgm_id: 1, noun: 'NOC' },
  { partno_id: 3,  partno: '717512780-029', pgm_id: 1, noun: 'SLIDING WFOV ASSY.' },
  { partno_id: 4,  partno: '717512790-029', pgm_id: 1, noun: 'DRIVE MECHANISM ASSY.' },
  { partno_id: 5,  partno: '717512854-019', pgm_id: 1, noun: 'LASER PRISM ASSY.' },
  { partno_id: 6,  partno: '717535110-409', pgm_id: 1, noun: 'GIMBOL CONTROL PROCESSOR ECA' },
  { partno_id: 7,  partno: '717535165-319', pgm_id: 1, noun: 'SYMBOL GENERATOR PROCESSOR ECA' },
  { partno_id: 8,  partno: '717535165-349', pgm_id: 1, noun: 'SYMBOL GENERATOR PROCESSOR ECA' },
  { partno_id: 9,  partno: '717535165-359', pgm_id: 1, noun: 'SYMBOL GENERATOR PROCESSOR ECA' },
  { partno_id: 10, partno: '717535172-019', pgm_id: 1, noun: 'BACKPLANE ASSY. HOLDER' },
  { partno_id: 11, partno: '717535172-039', pgm_id: 1, noun: 'BACKPLANE ASSY. HOLDER' },
  { partno_id: 12, partno: '717535175-269', pgm_id: 1, noun: 'LASER ELECTRONICS ECA' },
  { partno_id: 13, partno: '717535175-309', pgm_id: 1, noun: 'LASER ELECTRONICS ECA' },
  { partno_id: 14, partno: '717535200-349', pgm_id: 1, noun: 'TARGETING SET CONTROL' },
  { partno_id: 15, partno: '717535270-599', pgm_id: 1, noun: 'INPUT INTERFACE ECA' },
  // ACTS (pgm 2) - 20 parts
  { partno_id: 16, partno: 'ACTS-TGT-001', pgm_id: 2, noun: 'TARGETING PROCESSOR UNIT' },
  { partno_id: 17, partno: 'ACTS-TGT-002', pgm_id: 2, noun: 'LASER DESIGNATOR ASSEMBLY' },
  { partno_id: 18, partno: 'ACTS-OPT-001', pgm_id: 2, noun: 'OPTICAL SIGHT UNIT' },
  { partno_id: 19, partno: 'ACTS-OPT-002', pgm_id: 2, noun: 'FORWARD LOOKING INFRARED (FLIR)' },
  { partno_id: 20, partno: 'ACTS-NAV-001', pgm_id: 2, noun: 'INERTIAL NAVIGATION SYSTEM' },
  { partno_id: 21, partno: 'ACTS-NAV-002', pgm_id: 2, noun: 'GPS RECEIVER MODULE' },
  { partno_id: 22, partno: 'ACTS-CCA-001', pgm_id: 2, noun: 'SIGNAL PROCESSOR CCA' },
  { partno_id: 23, partno: 'ACTS-CCA-002', pgm_id: 2, noun: 'VIDEO PROCESSOR CCA' },
  { partno_id: 24, partno: 'ACTS-PWR-001', pgm_id: 2, noun: 'POWER SUPPLY ASSEMBLY' },
  { partno_id: 25, partno: 'ACTS-PWR-002', pgm_id: 2, noun: 'DC-DC CONVERTER MODULE' },
  { partno_id: 26, partno: 'ACTS-DIS-001', pgm_id: 2, noun: 'HEAD-UP DISPLAY UNIT' },
  { partno_id: 27, partno: 'ACTS-DIS-002', pgm_id: 2, noun: 'MULTIFUNCTION DISPLAY' },
  { partno_id: 28, partno: 'ACTS-SEN-001', pgm_id: 2, noun: 'RADAR ALTIMETER RCVR/XMTR' },
  { partno_id: 29, partno: 'ACTS-SEN-002', pgm_id: 2, noun: 'TERRAIN FOLLOWING RADAR UNIT' },
  { partno_id: 30, partno: 'ACTS-COM-001', pgm_id: 2, noun: 'DATA LINK TRANSCEIVER' },
  { partno_id: 31, partno: 'ACTS-COM-002', pgm_id: 2, noun: 'ENCRYPTION MODULE' },
  { partno_id: 32, partno: 'ACTS-WPN-001', pgm_id: 2, noun: 'WEAPON RELEASE COMPUTER' },
  { partno_id: 33, partno: 'ACTS-WPN-002', pgm_id: 2, noun: 'STORES MANAGEMENT PROCESSOR' },
  { partno_id: 34, partno: 'ACTS-ECU-001', pgm_id: 2, noun: 'ENVIRONMENTAL CONTROL UNIT' },
  { partno_id: 35, partno: 'ACTS-TST-001', pgm_id: 2, noun: 'BUILT-IN TEST EQUIPMENT' },
  // ARDS (pgm 3) - 15 parts
  { partno_id: 36, partno: 'ARDS-CAM-001', pgm_id: 3, noun: 'RECONNAISSANCE CAMERA ASSEMBLY' },
  { partno_id: 37, partno: 'ARDS-CAM-002', pgm_id: 3, noun: 'ELECTRO-OPTICAL SENSOR' },
  { partno_id: 38, partno: 'ARDS-DAT-001', pgm_id: 3, noun: 'DATA RECORDING MODULE' },
  { partno_id: 39, partno: 'ARDS-DAT-002', pgm_id: 3, noun: 'DIGITAL IMAGE PROCESSOR' },
  { partno_id: 40, partno: 'ARDS-LNK-001', pgm_id: 3, noun: 'DATA LINK TRANSMITTER' },
  { partno_id: 41, partno: 'ARDS-LNK-002', pgm_id: 3, noun: 'ANTENNA CONTROL UNIT' },
  { partno_id: 42, partno: 'ARDS-NAV-001', pgm_id: 3, noun: 'STABILIZED PLATFORM ASSEMBLY' },
  { partno_id: 43, partno: 'ARDS-PWR-001', pgm_id: 3, noun: 'POWER DISTRIBUTION UNIT' },
  { partno_id: 44, partno: 'ARDS-CCA-001', pgm_id: 3, noun: 'MISSION COMPUTER CCA' },
  { partno_id: 45, partno: 'ARDS-DIS-001', pgm_id: 3, noun: 'GROUND STATION DISPLAY' },
  { partno_id: 46, partno: 'ARDS-SEN-001', pgm_id: 3, noun: 'IR DETECTOR ARRAY' },
  { partno_id: 47, partno: 'ARDS-SEN-002', pgm_id: 3, noun: 'MULTISPECTRAL SCANNER' },
  { partno_id: 48, partno: 'ARDS-STR-001', pgm_id: 3, noun: 'IMAGE STORAGE UNIT' },
  { partno_id: 49, partno: 'ARDS-TST-001', pgm_id: 3, noun: 'GROUND SUPPORT TEST SET' },
  { partno_id: 50, partno: 'ARDS-CTL-001', pgm_id: 3, noun: 'MISSION PLANNING TERMINAL' },
  // 236 (pgm 4) - 12 parts
  { partno_id: 51, partno: '236-SYS-001', pgm_id: 4, noun: 'SIGNAL INTELLIGENCE PROCESSOR' },
  { partno_id: 52, partno: '236-SYS-002', pgm_id: 4, noun: 'ELECTRONIC WARFARE RECEIVER' },
  { partno_id: 53, partno: '236-COM-001', pgm_id: 4, noun: 'SECURE COMMUNICATIONS MODULE' },
  { partno_id: 54, partno: '236-COM-002', pgm_id: 4, noun: 'FREQUENCY HOPPING TRANSCEIVER' },
  { partno_id: 55, partno: '236-SEN-001', pgm_id: 4, noun: 'DIRECTION FINDING ANTENNA' },
  { partno_id: 56, partno: '236-SEN-002', pgm_id: 4, noun: 'RF SPECTRUM ANALYZER' },
  { partno_id: 57, partno: '236-PWR-001', pgm_id: 4, noun: 'UNINTERRUPTIBLE POWER SUPPLY' },
  { partno_id: 58, partno: '236-CCA-001', pgm_id: 4, noun: 'CRYPTO PROCESSOR CARD' },
  { partno_id: 59, partno: '236-DIS-001', pgm_id: 4, noun: 'TACTICAL DISPLAY CONSOLE' },
  { partno_id: 60, partno: '236-CTL-001', pgm_id: 4, noun: 'REMOTE OPERATIONS CONTROLLER' },
  { partno_id: 61, partno: '236-TST-001', pgm_id: 4, noun: 'SYSTEM TEST EQUIPMENT' },
  { partno_id: 62, partno: '236-NAV-001', pgm_id: 4, noun: 'PRECISION TIMING UNIT' },
];

// Status distribution for assets
const STATUS_WEIGHTS: [string, number][] = [
  ['FMC',  0.65],
  ['PMC',  0.12],
  ['NMCM', 0.08],
  ['NMCS', 0.05],
  ['PMCM', 0.05],
  ['PMCS', 0.03],
  ['CNDM', 0.02],
];

function pickStatus(): string {
  const r = rand();
  let cum = 0;
  for (const [status, weight] of STATUS_WEIGHTS) {
    cum += weight;
    if (r <= cum) return status;
  }
  return 'FMC';
}

// Reference codes the app needs
const CODES = [
  // STATUS
  { code_type: 'STATUS', code_value: 'FMC',  description: 'Fully Mission Capable', sort_order: 1 },
  { code_type: 'STATUS', code_value: 'PMC',  description: 'Partially Mission Capable', sort_order: 2 },
  { code_type: 'STATUS', code_value: 'NMCM', description: 'Not Mission Capable - Maintenance', sort_order: 3 },
  { code_type: 'STATUS', code_value: 'NMCS', description: 'Not Mission Capable - Supply', sort_order: 4 },
  { code_type: 'STATUS', code_value: 'PMCM', description: 'Partially Mission Capable - Maintenance', sort_order: 5 },
  { code_type: 'STATUS', code_value: 'PMCS', description: 'Partially Mission Capable - Supply', sort_order: 6 },
  { code_type: 'STATUS', code_value: 'CNDM', description: 'Condemned', sort_order: 7 },
  { code_type: 'STATUS', code_value: 'DEPOT', description: 'In Depot', sort_order: 8 },
  { code_type: 'STATUS', code_value: 'INACTIVE', description: 'Inactive', sort_order: 9 },
  // HOW_MAL
  { code_type: 'HOW_MAL', code_value: '290', description: 'FAILS DIAGNOSTIC / AUTOMATIC TEST', sort_order: 1 },
  { code_type: 'HOW_MAL', code_value: '242', description: 'FAILED TO OPERATE - SPECIFIC REASON UNKNOWN', sort_order: 2 },
  { code_type: 'HOW_MAL', code_value: '799', description: 'NO DEFECT', sort_order: 3 },
  { code_type: 'HOW_MAL', code_value: '190', description: 'CRACKED', sort_order: 4 },
  { code_type: 'HOW_MAL', code_value: '070', description: 'BROKEN', sort_order: 5 },
  { code_type: 'HOW_MAL', code_value: '008', description: 'NOISY / CHATTERING', sort_order: 6 },
  { code_type: 'HOW_MAL', code_value: '029', description: 'CURRENT INCORRECT', sort_order: 7 },
  { code_type: 'HOW_MAL', code_value: '002', description: 'SERVICING', sort_order: 8 },
  // ACTION_TAKEN
  { code_type: 'ACTION_TAKEN', code_value: 'F', description: 'REPAIR', sort_order: 1 },
  { code_type: 'ACTION_TAKEN', code_value: 'Y', description: 'TROUBLESHOOT', sort_order: 2 },
  { code_type: 'ACTION_TAKEN', code_value: 'B', description: 'BENCH CHECKED SERVICEABLE', sort_order: 3 },
  { code_type: 'ACTION_TAKEN', code_value: 'P', description: 'REMOVED', sort_order: 4 },
  { code_type: 'ACTION_TAKEN', code_value: 'Q', description: 'INSTALLED', sort_order: 5 },
  { code_type: 'ACTION_TAKEN', code_value: 'T', description: 'REMOVED FOR CANN', sort_order: 6 },
  // TYPE_MAINT
  { code_type: 'TYPE_MAINT', code_value: 'A', description: 'SERVICE', sort_order: 1 },
  { code_type: 'TYPE_MAINT', code_value: 'B', description: 'UNSCHEDULED MAINT', sort_order: 2 },
  { code_type: 'TYPE_MAINT', code_value: 'C', description: 'SHOP WORK', sort_order: 3 },
  { code_type: 'TYPE_MAINT', code_value: 'D', description: 'SCHEDULED INSPECTION', sort_order: 4 },
  { code_type: 'TYPE_MAINT', code_value: 'E', description: 'MINOR INSPECTION', sort_order: 5 },
  { code_type: 'TYPE_MAINT', code_value: 'P', description: 'PERIODIC INSPECTION', sort_order: 6 },
  { code_type: 'TYPE_MAINT', code_value: 'R', description: 'DEPOT MAINT', sort_order: 7 },
  { code_type: 'TYPE_MAINT', code_value: 'S', description: 'SPECIAL INSPECTION', sort_order: 8 },
  { code_type: 'TYPE_MAINT', code_value: 'T', description: 'TCTO', sort_order: 9 },
  // CAT_LABOR
  { code_type: 'CAT_LABOR', code_value: '1', description: 'MILITARY REG', sort_order: 1 },
  { code_type: 'CAT_LABOR', code_value: '3', description: 'FEDERAL SERVICE REG', sort_order: 2 },
  { code_type: 'CAT_LABOR', code_value: '6', description: 'CONTRACTOR', sort_order: 3 },
  // WHEN_DISC
  { code_type: 'WHEN_DISC', code_value: 'D', description: 'DURING EQUIP OPS / NO DOWN TIME', sort_order: 1 },
  { code_type: 'WHEN_DISC', code_value: 'F', description: 'UNSCHED MAINT', sort_order: 2 },
  { code_type: 'WHEN_DISC', code_value: 'A', description: 'BEFORE FLIGHT / COUNTDOWN ABORT', sort_order: 3 },
  { code_type: 'WHEN_DISC', code_value: 'W', description: 'IN SHOP REPAIR', sort_order: 4 },
  { code_type: 'WHEN_DISC', code_value: 'S', description: 'DEPOT LEVEL MAINT', sort_order: 5 },
  // METER_TYPE
  { code_type: 'METER_TYPE', code_value: 'ETI', description: 'Elapsed Time Indicator', sort_order: 1 },
  { code_type: 'METER_TYPE', code_value: 'UNKN', description: 'Unknown', sort_order: 2 },
  // PMI_TYPE
  { code_type: 'PMI_TYPE', code_value: '30-DAY',  description: 'PMI', sort_order: 1 },
  { code_type: 'PMI_TYPE', code_value: '120-1',   description: 'PMI', sort_order: 2 },
  { code_type: 'PMI_TYPE', code_value: '180-DAY', description: 'PMI', sort_order: 3 },
  { code_type: 'PMI_TYPE', code_value: '360L',    description: 'PMI', sort_order: 4 },
  // SORTIE_TYPES
  { code_type: 'SORTIE_TYPES', code_value: 'EFFECTIVE',     description: 'SORTIE: EFFECTIVE', sort_order: 1 },
  { code_type: 'SORTIE_TYPES', code_value: 'NON-EFFECTIVE', description: 'SORTIE: NON-EFFECTIVE', sort_order: 2 },
  { code_type: 'SORTIE_TYPES', code_value: 'PARTIAL',       description: 'SORTIE: PARTIAL', sort_order: 3 },
  { code_type: 'SORTIE_TYPES', code_value: 'OTHER',         description: 'SORTIE: OTHER', sort_order: 4 },
  // SOURCE
  { code_type: 'SOURCE', code_value: 'RIMSS', description: 'RIMSS', sort_order: 1 },
  { code_type: 'SOURCE', code_value: 'IMDS',  description: 'IMDS', sort_order: 2 },
  // EVENT_TYPE (implicit from usage)
  { code_type: 'EVENT_TYPE', code_value: 'CORRECTIVE', description: 'Corrective Maintenance', sort_order: 1 },
  { code_type: 'EVENT_TYPE', code_value: 'PREVENTIVE', description: 'Preventive Maintenance', sort_order: 2 },
  { code_type: 'EVENT_TYPE', code_value: 'INSPECTION', description: 'Inspection', sort_order: 3 },
];

const HOW_MALS = ['290', '242', '799', '190', '070', '008'];
const ACTIONS = ['F', 'Y', 'B', 'P', 'Q'];
const TYPE_MAINTS = ['A', 'B', 'C', 'D'];
const CAT_LABORS = ['1', '3', '6'];
const WHEN_DISCS = ['D', 'F', 'A', 'W'];
const METER_ACTIONS = ['INSTALL', 'REMOVE', 'READ', 'RESET'];
const PMI_TYPES = ['30-DAY', '120-1', '180-DAY', '360L'];
const SORTIE_EFFECTS = ['EFFECTIVE', 'NON-EFF', 'PARTIAL'];
const EVENT_TYPES = ['CORRECTIVE', 'PREVENTIVE', 'INSPECTION'];
const DISCREPANCIES = [
  'Unit failed BIT test during ground operations',
  'Intermittent power fluctuations observed',
  'Display showing erratic readings',
  'Component overheating during extended operation',
  'Calibration out of tolerance',
  'Connector damage found during inspection',
  'Software fault code generated',
  'Mechanical binding in traverse mechanism',
  'Signal degradation exceeding limits',
  'Scheduled maintenance due',
];
const CORRECTIVE_ACTIONS = [
  'Replaced defective module, tested satisfactory',
  'Repaired connector, verified continuity',
  'Recalibrated per technical order',
  'Replaced circuit card, BIT test passed',
  'Cleaned and lubricated mechanism',
  'Updated firmware to latest revision',
  'Replaced power supply, load tested OK',
  'Bench checked serviceable, reinstalled',
  'Adjusted alignment per maintenance manual',
  'Completed scheduled inspection, no defects found',
];

// ============================================================
// MAIN SEED FUNCTION
// ============================================================
async function main() {
  console.log('🌱 Starting RIMSS seed...\n');

  // ---- TRUNCATE ALL (cascade) ----
  console.log('  Truncating all tables...');
  const tables = [
    'tcto_asset', 'tcto', 'software_asset', 'software', 'sru_order',
    'labor_bit_pc', 'labor_part', 'asset_inspection', 'meter_hist',
    'labor', 'repair', 'event', 'sorties', 'spares', 'shipment',
    'parts_order_history', 'parts_order', 'bad_actor', 'attachment',
    'notification', 'audit_log', 'cfg_meters', 'cfg_list', 'cfg_set',
    'asset', 'loc_set', 'user_location', 'user_program',
    'program_location', 'part_list', 'code_group', 'code',
    'location', 'users', 'program', 'adm_variable',
  ];
  for (const t of tables) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${t}" CASCADE`);
    } catch { /* table may not exist */ }
  }

  // Reset sequences
  const sequences = [
    'program_pgm_id_seq', 'users_user_id_seq', 'location_loc_id_seq',
    'part_list_partno_id_seq', 'asset_asset_id_seq', 'event_event_id_seq',
    'repair_repair_id_seq', 'labor_labor_id_seq', 'meter_hist_meter_id_seq',
    'sorties_sortie_id_seq', 'asset_inspection_hist_id_seq', 'code_code_id_seq',
    'user_program_user_program_id_seq', 'user_location_user_location_id_seq',
    'program_location_program_location_id_seq', 'loc_set_set_id_seq',
    'spares_spare_id_seq', 'adm_variable_var_id_seq',
  ];
  for (const seq of sequences) {
    try {
      await prisma.$executeRawUnsafe(`ALTER SEQUENCE "${seq}" RESTART WITH 1`);
    } catch { /* sequence may not exist */ }
  }

  // ---- PROGRAMS ----
  console.log('  Creating programs...');
  for (const p of PROGRAMS) {
    await prisma.program.create({
      data: { pgm_id: p.pgm_id, pgm_cd: p.pgm_cd, pgm_name: p.pgm_name, ins_by: 'SEED' },
    });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "program_pgm_id_seq" RESTART WITH 5`);

  // ---- USERS ----
  console.log('  Creating users...');
  const pwHash = await bcrypt.hash('admin123', 10);
  const users = [
    { user_id: 1, username: 'admin',      email: 'admin@rimss.mil',  first_name: 'John',  last_name: 'Admin',  role: UserRole.ADMIN },
    { user_id: 2, username: 'viewer',     email: 'viewer@rimss.mil', first_name: 'Sam',   last_name: 'Viewer', role: UserRole.VIEWER },
    { user_id: 3, username: 'field_tech', email: 'field@rimss.mil',  first_name: 'Bob',   last_name: 'Field',  role: UserRole.FIELD_TECHNICIAN },
    { user_id: 4, username: 'depot_mgr',  email: 'depot@rimss.mil',  first_name: 'Jane',  last_name: 'Depot',  role: UserRole.DEPOT_MANAGER },
    { user_id: 5, username: 'tech2',      email: 'tech2@rimss.mil',  first_name: 'Mike',  last_name: 'Tech',   role: UserRole.FIELD_TECHNICIAN },
  ];
  for (const u of users) {
    await prisma.user.create({
      data: { user_id: u.user_id, username: u.username, password_hash: pwHash, email: u.email, first_name: u.first_name, last_name: u.last_name, role: u.role },
    });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "users_user_id_seq" RESTART WITH 6`);

  // ---- CODES ----
  console.log('  Creating reference codes...');
  await prisma.code.createMany({ data: CODES.map(c => ({ ...c, ins_by: 'SEED' })) });

  // ---- LOCATIONS ----
  console.log('  Creating locations...');
  // Spares location first
  await prisma.location.create({
    data: { loc_id: SPARES_LOC.loc_id, display_name: SPARES_LOC.display_name, ins_by: 'SEED' },
  });
  for (const loc of LOCATIONS) {
    await prisma.location.create({
      data: { loc_id: loc.loc_id, display_name: loc.display_name, ins_by: 'SEED' },
    });
  }
  // Reset sequence past max loc_id
  const maxLocId = Math.max(...LOCATIONS.map(l => l.loc_id)) + 1;
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "location_loc_id_seq" RESTART WITH ${maxLocId}`);

  // ---- PROGRAM_LOCATION ----
  console.log('  Creating program-location mappings...');
  const plData: { pgm_id: number; loc_id: number }[] = [];
  for (const loc of LOCATIONS) {
    for (const pgmId of loc.programs) {
      plData.push({ pgm_id: pgmId, loc_id: loc.loc_id });
    }
  }
  await prisma.programLocation.createMany({ data: plData.map(d => ({ ...d, ins_by: 'SEED' })) });

  // ---- USER_PROGRAM + USER_LOCATION ----
  console.log('  Creating user access...');
  // Admin gets all programs and all locations
  for (const p of PROGRAMS) {
    await prisma.userProgram.create({
      data: { user_id: 1, pgm_id: p.pgm_id, is_default: p.pgm_id === 2, ins_by: 'SEED' },
    });
  }
  for (const loc of LOCATIONS) {
    await prisma.userLocation.create({
      data: { user_id: 1, loc_id: loc.loc_id, is_default: loc.loc_id === 41, ins_by: 'SEED' },
    });
  }
  // Other users get ACTS + first 10 ACTS locations
  const actsLocs = LOCATIONS.filter(l => l.programs.includes(2)).slice(0, 10);
  for (const uid of [2, 3, 4, 5]) {
    await prisma.userProgram.create({
      data: { user_id: uid, pgm_id: 2, is_default: true, ins_by: 'SEED' },
    });
    for (const loc of actsLocs) {
      await prisma.userLocation.create({
        data: { user_id: uid, loc_id: loc.loc_id, is_default: loc === actsLocs[0], ins_by: 'SEED' },
      });
    }
  }

  // ---- PARTS ----
  console.log('  Creating parts...');
  for (const p of PARTS) {
    await prisma.partList.create({
      data: {
        partno_id: p.partno_id, partno: p.partno, pgm_id: p.pgm_id, noun: p.noun,
        unit_price: randInt(500, 50000), sn_tracked: true, ins_by: 'SEED',
      },
    });
  }
  const maxPartId = Math.max(...PARTS.map(p => p.partno_id)) + 1;
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "part_list_partno_id_seq" RESTART WITH ${maxPartId}`);

  // ---- ASSETS + CASCADING DATA ----
  console.log('  Creating assets and maintenance data...');
  let assetId = 0;
  let eventId = 0;
  let repairId = 0;
  let laborId = 0;
  let meterId = 0;
  let sortieId = 0;
  let inspectionId = 0;
  let totalAssets = 0;

  // Batch arrays for bulk insert
  const allAssets: any[] = [];
  const allEvents: any[] = [];
  const allRepairs: any[] = [];
  const allLabors: any[] = [];
  const allMeters: any[] = [];
  const allSorties: any[] = [];
  const allInspections: any[] = [];

  // For each location, create 15 assets for the FIRST program assigned
  for (const loc of LOCATIONS) {
    const pgmId = loc.programs[0];
    const pgmParts = PARTS.filter(p => p.pgm_id === pgmId);
    const pgmCd = PROGRAMS.find(p => p.pgm_id === pgmId)!.pgm_cd;

    for (let i = 0; i < 15; i++) {
      assetId++;
      totalAssets++;
      const part = pgmParts[i % pgmParts.length];
      const status = pickStatus();
      const serno = `${pgmCd}-${String(loc.loc_id).padStart(4, '0')}-${String(i + 1).padStart(3, '0')}`;

      allAssets.push({
        asset_id: assetId,
        partno_id: part.partno_id,
        serno,
        status_cd: status,
        loc_ida: loc.loc_id,
        loc_idc: loc.loc_id,
        active: true,
        reportable: true,
        ins_by: 'SEED',
      });

      // 3 events per asset
      for (let e = 0; e < 3; e++) {
        eventId++;
        const evtDate = randDate(2025, 2026);
        const jobNo = `${evtDate.getFullYear()}${String(evtDate.getMonth() + 1).padStart(2, '0')}${String(evtDate.getDate()).padStart(2, '0')}${String(eventId % 1000).padStart(3, '0')}`;

        allEvents.push({
          event_id: eventId,
          asset_id: assetId,
          loc_id: loc.loc_id,
          job_no: jobNo,
          discrepancy: pick(DISCREPANCIES),
          start_job: evtDate,
          stop_job: new Date(evtDate.getTime() + randInt(1, 72) * 3600000),
          how_mal: pick(HOW_MALS),
          when_disc: pick(WHEN_DISCS),
          event_type: pick(EVENT_TYPES),
          source: 'RIMSS',
          ins_by: 'SEED',
        });

        // 1-2 repairs per event
        const numRepairs = e === 0 ? 2 : 1;
        for (let r = 0; r < numRepairs; r++) {
          repairId++;
          const repDate = new Date(evtDate.getTime() + randInt(0, 24) * 3600000);

          allRepairs.push({
            repair_id: repairId,
            event_id: eventId,
            repair_seq: r + 1,
            asset_id: assetId,
            start_date: repDate,
            stop_date: new Date(repDate.getTime() + randInt(1, 48) * 3600000),
            type_maint: pick(TYPE_MAINTS),
            how_mal: pick(HOW_MALS),
            when_disc: pick(WHEN_DISCS),
            narrative: pick(CORRECTIVE_ACTIONS),
            ins_by: 'SEED',
          });

          // 2-3 labors per repair
          const numLabors = randInt(2, 3);
          for (let l = 0; l < numLabors; l++) {
            laborId++;
            const labDate = new Date(repDate.getTime() + l * 3600000);

            allLabors.push({
              labor_id: laborId,
              repair_id: repairId,
              labor_seq: l + 1,
              asset_id: assetId,
              action_taken: pick(ACTIONS),
              how_mal: pick(HOW_MALS),
              when_disc: pick(WHEN_DISCS),
              type_maint: pick(TYPE_MAINTS),
              cat_labor: pick(CAT_LABORS),
              start_date: labDate,
              stop_date: new Date(labDate.getTime() + randInt(30, 480) * 60000),
              hours: Number((rand() * 8 + 0.5).toFixed(2)),
              crew_size: randInt(1, 3),
              corrective: pick(CORRECTIVE_ACTIONS),
              ins_by: 'SEED',
            });
          }
        }
      }

      // 2 sorties per asset
      for (let s = 0; s < 2; s++) {
        sortieId++;
        allSorties.push({
          sortie_id: sortieId,
          pgm_id: pgmId,
          asset_id: assetId,
          serno,
          sortie_date: randDate(2025, 2026),
          sortie_effect: pick(SORTIE_EFFECTS),
          source_data: 'SEED',
          ins_by: 'SEED',
        });
      }

      // 3-5 meter readings per asset
      const numMeters = randInt(3, 5);
      let meterVal = Number((rand() * 2000 + 100).toFixed(2));
      for (let m = 0; m < numMeters; m++) {
        meterId++;
        const delta = Number((rand() * 50 + 1).toFixed(2));
        allMeters.push({
          meter_id: meterId,
          asset_id: assetId,
          meter_type: 'ETI',
          meter_action: pick(METER_ACTIONS),
          meter_in: meterVal,
          meter_out: Number((meterVal + delta).toFixed(2)),
          ins_by: 'SEED',
        });
        meterVal = Number((meterVal + delta).toFixed(2));
      }

      // 1-2 inspections per asset (cycles through PMI types)
      const numInsp = (i % 3 === 0) ? 2 : 1;
      for (let ip = 0; ip < numInsp; ip++) {
        inspectionId++;
        const inspDate = randDate(2025, 2026);
        allInspections.push({
          hist_id: inspectionId,
          asset_id: assetId,
          pmi_type: PMI_TYPES[(inspectionId - 1) % PMI_TYPES.length],
          complete_date: inspDate,
          next_due_date: new Date(inspDate.getTime() + 90 * 24 * 3600000),
          completed_etm: Number((rand() * 3000 + 500).toFixed(2)),
          next_due_etm: Number((rand() * 3000 + 3500).toFixed(2)),
          job_no: `INS${String(inspectionId).padStart(6, '0')}`,
          completed_by: 'SEED',
          ins_by: 'SEED',
        });
      }
    }
  }

  // Bulk insert everything
  console.log(`  Inserting ${allAssets.length} assets...`);
  // Prisma createMany has a limit, batch in chunks of 500
  const BATCH = 500;
  for (let i = 0; i < allAssets.length; i += BATCH) {
    await prisma.asset.createMany({ data: allAssets.slice(i, i + BATCH) });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "asset_asset_id_seq" RESTART WITH ${assetId + 1}`);

  console.log(`  Inserting ${allEvents.length} events...`);
  for (let i = 0; i < allEvents.length; i += BATCH) {
    await prisma.event.createMany({ data: allEvents.slice(i, i + BATCH) });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "event_event_id_seq" RESTART WITH ${eventId + 1}`);

  console.log(`  Inserting ${allRepairs.length} repairs...`);
  for (let i = 0; i < allRepairs.length; i += BATCH) {
    await prisma.repair.createMany({ data: allRepairs.slice(i, i + BATCH) });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "repair_repair_id_seq" RESTART WITH ${repairId + 1}`);

  console.log(`  Inserting ${allLabors.length} labors...`);
  for (let i = 0; i < allLabors.length; i += BATCH) {
    await prisma.labor.createMany({ data: allLabors.slice(i, i + BATCH) });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "labor_labor_id_seq" RESTART WITH ${laborId + 1}`);

  console.log(`  Inserting ${allSorties.length} sorties...`);
  for (let i = 0; i < allSorties.length; i += BATCH) {
    await prisma.sortie.createMany({ data: allSorties.slice(i, i + BATCH) });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "sorties_sortie_id_seq" RESTART WITH ${sortieId + 1}`);

  console.log(`  Inserting ${allMeters.length} meter records...`);
  for (let i = 0; i < allMeters.length; i += BATCH) {
    await prisma.meterHist.createMany({ data: allMeters.slice(i, i + BATCH) });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "meter_hist_meter_id_seq" RESTART WITH ${meterId + 1}`);

  console.log(`  Inserting ${allInspections.length} inspections...`);
  for (let i = 0; i < allInspections.length; i += BATCH) {
    await prisma.assetInspection.createMany({ data: allInspections.slice(i, i + BATCH) });
  }
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "asset_inspection_hist_id_seq" RESTART WITH ${inspectionId + 1}`);

  // ---- LOC_SET ----
  console.log('  Creating location sets...');
  const locSetData: { set_name: string; pgm_id: number; loc_id: number; display_name: string }[] = [];
  for (const loc of LOCATIONS) {
    for (const pgmId of loc.programs) {
      const pgmCd = PROGRAMS.find(p => p.pgm_id === pgmId)!.pgm_cd;
      locSetData.push({
        set_name: `${pgmCd}_LOC`,
        pgm_id: pgmId,
        loc_id: loc.loc_id,
        display_name: loc.display_name,
      });
      locSetData.push({
        set_name: `${pgmCd}_SPARE_LOCATIONS`,
        pgm_id: pgmId,
        loc_id: loc.loc_id,
        display_name: loc.display_name,
      });
    }
  }
  await prisma.locSet.createMany({ data: locSetData.map(d => ({ ...d, ins_by: 'SEED' })) });

  // ---- SPARES ----
  console.log('  Creating spares...');
  const sparesData: any[] = [];
  const SPARE_STATUSES = ['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'REPAIR', 'NMC', 'INSPECTION', 'ISSUED'];
  let spareId = 0;
  for (const p of PARTS.slice(0, 20)) { // First 20 parts get spares
    for (let s = 0; s < 5; s++) {
      spareId++;
      sparesData.push({
        pgm_id: p.pgm_id,
        partno: p.partno,
        serno: `SPR${String(spareId).padStart(6, '0')}`,
        status: pick(SPARE_STATUSES),
        loc_id: SPARES_LOC.loc_id,
        unit_price: randInt(500, 25000),
        ins_by: 'SEED',
      });
    }
  }
  await prisma.spare.createMany({ data: sparesData });

  // ---- ADM_VARIABLE ----
  console.log('  Creating admin variables...');
  await prisma.admVariable.createMany({
    data: [
      { var_name: 'SYSTEM_VERSION', var_value: '2.0.0', var_desc: 'RIMSS system version', ins_by: 'SEED' },
      { var_name: 'MAX_SESSION_MINUTES', var_value: '480', var_desc: 'Session timeout in minutes', ins_by: 'SEED' },
      { var_name: 'ENVIRONMENT', var_value: 'DEVELOPMENT', var_desc: 'Current environment', ins_by: 'SEED' },
    ],
  });

  // ---- SUMMARY ----
  console.log('\n✅ Seed complete!\n');
  console.log(`  Programs:       ${PROGRAMS.length}`);
  console.log(`  Locations:      ${LOCATIONS.length + 1}`);
  console.log(`  Parts:          ${PARTS.length}`);
  console.log(`  Assets:         ${totalAssets}`);
  console.log(`  Events:         ${allEvents.length}`);
  console.log(`  Repairs:        ${allRepairs.length}`);
  console.log(`  Labors:         ${allLabors.length}`);
  console.log(`  Sorties:        ${allSorties.length}`);
  console.log(`  Meter Records:  ${allMeters.length}`);
  console.log(`  Inspections:    ${allInspections.length}`);
  console.log(`  Spares:         ${sparesData.length}`);
  console.log(`  Users:          ${users.length}`);
  console.log(`  Codes:          ${CODES.length}`);
  console.log(`  Location Sets:  ${locSetData.length}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('❌ Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
