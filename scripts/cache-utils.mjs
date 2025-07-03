#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import yaml from 'js-yaml';
import path from 'path';

// Cache configuration
const CACHE_DIR = '.cache';
const CACHE_FILE = path.join(CACHE_DIR, 'generation-cache.yaml');
const CACHE_VERSION = '1.0.0';

/**
 * Initialize cache directory and files
 */
export function initializeCache() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`📁 Created cache directory: ${CACHE_DIR}`);
  }
}

/**
 * Get git blob hash for a file
 * @param {string} filePath - Path to the file
 * @returns {string} Git blob hash
 */
export function getGitFileHash(filePath) {
  try {
    const hash = execSync(`git hash-object "${filePath}"`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return hash;
  } catch (error) {
    console.warn(`⚠️  Could not get git hash for ${filePath}: ${error.message}`);
    // Fallback to content hash if git fails
    return getContentHash(filePath);
  }
}

/**
 * Get content hash for a file (fallback when git unavailable)
 * @param {string} filePath - Path to the file
 * @returns {string} SHA-256 hash of file content
 */
export function getContentHash(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  } catch (error) {
    console.warn(`⚠️  Could not read file ${filePath}: ${error.message}`);
    return '';
  }
}

/**
 * Get hash for dependencies (logo, prompts, etc.)
 * @param {Array<string>} dependencyPaths - Array of dependency file paths
 * @param {string} additionalData - Additional data to include in hash (e.g., prompts)
 * @returns {string} Combined hash of all dependencies
 */
export function getDependenciesHash(dependencyPaths = [], additionalData = '') {
  const hasher = createHash('sha256');
  
  // Hash each dependency file
  for (const depPath of dependencyPaths) {
    if (existsSync(depPath)) {
      const content = readFileSync(depPath);
      hasher.update(content);
    }
  }
  
  // Add additional data (prompts, script version, etc.)
  if (additionalData) {
    hasher.update(additionalData);
  }
  
  return hasher.digest('hex');
}

/**
 * Load cache from YAML file
 * @returns {Object} Cache object
 */
export function loadCache() {
  try {
    if (!existsSync(CACHE_FILE)) {
      return createEmptyCache();
    }
    
    const cacheContent = readFileSync(CACHE_FILE, 'utf8');
    const cache = yaml.load(cacheContent) || createEmptyCache();
    
    // Ensure cache has proper structure
    if (!cache.cacheVersion) {
      console.log('🔄 Upgrading cache structure...');
      return createEmptyCache();
    }
    
    return cache;
  } catch (error) {
    console.warn(`⚠️  Error loading cache: ${error.message}`);
    return createEmptyCache();
  }
}

/**
 * Save cache to YAML file
 * @param {Object} cache - Cache object to save
 */
export function saveCache(cache) {
  try {
    initializeCache();
    
    // Update cache metadata
    cache.cacheVersion = CACHE_VERSION;
    cache.lastUpdated = new Date().toISOString();
    
    const yamlContent = yaml.dump(cache, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: true
    });
    
    writeFileSync(CACHE_FILE, yamlContent, 'utf8');
  } catch (error) {
    console.error(`❌ Error saving cache: ${error.message}`);
  }
}

/**
 * Create empty cache structure
 * @returns {Object} Empty cache object
 */
function createEmptyCache() {
  return {
    cacheVersion: CACHE_VERSION,
    lastUpdated: new Date().toISOString(),
    ogImages: {},
    translations: {},
    stats: {
      totalFiles: 0,
      cacheHits: 0,
      cacheMisses: 0
    }
  };
}

/**
 * Check if a file needs regeneration based on cache
 * @param {string} filePath - Source file path
 * @param {string} type - Cache type ('ogImages' or 'translations')
 * @param {string} dependenciesHash - Hash of dependencies
 * @returns {boolean} True if file needs regeneration
 */
export function shouldRegenerate(filePath, type, dependenciesHash = '') {
  const cache = loadCache();
  const fileCache = cache[type]?.[filePath];
  
  if (!fileCache) {
    // File not in cache, needs generation
    cache.stats.cacheMisses++;
    return true;
  }
  
  const currentContentHash = getGitFileHash(filePath);
  
  // Check if content changed
  if (fileCache.contentHash !== currentContentHash) {
    cache.stats.cacheMisses++;
    return true;
  }
  
  // Check if dependencies changed
  if (dependenciesHash && fileCache.dependenciesHash !== dependenciesHash) {
    cache.stats.cacheMisses++;
    return true;
  }
  
  // Check if outputs still exist
  if (fileCache.outputs) {
    const outputsExist = fileCache.outputs.every(outputPath => existsSync(outputPath));
    if (!outputsExist) {
      cache.stats.cacheMisses++;
      return true;
    }
  }
  
  // Cache hit!
  cache.stats.cacheHits++;
  return false;
}

