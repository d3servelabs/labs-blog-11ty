# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Eleventy-based internationalized blog website supporting multiple languages. The project uses Eleventy's I18n plugin for internationalization and is deployed to Netlify with language-based redirects.

## Development Commands

### Start development server
```bash
npm start
```
Starts development server on `http://localhost:8080` with live reload. Note: Redirects only work on the server, so manually navigate to language-specific URLs like `http://localhost:8080/en/`. Uses `--pathprefix=/r/` for correct asset paths.

### Build for production
```bash
npm run build
```
Builds the site to the `dist/` directory.

### Generate OG images
```bash
npm run gen:og
```
Generates Open Graph images for all blog posts using Puppeteer. Creates PNG and JPG versions in the `public/og/` directory with language-specific font support and RTL layout for Arabic/Hebrew languages.

#### OG Image Cache Options
- `--no-cache`: Bypass cache and regenerate all images
- `--clean-cache`: Clean the cache and exit
- `--cache-stats`: Display cache statistics and exit

### Batch Translation
```bash
npm run translate
```
Translates content between languages using Gemini 2.5 Pro. Supports all content types (blog, tld, glossary, partners) with intelligent caching.

#### Translation Cache Options
- `--no-cache`: Bypass cache and regenerate all translations
- `--clean-cache`: Clean the translation cache and exit  
- `--cache-stats`: Display cache statistics and exit

## Architecture

### Internationalization Structure
- **Language Support**: English (en), German (de), Spanish (es), Chinese (zh), Arabic (ar), French (fr), Hindi (hi)
- **Default Language**: English with fallback behavior enabled
- **Language Detection**: Netlify handles browser language detection and redirects via `netlify.toml`
- **Content Structure**: Each language has its own directory in `src/` (e.g., `src/en/`, `src/de/`)

### Key Files and Directories
- `.eleventy.js`: Main Eleventy configuration with I18n plugin setup, path prefix `/r/`, and collections for all content types
- `src/_data/`: Global data files including language strings, navigation, metadata, and universal OG image configuration
- `src/_includes/`: Nunjucks templates (base.njk, header.njk, footer.njk)
- `src/{lang}/`: Language-specific content directories
- `src/{lang}/{lang}.11tydata.js`: Language-specific data files that set the `lang` property
- `src/_data/ogImage.js`: Universal OG image configuration for all content types
- `scripts/prebuild-og-images.mjs`: Puppeteer script for generating multilingual OG images
- `scripts/translate.mjs`: Batch translation script using Gemini 2.5 Pro
- `scripts/cache-utils.mjs`: Cache utilities for intelligent file change detection
- `.cache/generation-cache.yaml`: YAML-based cache storage for tracking file changes
- `public/`: Static assets directory that gets copied to output root

### Intelligent Caching System
The project uses a Git-based caching system to avoid unnecessary regeneration of OG images and translations:

#### Cache Features
- **Git Hash Tracking**: Uses `git hash-object` to detect file content changes with high precision
- **Dependency Tracking**: Monitors logo files, translation prompts, and script versions for cache invalidation
- **YAML Storage**: Human-readable cache file in `.cache/generation-cache.yaml`
- **Performance Metrics**: Built-in timing for individual files and total processing time
- **Cache Management**: Commands to view stats, clean cache, or bypass cache entirely

#### Cache Behavior
- **OG Images**: Regenerated only when source markdown content, logo files, or script version changes
- **Translations**: Regenerated when source content, translation prompts, or Gemini model version changes
- **Fallback**: Automatically falls back to content hashing if Git is unavailable
- **Stale Cleanup**: Automatically removes cache entries for deleted files

### Data Architecture
- **Language Data**: `src/_data/languages.js` contains localized strings and RTL direction settings
- **Navigation**: `src/_data/navigation.js` defines language-specific menu structures  
- **Metadata**: `src/_data/meta.js` provides site-wide configuration
- **Language Configuration**: Each language directory has an `{lang}.11tydata.js` file that sets the language code and computes page keys
- **OG Image Configuration**: `src/_data/ogImage.js` provides universal Open Graph image path generation for all content types

### Template System
- **Base Template**: Uses Nunjucks with `base.njk` as the main layout
- **Inline Styles**: The base template includes Bahunya CSS framework styles inline for performance
- **Language Direction**: Supports both LTR and RTL languages (Arabic uses RTL)
- **SEO**: Includes proper hreflang tags, canonical URLs, and Open Graph metadata

### Deployment
- **Platform**: Netlify
- **Build Command**: `npm run build`
- **Output Directory**: `dist/`
- **Redirects**: Language-based redirects configured in `netlify.toml` with 404 handling per language

## Content Structure

### Content Types
The site organizes content into four main types, each with its own directory structure:

#### Blog Posts
- Located in `src/{lang}/blog/` directories
- Each blog post is a Markdown file with front matter
- Collections: `blog_en`, `blog_ar`, `blog_de`, `blog_es`, `blog_fr`, `blog_hi`, `blog_zh`

#### TLD (Top-Level Domain) Content
- Located in `src/{lang}/tld/` directories
- Information about specific domain extensions (.com, .org, .eth, etc.)
- Collections: `tld_en`, `tld_ar`, `tld_de`, `tld_es`, `tld_fr`, `tld_hi`, `tld_zh`

#### Glossary Terms
- Located in `src/{lang}/glossary/` directories
- Domain and Web3 terminology definitions
- Collections: `glossary_en`, `glossary_ar`, `glossary_de`, `glossary_es`, `glossary_fr`, `glossary_hi`, `glossary_zh`

#### Partners
- Located in `src/{lang}/partners/` directories
- Information about business partners and integrations
- Collections: `partners_en`, `partners_ar`, `partners_de`, `partners_es`, `partners_fr`, `partners_hi`, `partners_zh`

### Image Generation
- OG images are automatically generated for all content types (blog, tld, glossary, partners)
- Support for RTL languages (Arabic, Hebrew, Persian) with appropriate fonts
- Images generated in both PNG and JPG formats with paths matching content structure
- Concurrent processing with configurable limits for performance
- Universal path generation via `src/_data/ogImage.js` works for all content types

## Brand Guidelines

### Brand Name
- **Namefi**: Always spelled as "Namefi" (not "NameFi" or other variations)
- This is the correct branding for the domain tokenization platform
- All content, translations, and documentation must maintain this exact spelling