// Configuration constants for translation system

// Supported languages and content types
export const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'zh', 'ar', 'fr', 'hi'];
export const CONTENT_TYPES = ['blog', 'tld', 'glossary', 'partners'];

// Script version for cache invalidation
export const SCRIPT_VERSION = '3.2.0';

// Model context limits (tokens)
export const MODEL_LIMITS = {
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-pro': 2000000,
  'gpt-4o-mini': 128000,
  'gpt-4o': 128000
};

// Content type token estimates (conservative)
export const CONTENT_TYPE_TOKENS = {
  'glossary': 300,
  'tld': 800,
  'partners': 600,
  'blog': 3000,
  'general': 1500
};

// Language names for AI model prompts
export const LANGUAGE_NAMES = {
  'en': 'English',
  'de': 'German',
  'es': 'Spanish', 
  'zh': 'Chinese',
  'ar': 'Arabic',
  'fr': 'French',
  'hi': 'Hindi'
};