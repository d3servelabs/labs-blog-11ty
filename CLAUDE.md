# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Eleventy-based internationalized blog website supporting multiple languages. The project uses Eleventy's I18n plugin for internationalization and is deployed to Netlify with language-based redirects.

## Development Commands

### Start development server
```bash
npm start
```
Starts development server on `http://localhost:8080` with live reload. Note: Redirects only work on the server, so manually navigate to language-specific URLs like `http://localhost:8080/en/`.

### Build for production
```bash
npm run build
```
Builds the site to the `dist/` directory.

## Architecture

### Internationalization Structure
- **Language Support**: English (en), German (de), Spanish (es), Chinese (zh), Arabic (ar), French (fr), Hindi (hi)
- **Default Language**: English with fallback behavior enabled
- **Language Detection**: Netlify handles browser language detection and redirects via `netlify.toml`
- **Content Structure**: Each language has its own directory in `src/` (e.g., `src/en/`, `src/de/`)

### Key Files and Directories
- `.eleventy.js`: Main Eleventy configuration with I18n plugin setup
- `src/_data/`: Global data files including language strings, navigation, and metadata
- `src/_includes/`: Nunjucks templates (base.njk, header.njk, footer.njk)
- `src/{lang}/`: Language-specific content directories
- `src/{lang}/{lang}.11tydata.js`: Language-specific data files that set the `lang` property

### Data Architecture
- **Language Data**: `src/_data/languages.js` contains localized strings and RTL direction settings
- **Navigation**: `src/_data/navigation.js` defines language-specific menu structures  
- **Metadata**: `src/_data/meta.js` provides site-wide configuration
- **Language Configuration**: Each language directory has an `{lang}.11tydata.js` file that sets the language code and computes page keys

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