/**
 * Update cache entry for a file
 * @param {string} filePath - Source file path
 * @param {string} type - Cache type ('ogImages' or 'translations')
 * @param {Array<string>} outputs - Generated output files
 * @param {string} dependenciesHash - Hash of dependencies
 */
export function updateCacheEntry(filePath, type, outputs = [], dependenciesHash = '') {
  const cache = loadCache();
  
  // Ensure the cache type exists
  if (!cache[type]) {
    cache[type] = {};
  }
  
  // Update file entry
  cache[type][filePath] = {
    contentHash: getGitFileHash(filePath),
    dependenciesHash: dependenciesHash,
    lastGenerated: new Date().toISOString(),
    outputs: outputs
  };
  
  // Update stats
  cache.stats.totalFiles = Object.keys(cache.ogImages).length + Object.keys(cache.translations).length;
  
  saveCache(cache);
}

/**
 * Add a single translation pair to existing cache entry
 * @param {string} filePath - Source file path
 * @param {string} targetFilePath - Target translation file path
 * @param {string} dependenciesHash - Hash of dependencies
 */
export function addTranslationToCache(filePath, targetFilePath, dependenciesHash = '') {
  const cache = loadCache();
  
  // Ensure translations cache exists
  if (!cache.translations) {
    cache.translations = {};
  }
  
  // Get or create cache entry for this file
  if (!cache.translations[filePath]) {
    cache.translations[filePath] = {
      contentHash: getGitFileHash(filePath),
      dependenciesHash: dependenciesHash,
      lastGenerated: new Date().toISOString(),
      outputs: []
    };
  }
  
  // Add target file to outputs if not already present
  if (!cache.translations[filePath].outputs.includes(targetFilePath)) {
    cache.translations[filePath].outputs.push(targetFilePath);
  }
  
  // Update timestamp and dependencies hash
  cache.translations[filePath].lastGenerated = new Date().toISOString();
  cache.translations[filePath].dependenciesHash = dependenciesHash;
  
  // Update stats
  cache.stats.totalFiles = Object.keys(cache.ogImages).length + Object.keys(cache.translations).length;
  
  saveCache(cache);
}

/**
 * Clean cache (remove all entries)
 */
export function cleanCache() {
  const emptyCache = createEmptyCache();
  saveCache(emptyCache);
  console.log('🧹 Cache cleared successfully');
}

/**
 * Display cache statistics
 */
export function displayCacheStats() {
  const cache = loadCache();
  const stats = cache.stats || {};
  
  console.log('\n📊 Cache Statistics:');
  console.log(`   Cache Version: ${cache.cacheVersion}`);
  console.log(`   Last Updated: ${cache.lastUpdated}`);
  console.log(`   Total Cached Files: ${stats.totalFiles || 0}`);
  console.log(`   OG Images: ${Object.keys(cache.ogImages || {}).length}`);
  console.log(`   Translations: ${Object.keys(cache.translations || {}).length}`);
  
  if (stats.cacheHits || stats.cacheMisses) {
    const total = stats.cacheHits + stats.cacheMisses;
    const hitRate = ((stats.cacheHits / total) * 100).toFixed(1);
    console.log(`   Cache Hit Rate: ${hitRate}% (${stats.cacheHits}/${total})`);
  }
  
  console.log('');
}

/**
 * Remove stale cache entries (files that no longer exist)
 */
export function cleanStaleEntries() {
  const cache = loadCache();
  let removedCount = 0;
  
  // Check OG images cache
  for (const filePath of Object.keys(cache.ogImages || {})) {
    if (!existsSync(filePath)) {
      delete cache.ogImages[filePath];
      removedCount++;
    }
  }
  
  // Check translations cache
  for (const filePath of Object.keys(cache.translations || {})) {
    if (!existsSync(filePath)) {
      delete cache.translations[filePath];
      removedCount++;
    }
  }
  
  if (removedCount > 0) {
    saveCache(cache);
    console.log(`🧹 Removed ${removedCount} stale cache entries`);
  }
  
  return removedCount;
}